import type { EngineInterface, Register } from 'claude-code'

export const SERVER = 'mcp__kanban-delm-swarm__'
// A tool call is one $.process.run; a waiting read holds it for up to 25 s.
const WAIT_CAP_SECONDS = 25
const RUNTIME_FIELDS = ['dir', 'tasksDir', 'base', 'actor', 'cwd']

type Worker = { name: string; sessionId?: string }
type Registry = { listId: string; base?: string; state?: string; workers?: Worker[] }
export type Swarm = { listId: string; dir: string; tasksDir: string; registry: Registry }

const files = { type: 'array', items: { type: 'string' }, description: 'Paths relative to your workspace' }
const requestId = { type: 'string', description: 'Any unique text; resending with the same one is safe' }
const work = {
  type: 'object',
  properties: { subject: { type: 'string' }, detail: { type: 'string' } },
  required: ['subject', 'detail'],
}
const entry = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Task id or entry id' },
    paths: { type: 'array', items: { type: 'string' } },
  },
  required: ['id'],
}

export const TOOLS: { name: string; command: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'swarm_read',
    command: 'read',
    description:
      'Read the shared swarm board: the open, claimed and done tasks, the notes, and what peers are doing. Shows what changed since your last read; unchanged tasks come short. Pass wait (seconds, at most 25) to block until a peer adds a task, a note or a result.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Show every task and note in full' },
        wait: { type: 'number', description: `Seconds to wait for a peer update, at most ${WAIT_CAP_SECONDS}` },
        target: { type: 'string', description: 'Task id or entry id to wait for' },
      },
    },
  },
  {
    name: 'swarm_add',
    command: 'add',
    description:
      'Add open tasks to the shared queue for any worker to claim. A subject that matches an existing task (case and spaces ignored) keeps that task.',
    inputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: work } },
      required: ['items'],
    },
  },
  {
    name: 'swarm_claim',
    command: 'claim',
    description:
      'Claim an open task by id. The first claim wins: won=false names the owner, so pick another task. You hold one task at a time.',
    inputSchema: { type: 'object', properties: { item: { type: 'number', description: 'Task id' } }, required: ['item'] },
  },
  {
    name: 'swarm_reserve',
    command: 'reserve',
    description: 'Create a task and claim it in one step, for work you found and are about to do yourself.',
    inputSchema: work,
  },
  {
    name: 'swarm_done',
    command: 'done',
    description:
      'Complete the task you hold with a short summary. Attach the files you changed, so peers can see the diff and apply them.',
    inputSchema: {
      type: 'object',
      properties: { item: { type: 'number', description: 'Task id' }, summary: { type: 'string' }, files, requestId },
      required: ['item', 'summary'],
    },
  },
  {
    name: 'swarm_note',
    command: 'note',
    description:
      'Share a finding with every worker: FACT for something you verified, FAIL for an approach that did not work. Name the scope it applies to and the basis (the test, command or source).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['FACT', 'FAIL'] },
        text: { type: 'string' },
        scope: { type: 'string' },
        basis: { type: 'string' },
        files,
        requestId,
      },
      required: ['type', 'text', 'scope', 'basis'],
    },
  },
  {
    name: 'swarm_expand',
    command: 'expand',
    description: "Show the files a peer attached to a done or a note, as diffs against the original, or named files in full.",
    inputSchema: entry,
  },
  {
    name: 'swarm_apply',
    command: 'apply',
    description:
      "Copy a peer's attached files into your workspace. Refused as a whole when one of them would overwrite your own edits.",
    inputSchema: entry,
  },
]

export const configDir = (configDir?: string, home?: string, userProfile?: string) =>
  (configDir || `${home ?? userProfile}/.claude`).replaceAll('\\', '/')

let found: Promise<Swarm | undefined> | undefined

// A session is a worker only when its task list has a registry that /swarm start wrote and has not ended.
// The list name alone turns nothing on.
export function swarm($: EngineInterface) {
  found ??= (async () => {
    const listId = await $.env.get('CLAUDE_CODE_TASK_LIST_ID')
    if (!listId) return undefined
    const config = configDir(
      await $.env.get('CLAUDE_CONFIG_DIR'),
      await $.env.get('HOME'),
      await $.env.get('USERPROFILE'),
    )
    const dir = `${config}/.cck/swarm/${listId}`
    const registry = await readRegistry($, dir)
    if (!registry || registry.state === 'ended') return undefined
    return { listId, dir, tasksDir: `${config}/tasks/${listId}`, registry }
  })()
  return found
}

async function readRegistry($: EngineInterface, dir: string): Promise<Registry | undefined> {
  try {
    return JSON.parse(await $.fs.read(`${dir}/swarm.json`)) as Registry
  } catch {
    return undefined
  }
}

async function running($: EngineInterface) {
  const s = await swarm($)
  return !!s && ((await readRegistry($, s.dir)) ?? s.registry).state !== 'ended'
}

// $.plugin.root names the folder that holds plugin.json, which is .claude-plugin/.
export const storePath = (root: string) => `${root.replaceAll('\\', '/').replace(/\/\.claude-plugin\/?$/, '')}/scripts/store.mjs`

async function run($: EngineInterface, s: Swarm, command: string, input: Record<string, unknown>) {
  // Read again on each call: /swarm start adds a worker's session id after the dispatch returns.
  const registry = (await readRegistry($, s.dir)) ?? s.registry
  if (registry.state === 'ended') return { deny: 'This swarm has ended.' }
  const id = await $.session.id()
  const name = registry.workers?.find(w => w.sessionId === id)?.name
  const { tool: _tool, tool_use_id: _id, ...args } = input
  const owned = RUNTIME_FIELDS.filter(f => f in args)
  if (owned.length) return { deny: `${owned.join(', ')} ${owned.length > 1 ? 'are' : 'is'} set by the swarm, not by the call.` }
  const request = {
    ...args,
    dir: s.dir,
    tasksDir: s.tasksDir,
    base: registry.base,
    actor: { id, ...(name ? { name } : {}) },
    cwd: await $.session.cwd(),
  }
  const waiting = command === 'read' && Number(args.wait) > 0
  const r = await $.process.run(['node', storePath($.plugin.root), command], {
    stdin: JSON.stringify(request),
    timeoutMs: waiting ? (WAIT_CAP_SECONDS + 4) * 1000 : 15_000,
  })
  let out: { ok?: boolean; error?: string } | undefined
  try {
    out = JSON.parse(r.stdout)
  } catch {}
  if (!out) return { deny: `The swarm store failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 500)}` }
  if (!out.ok) return { deny: out.error ?? 'The swarm store refused the call.' }
  const { ok: _ok, ...result } = out
  return { result: JSON.stringify(result) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (await swarm($)) {
      for (const { name, description, inputSchema } of TOOLS) await $.tool.register({ name, description, inputSchema })
    }
    return next(e)
  })

  for (const { name, command } of TOOLS) {
    on('tool.describe', { tool: `${SERVER}${name}` }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
    on('tool.call', { tool: `${SERVER}${name}` }, async ($, e) => {
      const s = await swarm($)
      if (!s) return { deny: 'This session is not a swarm worker.' }
      return run($, s, command, e as unknown as Record<string, unknown>)
    })
  }

  // The store owns the task files of the swarm's list; a direct write would fork the board from the log.
  const DENY = "The swarm's tasks change only through the swarm tools: swarm_add, swarm_claim, swarm_done."
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => ((await running($)) ? { deny: DENY } : next(e)))
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => ((await running($)) ? { deny: DENY } : next(e)))
}

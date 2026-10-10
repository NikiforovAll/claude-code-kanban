import type { EngineInterface, Register } from 'claude-code'

export const SERVER = 'mcp__kanban-delm-swarm__'
// A tool call is one $.process.run; a waiting status call holds it for up to 25 s.
const WAIT_CAP_SECONDS = 25
const RUNTIME_FIELDS = ['dir', 'tasksDir', 'base', 'parent', 'roster', 'actor', 'cwd']
const STATUS_FIELDS = ['state', 'summary', 'dependency', 'finding']

type Worker = { name: string; sessionId?: string }
type Registry = { listId: string; base?: string; parent?: string; state?: string; workers?: Worker[] }
export type Swarm = { listId: string; dir: string; tasksDir: string; registry: Registry }

const paths = (description: string) => ({ type: 'array', items: { type: 'string' }, description })
const key = {
  type: 'string',
  maxLength: 128,
  description: 'Unique text for this change. Resending the same call with the same key is safe; a new change needs a new key.',
}

// The same limits as TASK_FIELDS in scripts/store.mjs, from DeLM's tool definitions.
const LIMITS = { title: 256, description: 2048, interface: 2048, earliest_contribution: 1024, done_when: 1024 }
const bounded = (limit: number, required: boolean) => ({
  type: 'string',
  minLength: required ? 1 : 0,
  maxLength: limit,
  description: `At most ${limit} UTF-8 bytes. Keep this field concise; attach detailed content as a file.`,
})
const positive = { type: 'integer', minimum: 1 }
const dependencies = {
  type: 'array',
  maxItems: 128,
  items: positive,
  description:
    'Existing publication_id values returned by swarm_publish. These are shared contributions, not task IDs, task numbers, or future prerequisites. Omit until a contribution exists.',
}
const taskFields = {
  title: bounded(LIMITS.title, true),
  description: bounded(LIMITS.description, true),
  kind: { enum: ['implementation', 'verification', 'integration'] },
  interface: bounded(LIMITS.interface, false),
  dependencies,
  earliest_contribution: bounded(LIMITS.earliest_contribution, false),
  done_when: bounded(LIMITS.done_when, false),
}
const task = { type: 'object', properties: taskFields, required: ['title', 'description'], additionalProperties: false }
const LIMITS_TEXT = `UTF-8 byte limits: ${Object.entries(LIMITS)
  .map(([f, n]) => `${f} ${n}`)
  .join('; ')}. dependencies must be existing publication_id values, never task numbers.`

export const TOOLS: { name: string; command: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'swarm_status',
    command: 'status',
    description:
      'Read the compact board, or report your status. With no state, summary, dependency or finding it only reads. state is working, waiting or blocked; waiting requires a named dependency. finding shares a short free-text result for every worker: what you verified or ruled out, its scope and basis. Every response carries the board: the latest 24 tasks, publications and findings with totals; page older records with swarm_list. Pass wait (seconds, at most 25) to block until a peer adds a task, a publication or a finding after since.',
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: key,
        state: { enum: ['working', 'waiting', 'blocked'] },
        summary: bounded(2048, false),
        dependency: { ...bounded(512, true), description: 'What you wait for: task:<id> or worker:<name>. Not your own task or yourself.' },
        finding: bounded(4096, true),
        wait: { type: 'number', description: `Seconds to wait for a peer update, at most ${WAIT_CAP_SECONDS}` },
        since: { type: 'integer', minimum: 0, description: 'Board sequence to wait after; defaults to now' },
        target: { ...positive, description: 'Task id; the wait ends when that task is done' },
      },
    },
  },
  {
    name: 'swarm_list',
    command: 'list',
    description:
      'Page one board collection in id order: tasks, publications or findings. Pass next_cursor to continue; a cursor keeps the records that existed at the first page. Filter tasks by task_state and owner (self or peer).',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { enum: ['tasks', 'publications', 'findings'] },
        limit: { type: 'integer', minimum: 1, maximum: 24 },
        cursor: { type: 'string' },
        task_state: { enum: ['available', 'claimed', 'done'] },
        owner: { enum: ['self', 'peer'] },
      },
      required: ['collection'],
    },
  },
  {
    name: 'swarm_task_create',
    command: 'task_create',
    description: `Expose a useful independent contribution for any worker to claim. ${LIMITS_TEXT} Use integration for temporary ownership of assembling the shared result, or verification for a scoped check; one integration task may be claimed at a time.`,
    inputSchema: { type: 'object', properties: { idempotency_key: key, ...taskFields }, required: ['idempotency_key', 'title', 'description'] },
  },
  {
    name: 'swarm_task_claim',
    command: 'task_claim',
    description:
      'Atomically claim ready work. A task another worker holds is refused, so pick another. The returned version fences update, release, split and finish against stale ownership.',
    inputSchema: { type: 'object', properties: { idempotency_key: key, task_id: positive }, required: ['idempotency_key', 'task_id'] },
  },
  {
    name: 'swarm_task_update',
    command: 'task_update',
    description: `Update the boundary, interface or remaining work of your claimed task using its current version. ${LIMITS_TEXT}`,
    inputSchema: {
      type: 'object',
      properties: { idempotency_key: key, task_id: positive, expected_version: positive, ...taskFields },
      required: ['idempotency_key', 'task_id', 'expected_version'],
    },
  },
  {
    name: 'swarm_task_release',
    command: 'task_release',
    description:
      'Release your claim with a concise handoff. Publish partial files first with swarm_publish and name its publication_id as the checkpoint; a peer may then claim and continue.',
    inputSchema: {
      type: 'object',
      properties: { idempotency_key: key, task_id: positive, expected_version: positive, summary: bounded(2048, true), publication_id: positive },
      required: ['idempotency_key', 'task_id', 'expected_version', 'summary'],
    },
  },
  {
    name: 'swarm_task_split',
    command: 'task_split',
    description:
      'Keep a smaller remaining part of your claimed task and atomically expose 1 to 16 independent tasks to your peers. remaining and tasks use the task-create fields; remaining keeps the current task kind.',
    inputSchema: {
      type: 'object',
      properties: { idempotency_key: key, task_id: positive, expected_version: positive, remaining: task, tasks: { type: 'array', minItems: 1, maxItems: 16, items: task } },
      required: ['idempotency_key', 'task_id', 'expected_version', 'remaining', 'tasks'],
    },
  },
  {
    name: 'swarm_task_finish',
    command: 'task_finish',
    description:
      'Finish your claimed task using its current version, with a short summary. Publish the files first with swarm_publish; finishing does not publish.',
    inputSchema: {
      type: 'object',
      properties: { idempotency_key: key, task_id: positive, expected_version: positive, summary: bounded(2048, true) },
      required: ['idempotency_key', 'task_id', 'expected_version', 'summary'],
    },
  },
  {
    name: 'swarm_publish',
    command: 'publish',
    description:
      'Publish an immutable copy of the named files from your workspace, finished or partial, so peers can expand and apply them. A path missing from your workspace publishes its deletion; binary files and the executable bit are kept. paths may be empty to share only interfaces or unfinished work. At most 1024 files and 64 MiB; Git metadata and symlinks are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: key,
        summary: bounded(2048, true),
        paths: paths('Paths relative to your workspace'),
        dependencies,
        interfaces: bounded(8192, false),
        unfinished: bounded(8192, false),
      },
      required: ['idempotency_key', 'summary', 'paths'],
    },
  },
  {
    name: 'swarm_expand',
    command: 'expand',
    description:
      'Show one task, finding or publication in full. A publication shows its files as byte ranges: offset, and max_bytes (default 8192, at most 32768), at most 32 files and 64 KiB per call. Bytes that are not UTF-8 are not shown; apply imports the exact file.',
    inputSchema: {
      type: 'object',
      properties: {
        publication_id: positive,
        task_id: positive,
        finding_id: positive,
        paths: paths('Files of the publication to show; all when omitted'),
        offset: { type: 'integer', minimum: 0 },
        max_bytes: { type: 'integer', minimum: 1, maximum: 32768 },
      },
    },
  },
  {
    name: 'swarm_apply',
    command: 'apply',
    description:
      "Copy whole files of a peer's publication into your workspace, with deletions and the executable bit. Refused as a whole when a local file differs from its base and from every published version, so your unpublished edits are never overwritten.",
    inputSchema: {
      type: 'object',
      properties: { idempotency_key: key, publication_id: positive, paths: paths('Files to apply; all when omitted') },
      required: ['idempotency_key', 'publication_id'],
    },
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
    parent: registry.parent,
    roster: registry.workers,
    actor: { id, ...(name ? { name } : {}) },
    cwd: await $.session.cwd(),
  }
  // The same rule as `mutates` for status in scripts/store.mjs: only a read waits.
  const waiting = command === 'status' && Number(args.wait) > 0 && !STATUS_FIELDS.some(f => f in args)
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
  const DENY = "The swarm's tasks change only through the swarm tools: swarm_task_create, swarm_task_claim, swarm_task_finish."
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => ((await running($)) ? { deny: DENY } : next(e)))
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => ((await running($)) ? { deny: DENY } : next(e)))
}

import type { EngineInterface, Register } from 'claude-code'

export const SERVER = 'mcp__kanban-delm-swarm__'
const RUNTIME_FIELDS = ['dir', 'tasksDir', 'base', 'parent', 'roster', 'actor', 'cwd']
const ENDED = 'This swarm has ended.'
export const POLL_MS = 1500
// The session's own end: an exit, a logout, or a -p run that finished. /clear and resume go on.
const STOP_REASONS = ['prompt_input_exit', 'logout', 'other']

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
      'Read the compact board, or update your status. With no state, summary, dependency or finding it only reads. state is working, waiting or blocked; waiting names a concrete dependency: task:<id> or worker:<name>. A status is not your outcome: end each turn with swarm_complete. finding shares a short free-text result for every worker: what you verified or ruled out, its scope and basis. Every response carries the board: the latest 24 tasks, publications and findings with totals; page older records with swarm_list.',
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: key,
        state: { enum: ['working', 'waiting', 'blocked'] },
        summary: bounded(2048, false),
        dependency: { ...bounded(512, true), description: 'What you wait for: task:<id> or worker:<name>. Not your own task or yourself.' },
        finding: bounded(4096, true),
      },
    },
  },
  {
    name: 'swarm_complete',
    command: 'complete',
    description:
      'Declare your outcome for the whole goal with the current board request_revision as expected_revision, then end your turn. complete means the full result is ready: the supervisor checks it, and workers change nothing until it ends the swarm or sends a new request. partial resumes you to continue the unfinished requirement. waiting needs dependency task:<id> or worker:<name>, not your own work; the swarm resumes you when it is ready, new work becomes available, the request changes, or no one can produce it. Never sleep or poll to wait. blocked tells the supervisor the concrete input you need; it answers with a message or a new request. checks lists the checks you ran, each with its command and result. artifacts lists every requested generated output file or directory, relative to your workspace; use [] for source-only work.',
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: key,
        expected_revision: positive,
        outcome: { enum: ['complete', 'partial', 'blocked', 'waiting'] },
        summary: bounded(4096, true),
        dependency: { ...bounded(512, true), description: 'For waiting: task:<id> or worker:<name>. Not your own task or yourself.' },
        checks: { type: 'array', maxItems: 64, items: bounded(1024, true) },
        artifacts: paths('Generated outputs relative to your workspace'),
      },
      required: ['idempotency_key', 'expected_revision', 'outcome', 'summary'],
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
export const scriptPath = (root: string, file: string) => `${root.replaceAll('\\', '/').replace(/\/\.claude-plugin\/?$/, '')}/scripts/${file}`
export const storePath = (root: string) => scriptPath(root, 'store.mjs')

// DeLM's /delm-status and /delm-stop: they answer with no model turn and run while a turn streams.
export const COMMANDS = [
  { name: 'swarm-status', verb: 'board', description: 'Show the board of the swarm this session started', timeoutMs: 15_000 },
  { name: 'swarm-stop', verb: 'stop', description: 'Stop the workers of the swarm this session started and end it', timeoutMs: 60_000 },
]

type Reply = { ok?: boolean; error?: string; result?: { wake?: boolean; ended?: boolean; message?: string; changes?: number } }

async function store($: EngineInterface, s: Swarm, command: string, args: Record<string, unknown>): Promise<Reply> {
  // Read again on each call: /swarm start adds a worker's session id after the dispatch returns.
  const registry = (await readRegistry($, s.dir)) ?? s.registry
  if (registry.state === 'ended') return { ok: false, error: ENDED, result: { ended: true } }
  const id = await $.session.id()
  const name = registry.workers?.find(w => w.sessionId === id)?.name
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
  const r = await $.process.run(['node', storePath($.plugin.root), command], { stdin: JSON.stringify(request), timeoutMs: 15_000 })
  try {
    return JSON.parse(r.stdout) as Reply
  } catch {
    return { ok: false, error: `The swarm store failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 500)}` }
  }
}

async function run($: EngineInterface, s: Swarm, command: string, input: Record<string, unknown>) {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...args } = input
  const owned = RUNTIME_FIELDS.filter(f => f in args)
  if (owned.length) return { deny: `${owned.join(', ')} ${owned.length > 1 ? 'are' : 'is'} set by the swarm, not by the call.` }
  const { ok, error, ...result } = await store($, s, command, args)
  if (!ok) return { deny: error ?? 'The swarm store refused the call.' }
  return { result: JSON.stringify(result) }
}

// The worker wakes itself, as DeLM's controller resumes a waiting worker: the store reports each
// turn's start and end, and while the session is idle, each store change asks the store whether
// this worker should wake. The store counts its changes in CHANGES_FILE and answers the count with
// each turn and wake, so this worker's own writes ask nothing. One store call runs at a time, in
// the order the hooks raised them.
export const CHANGES_FILE = 'changes'
let idle = false
let woke = false
let seen = ''
let watching = false
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(fn: () => Promise<T>) => {
  const p = queue.then(fn)
  queue = p.catch(() => {})
  return p
}

const changes = ($: EngineInterface, dir: string) => $.fs.read(`${dir}/${CHANGES_FILE}`).then(String, () => '-')

// Answers true once the swarm has ended, so the watch stops.
function wakeIfDue($: EngineInterface, out: Reply) {
  if (out.result?.changes !== undefined) seen = String(out.result.changes)
  if (out.result?.wake) {
    idle = false
    woke = true
    void $.prompt.submit({ text: `Swarm: ${out.result.message}` }).catch(() => {})
  }
  return !!out.result?.ended
}

async function watch($: EngineInterface, s: Swarm) {
  for (;;) {
    await $.clock.sleep(POLL_MS)
    if (!idle) continue
    const now = await changes($, s.dir)
    if (now === seen) continue
    seen = now
    if (await serial(async () => idle && wakeIfDue($, await store($, s, 'wake', {})))) return
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const s = await swarm($)
    if (s) {
      for (const { name, description, inputSchema } of TOOLS) await $.tool.register({ name, description, inputSchema })
      // A -p worker ends with its turn, so only a session at a prompt watches.
      if (e.isInteractive && !watching) {
        watching = true
        void watch($, s).catch(() => {})
      }
    } else {
      await Promise.all(COMMANDS.map(({ name, description }) => $.command.register({ name, description, argumentHint: '[swarm id]', immediate: true })))
    }
    return next(e)
  })

  for (const { name, verb, timeoutMs } of COMMANDS) {
    on('command.run', { command: name }, async ($, e) => {
      const listId = e.args.trim()
      const argv = ['node', scriptPath($.plugin.root, 'supervisor.mjs'), verb, ...(listId ? [listId] : [])]
      try {
        const r = await $.process.run(argv, { env: { CLAUDE_CODE_SESSION_ID: await $.session.id() }, timeoutMs })
        return { text: (r.stdout || r.stderr).trim(), exitCode: r.exitCode }
      } catch (err) {
        return { text: `/${name} failed: ${(err as Error).message}`, exitCode: 1 }
      }
    })
  }

  on('turn.start', async ($, e, next) => {
    const s = await swarm($)
    if (s) {
      idle = false
      // A wake already marked this turn as running.
      if (woke) woke = false
      else void serial(() => store($, s, 'turn', { running: true }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const s = await swarm($)
    if (s && !e.agentId) {
      idle = true
      void serial(async () => wakeIfDue($, await store($, s, 'turn', { running: false, reason: e.reason })))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const s = await swarm($)
    if (s && STOP_REASONS.includes(e.reason)) {
      await serial(() => store($, s, 'worker_stop', { idempotency_key: `session-end-${e.sessionId}`, reason: `its session ended (${e.reason})` })).catch(() => {})
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

import type { On, ToolCallArgs } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { CHANGES_FILE, COMMANDS, configDir, POLL_MS, SERVER, storePath, TOOLS } from '../hooks/swarm'

const LIST = 'swarm-fix-login-3fa91c'
const DIR = `C:/cfg/.cck/swarm/${LIST}`
const REGISTRY = { listId: LIST, base: 'abc123', parent: 'sid-p', state: 'running', workers: [{ name: 'w1-3fa91c', sessionId: 'sid-1' }] }

type Run = { argv: readonly string[]; input: unknown; env?: Record<string, string>; timeoutMs?: number }

type Reply = string | ((command: string) => string)

function engine(on: On, env: Record<string, string>, registry: unknown = REGISTRY, reply: Reply = '{"ok":true,"won":true}') {
  const registered: string[] = []
  const runs: Run[] = []
  const prompts: string[] = []
  const files: Record<string, string> = registry ? { [`${DIR}/swarm.json`]: JSON.stringify(registry) } : {}
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('env.get', (_$, e) => ({ value: { CLAUDE_CONFIG_DIR: 'C:\\cfg', ...env }[e.name] }))
  on('fs.read', (_$, e) => {
    const text = files[e.path.replaceAll('\\', '/')]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.cwd', () => ({ value: 'C:/wt/w1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('tool.register', (_$, e) => {
    registered.push(e.name)
    return { value: { tool: `${SERVER}${e.name}` } }
  })
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, input: e.init?.stdin && JSON.parse(e.init.stdin), env: e.init?.env, timeoutMs: e.init?.timeoutMs })
    const stdout = typeof reply === 'string' ? reply : reply(String(e.argv.at(-1)))
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: 'updated' }))
  return { registered, runs, files, prompts, commands:() => runs.map(r => r.argv.at(-1)) }
}

const WORKER = { CLAUDE_CODE_TASK_LIST_ID: LIST }
const start = { cwd: 'C:/wt/w1', surface: null, isInteractive: false } as const
const call = (name: string, input: Record<string, unknown>) => ({ tool: `${SERVER}${name}`, ...input }) as ToolCallArgs

test('helpers: the config dir and the store path', async () => {
  expect(configDir(undefined, 'C:\\Users\\a', undefined)).toBe('C:/Users/a/.claude')
  expect(configDir('C:\\cfg')).toBe('C:/cfg')
  expect(storePath('C:\\p\\kanban-delm-swarm\\.claude-plugin')).toBe('C:/p/kanban-delm-swarm/scripts/store.mjs')
  expect(storePath('C:/p/kanban-delm-swarm')).toBe('C:/p/kanban-delm-swarm/scripts/store.mjs')
})

test('no task list: no tools, and TaskUpdate runs', async ($, on) => {
  const board = engine(on, {})
  await $.session.start(start)
  expect(board.registered).toEqual([])
  expect((await $.tool.call({ tool: 'TaskUpdate', taskId: '1' } as ToolCallArgs)).result).toBe('updated')
})

test('a session that is not a worker gets /swarm-status and /swarm-stop, which run the supervisor', async ($, on) => {
  const board = engine(on, {}, REGISTRY, 'No swarm is running in this session.\n')
  const commands: string[] = []
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  await $.session.start(start)
  expect(commands).toEqual(COMMANDS.map(c => c.name))
  expect((await $.command.run({ command: 'swarm-status', args: '' })).text).toBe('No swarm is running in this session.')
  await $.command.run({ command: 'swarm-stop', args: ` ${LIST} ` })
  expect(board.runs.map(r => r.argv.slice(2))).toEqual([['board'], ['stop', LIST]])
  expect(board.runs[0].argv[1]).toMatch(/scripts\/supervisor\.mjs$/)
  expect(board.runs[1].env).toEqual({ CLAUDE_CODE_SESSION_ID: 'sid-1' })
})

test('a worker gets no swarm commands', async ($, on) => {
  engine(on, WORKER)
  const commands: string[] = []
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  await $.session.start(start)
  expect(commands).toEqual([])
})

test('a task list with no registry turns nothing on, whatever its name', async ($, on) => {
  const board = engine(on, WORKER, null)
  await $.session.start(start)
  expect(board.registered).toEqual([])
  expect((await $.tool.call({ tool: 'TaskUpdate', taskId: '1' } as ToolCallArgs)).result).toBe('updated')
})

test('an ended swarm turns nothing on', async ($, on) => {
  const board = engine(on, WORKER, { ...REGISTRY, state: 'ended' })
  await $.session.start(start)
  expect(board.registered).toEqual([])
})

test('a worker gets every tool, and its task writes are denied', async ($, on) => {
  const board = engine(on, WORKER)
  await $.session.start(start)
  expect(board.registered).toEqual(TOOLS.map(t => t.name))
  const res = await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as ToolCallArgs)
  expect(res.deny).toContain('swarm_task_claim')
})

test('task tools explain size limits and reject task ids as publication dependencies', async () => {
  for (const name of ['swarm_task_create', 'swarm_task_update', 'swarm_task_split']) {
    const schema = TOOLS.find(t => t.name === name)!.inputSchema as any
    const fields = name === 'swarm_task_split' ? schema.properties.tasks.items.properties : schema.properties
    for (const [field, bound] of [['title', 256], ['description', 2048], ['interface', 2048], ['earliest_contribution', 1024], ['done_when', 1024]] as const) {
      expect(fields[field].maxLength).toBe(bound)
      expect(fields[field].description).toContain('UTF-8 bytes')
    }
    expect(fields.dependencies.description).toContain('not task IDs')
  }
  for (const t of TOOLS.filter(t => !['swarm_status', 'swarm_list', 'swarm_expand'].includes(t.name))) {
    expect((t.inputSchema as any).required).toContain('idempotency_key')
  }
  const publish = TOOLS.find(t => t.name === 'swarm_publish')!.inputSchema as any
  expect(publish.required).toEqual(['idempotency_key', 'summary', 'paths'])
  expect(publish.properties.dependencies.items.type).toBe('integer')
})

test('once the swarm ends, its tools are refused and task writes run again', async ($, on) => {
  const board = engine(on, WORKER)
  await $.session.start(start)
  board.files[`${DIR}/swarm.json`] = JSON.stringify({ ...REGISTRY, state: 'ended' })
  expect((await $.tool.call(call('swarm_status', {}))).deny).toBe('This swarm has ended.')
  expect((await $.tool.call({ tool: 'TaskUpdate', taskId: '1' } as ToolCallArgs)).result).toBe('updated')
})

test('a call runs the store with the identity from the session, never from the model', async ($, on) => {
  const board = engine(on, WORKER)
  await $.session.start(start)
  const res = await $.tool.call(call('swarm_task_claim', { idempotency_key: 'k', task_id: 3 }))
  expect(res.result).toBe('{"won":true}')
  expect(board.runs.length).toBe(1)
  expect(board.runs[0]!.argv.at(-1)).toBe('task_claim')
  expect(String(board.runs[0]!.argv[1]).endsWith('/scripts/store.mjs')).toBe(true)
  expect(board.runs[0]!.input).toEqual({
    dir: DIR,
    tasksDir: `C:/cfg/tasks/${LIST}`,
    base: 'abc123',
    parent: 'sid-p',
    roster: REGISTRY.workers,
    actor: { id: 'sid-1', name: 'w1-3fa91c' },
    cwd: 'C:/wt/w1',
    idempotency_key: 'k',
    task_id: 3,
  })
  expect(board.runs[0]!.timeoutMs).toBe(15_000)
})

test('a call that sets an identity, workspace or store field is refused and runs nothing', async ($, on) => {
  const board = engine(on, WORKER)
  await $.session.start(start)
  const res = await $.tool.call(call('swarm_task_claim', { task_id: 3, actor: { id: 'sid-2', name: 'w2' }, cwd: 'C:/wt/w2' }))
  expect(res.deny).toBe('actor, cwd are set by the swarm, not by the call.')
  expect((await $.tool.call(call('swarm_status', { dir: 'C:/other' }))).deny).toBe('dir is set by the swarm, not by the call.')
  expect((await $.tool.call(call('swarm_status', { parent: 'sid-1' }))).deny).toBe('parent is set by the swarm, not by the call.')
  expect(board.runs.length).toBe(0)
})

const NO_WAKE = '{"ok":true,"result":{"wake":false}}'
const WAKE = '{"ok":true,"result":{"wake":true,"reason":"ready","message":"Shared work changed."}}'
const ENDED = '{"ok":true,"result":{"wake":false,"ended":true}}'
const interactive = { ...start, surface: 'terminal', isInteractive: true } as const
const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('each turn reports its start and end, and a due wake at the end resumes the worker', async ($, on) => {
  const clock = mock.clock(on)
  const board = engine(on, WORKER, REGISTRY, command => (command === 'turn' && board.runs.length > 1 ? WAKE : NO_WAKE))
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(turnEnd)
  await clock.settle()
  expect(board.commands()).toEqual(['turn', 'turn'])
  expect(board.runs.map(r => (r.input as { running: boolean }).running)).toEqual([true, false])
  expect(board.prompts).toEqual(['Swarm: Shared work changed.'])
  await $.turn.complete({ ...turnEnd, isAborted: true, reason: 'aborted' })
  await clock.settle()
  expect(board.runs.map(r => (r.input as { reason?: string }).reason)).toEqual([undefined, 'answer', 'aborted'])
})

test("a subagent's turn end reports nothing", async ($, on) => {
  const clock = mock.clock(on)
  const board = engine(on, WORKER, REGISTRY, NO_WAKE)
  await $.session.start(start)
  await $.turn.complete({ ...turnEnd, agentId: 'a1' })
  await clock.settle()
  expect(board.runs).toEqual([])
})

test("an idle worker asks the store to wake it only on another's change, and stops once the swarm ends", async ($, on) => {
  const clock = mock.clock(on)
  const reply = (result: Record<string, unknown>) => JSON.stringify({ ok: true, result })
  let next = reply({ wake: false, changes: 4 })
  const board = engine(on, WORKER, REGISTRY, () => next)
  const count = (n: number) => (board.files[`${DIR}/${CHANGES_FILE}`] = String(n))
  count(4)
  await $.session.start(interactive)
  await $.turn.complete(turnEnd)
  await clock.settle()
  await clock.advance(POLL_MS * 3)
  expect(board.commands()).toEqual(['turn'])

  next = reply({ wake: false, changes: 5 })
  count(5)
  await clock.advance(POLL_MS * 3)
  expect(board.commands()).toEqual(['turn', 'wake'])

  next = reply({ wake: true, reason: 'ready', message: 'Shared work changed.', changes: 7 })
  count(6)
  await clock.advance(POLL_MS)
  expect(board.prompts).toEqual(['Swarm: Shared work changed.'])
  count(8)
  await clock.advance(POLL_MS * 2)
  expect(board.commands()).toEqual(['turn', 'wake', 'wake'])

  next = reply({ wake: false, changes: 9 })
  await $.turn.start({ text: 'Swarm: Shared work changed.', turnId: 't2' })
  await $.turn.complete(turnEnd)
  count(9)
  await clock.advance(POLL_MS * 2)
  expect(board.commands()).toEqual(['turn', 'wake', 'wake', 'turn'])

  next = ENDED
  count(10)
  await clock.advance(POLL_MS)
  count(11)
  await clock.advance(POLL_MS * 3)
  expect(board.commands()).toEqual(['turn', 'wake', 'wake', 'turn', 'wake'])
})

test('a -p worker does not watch the store', async ($, on) => {
  const clock = mock.clock(on)
  const board = engine(on, WORKER, REGISTRY, NO_WAKE)
  await $.session.start(start)
  await $.turn.complete(turnEnd)
  await clock.settle()
  board.files[`${DIR}/${CHANGES_FILE}`] = '1'
  await clock.advance(POLL_MS * 3)
  expect(board.commands()).toEqual(['turn'])
})

test("the session's own end stops the worker; /clear does not", async ($, on) => {
  const board = engine(on, WORKER, REGISTRY, NO_WAKE)
  await $.session.start(start)
  const resume = { id: 'sid-1' }
  await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume })
  expect(board.runs).toEqual([])
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sid-1', resume })
  expect(board.commands()).toEqual(['worker_stop'])
  expect(board.runs[0]!.input).toMatchObject({ idempotency_key: 'session-end-sid-1', reason: 'its session ended (prompt_input_exit)' })
})

test('a refused write reaches the model as an error', async ($, on) => {
  engine(on, WORKER, REGISTRY, '{"ok":false,"error":"task is already owned by another worker or finished"}')
  await $.session.start(start)
  expect((await $.tool.call(call('swarm_task_claim', { idempotency_key: 'k', task_id: 2 }))).deny).toBe(
    'task is already owned by another worker or finished',
  )
})

test('a store crash names the exit code', async ($, on) => {
  engine(on, WORKER, REGISTRY, '')
  await $.session.start(start)
  expect((await $.tool.call(call('swarm_status', {}))).deny).toContain('The swarm store failed (exit 0)')
})

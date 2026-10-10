import type { On, ToolCallArgs } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { configDir, SERVER, storePath, TOOLS } from '../hooks/swarm'

const LIST = 'swarm-fix-login-3fa91c'
const DIR = `C:/cfg/.cck/swarm/${LIST}`
const REGISTRY = { listId: LIST, base: 'abc123', state: 'running', workers: [{ name: 'w1-3fa91c', sessionId: 'sid-1' }] }

type Run = { argv: readonly string[]; input: unknown; timeoutMs?: number }

function engine(on: On, env: Record<string, string>, registry: unknown = REGISTRY, reply = '{"ok":true,"won":true}') {
  const registered: string[] = []
  const runs: Run[] = []
  const files: Record<string, string> = registry ? { [`${DIR}/swarm.json`]: JSON.stringify(registry) } : {}
  on('env.get', (_$, e) => ({ value: { CLAUDE_CONFIG_DIR: 'C:\\cfg', ...env }[e.name] }))
  on('fs.read', (_$, e) => {
    const text = files[e.path.replaceAll('\\', '/')]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.cwd', () => ({ value: 'C:/wt/w1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => {
    registered.push(e.name)
    return { value: { tool: `${SERVER}${e.name}` } }
  })
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, input: JSON.parse(String(e.init?.stdin)), timeoutMs: e.init?.timeoutMs })
    return { value: { exitCode: 0, stdout: reply, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: 'updated' }))
  return { registered, runs, files }
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
  expect(res.deny).toContain('swarm_claim')
})

test('once the swarm ends, its tools are refused and task writes run again', async ($, on) => {
  const board = engine(on, WORKER)
  await $.session.start(start)
  board.files[`${DIR}/swarm.json`] = JSON.stringify({ ...REGISTRY, state: 'ended' })
  expect((await $.tool.call(call('swarm_read', {}))).deny).toBe('This swarm has ended.')
  expect((await $.tool.call({ tool: 'TaskUpdate', taskId: '1' } as ToolCallArgs)).result).toBe('updated')
})

test('a call runs the store with the identity from the session, never from the model', async ($, on) => {
  const board = engine(on, WORKER)
  await $.session.start(start)
  const res = await $.tool.call(call('swarm_claim', { item: 3 }))
  expect(res.result).toBe('{"won":true}')
  expect(board.runs.length).toBe(1)
  expect(board.runs[0]!.argv.at(-1)).toBe('claim')
  expect(String(board.runs[0]!.argv[1]).endsWith('/scripts/store.mjs')).toBe(true)
  expect(board.runs[0]!.input).toEqual({
    dir: DIR,
    tasksDir: `C:/cfg/tasks/${LIST}`,
    base: 'abc123',
    actor: { id: 'sid-1', name: 'w1-3fa91c' },
    cwd: 'C:/wt/w1',
    item: 3,
  })
  expect(board.runs[0]!.timeoutMs).toBe(15_000)
})

test('a waiting read gets a longer timeout', async ($, on) => {
  const board = engine(on, WORKER)
  await $.session.start(start)
  await $.tool.call(call('swarm_read', { wait: 20 }))
  expect(board.runs[0]!.timeoutMs).toBe(29_000)
})

test('a refused write reaches the model as an error', async ($, on) => {
  engine(on, WORKER, REGISTRY, '{"ok":false,"error":"you already hold an unfinished item: 1"}')
  await $.session.start(start)
  expect((await $.tool.call(call('swarm_claim', { item: 2 }))).deny).toBe('you already hold an unfinished item: 1')
})

test('a store crash names the exit code', async ($, on) => {
  engine(on, WORKER, REGISTRY, '')
  await $.session.start(start)
  expect((await $.tool.call(call('swarm_read', {}))).deny).toContain('The swarm store failed (exit 0)')
})

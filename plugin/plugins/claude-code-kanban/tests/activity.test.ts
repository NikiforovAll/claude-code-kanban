import type { On, ToolCallArgs, ToolCheckDecision } from 'claude-code'
import { type Engine, expect, type MockClock, mock, test } from 'claude-code/testing'
import { BOARD_ALLOWED, CLEARED } from '../hooks/activity'

const ROOT = 'C:/cfg/.cck/agent-activity'
const SESSION = `${ROOT}/sid-1`
const MARKER = `${SESSION}/_waiting.json`
const CONFIG = 'C:/cfg/.cck/config.json'

type EngineOptions = { decision?: ToolCheckDecision; rule?: string; env?: Record<string, string> }

// A test hook cannot raise tool.check, so the test raises it (askFor), and the engine's tool.call
// holds the first call until the test answers the terminal prompt.
function engine(on: On, files: Record<string, string>, { decision = 'allow', rule, env = {} }: EngineOptions = {}) {
  const writes: { path: string; text: string }[] = []
  const runs: unknown[] = []
  const status: (string | undefined)[] = []
  let answer = () => {}
  const terminal = new Promise<void>(resolve => {
    answer = resolve
  })
  const norm = (p: string) => p.replaceAll('\\', '/')
  on('fs.read', (_$, e) => {
    const text = files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    writes.push({ path: norm(e.path), text: e.text })
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('env.get', (_$, e) => ({ value: { CLAUDE_CONFIG_DIR: 'C:/cfg', ...env }[e.name] }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('tool.check', () => ({ decision, rule }))
  let held = decision === 'ask'
  on('tool.call', async (_$, e) => {
    const { tool, tool_use_id, agentId, ...input } = e
    if (held) {
      held = false
      await terminal
    }
    runs.push(input)
    return { result: { stdout: 'ok' } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.*', () => ({}))
  return { writes, runs, status, answer }
}

async function askFor($: Engine, clock: MockClock, args: { tool: string } & Record<string, unknown>) {
  const { tool, ...input } = args
  const call = $.tool.call(args as ToolCallArgs)
  await clock.settle()
  await $.tool.check({ tool, input })
  await clock.settle()
  return { call }
}

const marker = (files: Record<string, string>) => JSON.parse(files[MARKER]!)
const decide = (files: Record<string, string>, decision: object) => {
  files[`${SESSION}/_decision-${marker(files).id}.json`] = JSON.stringify(decision)
}

const lines = (text = '') => text.trim().split('\n').map(l => JSON.parse(l))

const turn = (fields: { agentId?: string; answer?: string; isAborted?: boolean }) => ({
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  ...fields,
})

const spawn = (subagentType: string, name?: string) => ({
  tool_use_id: 'tu',
  prompt: 'p',
  description: 'd',
  subagentType,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'opus',
  background: false,
  fork: false,
  name,
})

test('an allowed tool call writes nothing', async ($, on) => {
  const { writes } = engine(on, {})

  const result = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(result.result).toEqual({ stdout: 'ok' })
  expect(writes).toEqual([])
})

test('an ask writes the marker, and a terminal answer clears it', async ($, on) => {
  const files: Record<string, string> = {}
  const clock = mock.clock(on)
  const { runs, answer } = engine(on, files, { decision: 'ask', rule: 'Bash(ls)' })

  const { call } = await askFor($, clock, { tool: 'Bash', command: 'ls' })
  expect(marker(files)).toMatchObject({
    status: 'waiting',
    kind: 'permission',
    toolName: 'Bash',
    toolInput: '{"command":"ls"}',
    cwd: 'C:/proj',
    rule: 'Bash(ls)',
  })
  await clock.advance(1500)
  answer()

  expect((await call).result).toEqual({ stdout: 'ok' })
  expect(files[MARKER]).toBe(CLEARED)
  expect(runs).toEqual([{ command: 'ls' }])
})

test('a board allow runs the tool with the board input and shows why', async ($, on) => {
  const files: Record<string, string> = {}
  const clock = mock.clock(on)
  const { runs, status } = engine(on, files, { decision: 'ask' })

  const { call } = await askFor($, clock, { tool: 'Bash', command: 'ls' })
  decide(files, { behavior: 'allow', updatedInput: { command: 'ls -a' } })
  await clock.advance(500)

  expect((await call).result).toEqual({ stdout: 'ok' })
  expect(runs).toEqual([{ command: 'ls -a' }])
  expect(status).toEqual([BOARD_ALLOWED, undefined])
  expect(files[MARKER]).toBe(CLEARED)
})

test('a board deny refuses the call with its message', async ($, on) => {
  const files: Record<string, string> = {}
  const clock = mock.clock(on)
  const { runs } = engine(on, files, { decision: 'ask' })

  const { call } = await askFor($, clock, { tool: 'Bash', command: 'rm -rf x' })
  decide(files, { behavior: 'deny', message: 'not that' })
  await clock.advance(500)

  expect((await call).deny).toBe('not that')
  expect(runs).toEqual([])
  expect(files[MARKER]).toBe(CLEARED)
})

test('board answers to a question come back as the tool result', async ($, on) => {
  const files: Record<string, string> = {}
  const clock = mock.clock(on)
  engine(on, files, { decision: 'ask' })
  const questions = [{ question: 'Fruit?', header: 'Fruit', options: [], multiSelect: false }]

  const { call } = await askFor($, clock, { tool: 'AskUserQuestion', questions })
  expect(marker(files).kind).toBe('question')
  decide(files, { answers: { 'Fruit?': 'Pear' } })
  await clock.advance(500)

  expect((await call).result).toEqual({ questions, answers: { 'Fruit?': 'Pear' } })
})

test('with approvals off the board only shows the ask', async ($, on) => {
  const files: Record<string, string> = { [CONFIG]: '{"approvals":{"enabled":false}}' }
  const clock = mock.clock(on)
  const { runs, answer } = engine(on, files, { decision: 'ask' })

  const { call } = await askFor($, clock, { tool: 'Bash', command: 'ls' })
  decide(files, { behavior: 'deny' })
  await clock.advance(2000)
  answer()

  expect((await call).result).toEqual({ stdout: 'ok' })
  expect(runs).toEqual([{ command: 'ls' }])
})

test('the board stops waiting after waitSeconds', async ($, on) => {
  const files: Record<string, string> = { [CONFIG]: '{"approvals":{"waitSeconds":1}}' }
  const clock = mock.clock(on)
  const { runs, answer } = engine(on, files, { decision: 'ask' })

  const { call } = await askFor($, clock, { tool: 'Bash', command: 'ls' })
  await clock.advance(1500)
  decide(files, { behavior: 'deny' })
  await clock.advance(1000)
  answer()

  expect((await call).result).toEqual({ stdout: 'ok' })
  expect(runs).toEqual([{ command: 'ls' }])
})

test('a marker that a newer ask owns stays', async ($, on) => {
  const files: Record<string, string> = {}
  const clock = mock.clock(on)
  const { answer } = engine(on, files, { decision: 'ask' })

  const { call } = await askFor($, clock, { tool: 'Bash', command: 'ls' })
  files[MARKER] = '{"status":"waiting","id":"newer"}'
  answer()
  await call

  expect(files[MARKER]).toBe('{"status":"waiting","id":"newer"}')
})

test('a finished main turn marks the session unread', async ($, on) => {
  const files: Record<string, string> = {}
  engine(on, files)

  await $.turn.complete(turn({}))

  expect(files[`${SESSION}/_stop.json`]).toBe('')
})

test('an interrupted main turn does not mark the session unread', async ($, on) => {
  const { writes } = engine(on, {})

  await $.turn.complete(turn({ isAborted: true }))

  expect(writes).toEqual([])
})

test('session start maps the session to a custom task list', async ($, on) => {
  const map = `${ROOT}/_task-maps/list-1.json`
  const files: Record<string, string> = { [map]: '{"old":{"project":"C:/x"}}' }
  engine(on, files, { env: { CLAUDE_CODE_TASK_LIST_ID: 'list-1' } })

  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false })

  const maps = JSON.parse(files[map]!)
  expect(maps.old).toEqual({ project: 'C:/x' })
  expect(maps['sid-1'].project).toBe('C:/proj')
})

test('session start writes nothing without a custom task list', async ($, on) => {
  const { writes } = engine(on, {})

  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false })

  expect(writes).toEqual([])
})

test('a subagent spawn then finish records start and stop', async ($, on) => {
  const files: Record<string, string> = {}
  engine(on, files)

  await $.agent.spawn(spawn('general-purpose'))
  await $.turn.complete(turn({ agentId: 'a1', answer: 'Task done with "quotes"' }))

  const [start, stop] = lines(files[`${SESSION}/a1.jsonl`])
  expect(start).toMatchObject({ agentId: 'a1', type: 'general-purpose', event: 'start', status: 'active' })
  expect(stop).toMatchObject({ agentId: 'a1', event: 'stop', status: 'stopped', lastMessage: 'Task done with "quotes"' })
  expect('type' in stop).toBe(false)
  expect(files[`${SESSION}/_name-general-purpose.id`]).toBe('a1')
  expect(files[`${SESSION}/_stop.json`]).toBeUndefined()
})

test('a subagent stop with an empty answer leaves lastMessage out', async ($, on) => {
  const files: Record<string, string> = {}
  engine(on, files)

  await $.agent.spawn(spawn('general-purpose'))
  await $.turn.complete(turn({ agentId: 'a1' }))

  const [, stop] = lines(files[`${SESSION}/a1.jsonl`])
  expect(stop).toMatchObject({ agentId: 'a1', event: 'stop' })
  expect('lastMessage' in stop).toBe(false)
})

test('a finished loop that was never spawned writes nothing', async ($, on) => {
  const { writes } = engine(on, {})

  await $.turn.complete(turn({ agentId: 'internal' }))

  expect(writes).toEqual([])
})

test('a named spawn maps the name, and TeammateIdle finds the agent by it', async ($, on) => {
  const files: Record<string, string> = {}
  engine(on, files)

  await $.agent.spawn(spawn('general-purpose', 'researcher'))
  await $.classic.TeammateIdle({ teammate_name: 'researcher', team_name: 'team' })

  const idle = lines(files[`${SESSION}/a1.jsonl`])[1]
  expect(idle).toMatchObject({ agentId: 'a1', type: 'researcher', event: 'idle', status: 'idle' })
})

test('TeammateIdle for an unknown teammate writes nothing', async ($, on) => {
  const { writes } = engine(on, {})

  await $.classic.TeammateIdle({ teammate_name: 'ghost', team_name: 'team' })

  expect(writes).toEqual([])
})

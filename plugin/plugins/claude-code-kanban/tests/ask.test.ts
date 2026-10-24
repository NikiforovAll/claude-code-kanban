import type { On, ToolCallArgs } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { answerText, TOOL, WAIT_MS } from '../hooks/ask'

const CCK_URL = 'http://127.0.0.1:4100'
const TERMINAL_ID = 'term-1'
const TOKEN_FILE = 'C:/cfg/.cck/terminal-tokens/4100.json'
const ASK = `${CCK_URL}/api/terminals/${TERMINAL_ID}/ask`

type Reply = { status: number; body: unknown }
type Request = { url: string; method?: string; headers?: Record<string, string>; body?: unknown }

// `replies` answers the ask routes in order; the doorbell's polls never settle.
function engine(on: On, env: Record<string, string>, replies: Reply[] = []) {
  const registered: string[] = []
  const requests: Request[] = []
  mock.clock(on)
  on('env.get', (_$, e) => ({ value: { CLAUDE_CONFIG_DIR: 'C:/cfg', ...env }[e.name] }))
  on('fs.read', (_$, e) => {
    if (e.path.replaceAll('\\', '/') === TOKEN_FILE) return { value: '{"token":"tok-abc"}' }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__claude-code-kanban__${e.name}` } }
  })
  on('http.fetch', (_$, e) => {
    if (!e.url.includes('/ask')) return new Promise(() => {})
    const { method, headers, body } = (e.init ?? {}) as Omit<Request, 'url'>
    requests.push({ url: e.url, method, headers, body: typeof body === 'string' ? JSON.parse(body) : body })
    const reply = replies.shift()
    if (!reply) throw new Error('no reply')
    return { value: { status: reply.status, ok: reply.status < 300, headers: {}, text: JSON.stringify(reply.body) } }
  })
  return { registered, requests }
}

const GATE = { CCK_URL, CCK_TERMINAL_ID: TERMINAL_ID }
const call = (input: Record<string, unknown>) => ({ tool: TOOL, ...input }) as ToolCallArgs
const START = { cwd: 'C:/proj', surface: 'terminal', isInteractive: true } as const

test('answer lines', async () => {
  expect(answerText('Pick', { status: 'answered', data: { a: 1 } })).toBe('The user answered "Pick":\n{\n  "a": 1\n}')
  expect(answerText('Pick', { status: 'dismissed' })).toBe('The user skipped "Pick" without answering.')
  expect(answerText('Pick', { status: 'dismissed', reason: 'replaced' })).toBe('"Pick" was replaced by a newer question.')
  expect(answerText('Pick', { status: 'gone' })).toContain('no longer open')
})

test('only a session in the terminal gets the tool', async ($, on) => {
  const board = engine(on, { CCK_URL })
  await $.session.start(START)
  expect(board.registered).toEqual(['show'])
})

test('in the terminal: registers ask beside show', async ($, on) => {
  const board = engine(on, GATE)
  await $.session.start(START)
  expect(board.registered).toEqual(['show', 'ask'])
})

test('opens the question, polls past pending, and answers with the data', async ($, on) => {
  const board = engine(on, GATE, [
    { status: 200, body: { id: 'q1' } },
    { status: 200, body: { status: 'pending' } },
    { status: 200, body: { status: 'answered', data: { theme: 'light' } } },
  ])
  await $.session.start(START)
  const res = await $.tool.call(call({ title: 'Pick a theme', file: 'C:/s/ask.html', size: 'full' }))
  expect(res.result).toBe(answerText('Pick a theme', { status: 'answered', data: { theme: 'light' } }))
  const headers = { 'x-terminal-token': 'tok-abc' }
  expect(board.requests).toEqual([
    {
      url: ASK,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: { sessionId: 'sid-1', title: 'Pick a theme', file: 'C:/s/ask.html', size: 'full' },
    },
    { url: `${ASK}/q1/wait?ms=${WAIT_MS}`, method: undefined, headers, body: undefined },
    { url: `${ASK}/q1/wait?ms=${WAIT_MS}`, method: undefined, headers, body: undefined },
  ])
})

test('a skip answers that the user skipped', async ($, on) => {
  engine(on, GATE, [
    { status: 200, body: { id: 'q1' } },
    { status: 200, body: { status: 'dismissed' } },
  ])
  await $.session.start(START)
  const res = await $.tool.call(call({ title: 'Pick', file: 'C:/s/ask.html' }))
  expect(res.result).toBe('The user skipped "Pick" without answering.')
})

test('a board refusal reaches the model with its text', async ($, on) => {
  engine(on, GATE, [{ status: 400, body: { error: 'file must be an HTML file' } }])
  await $.session.start(START)
  const res = await $.tool.call(call({ title: 'Pick', file: 'C:/s/ask.md' }))
  expect(res.deny).toBe('file must be an HTML file')
})

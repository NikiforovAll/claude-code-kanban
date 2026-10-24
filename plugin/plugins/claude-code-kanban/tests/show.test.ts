import type { On, ToolCallArgs } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { boardPort, CLAIM_OFF_TERMINAL, paneText, shownText, TOOL } from '../hooks/show'

const CCK_URL = 'http://127.0.0.1:4100'
const TERMINAL_ID = 'term-1'
const TOKEN_FILE = 'C:/cfg/.cck/terminal-tokens/4100.json'
const SERVER_FILE = 'C:/cfg/.cck/server.json'

type Reply = { status: number; body: unknown } | Error
type Request = { url: string; method?: string; headers?: Record<string, string>; body?: unknown }

function engine(on: On, env: Record<string, string>, reply?: Reply) {
  const registered: { name: string; required: unknown }[] = []
  const requests: Request[] = []
  const files: Record<string, string> = { [TOKEN_FILE]: '{"token":"tok-abc"}', [SERVER_FILE]: '{"pid":1,"port":4100}' }
  mock.clock(on)
  on('env.get', (_$, e) => ({ value: { CLAUDE_CONFIG_DIR: 'C:/cfg', ...env }[e.name] }))
  on('fs.read', (_$, e) => {
    const text = files[e.path.replaceAll('\\', '/')]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => {
    registered.push({ name: e.name, required: (e.inputSchema as { required?: unknown }).required })
    return { value: { tool: `mcp__claude-code-kanban__${e.name}` } }
  })
  on('http.fetch', (_$, e) => {
    if (!/\/show$|\/api\/panes\//.test(e.url)) return new Promise(() => {})
    const { method, headers, body } = (e.init ?? {}) as Omit<Request, 'url'>
    requests.push({ url: e.url, method, headers, body: typeof body === 'string' ? JSON.parse(body) : body })
    if (!reply) throw new Error('no reply')
    if (reply instanceof Error) return { deny: reply.message }
    return { value: { status: reply.status, ok: reply.status < 300, headers: {}, text: JSON.stringify(reply.body) } }
  })
  return { registered, requests, files }
}

const GATE = { CCK_URL, CCK_TERMINAL_ID: TERMINAL_ID }
const call = (input: Record<string, unknown>) => ({ tool: TOOL, ...input }) as ToolCallArgs

test('helpers: the port of CCK_URL, the answer lines', async () => {
  expect(boardPort('http://127.0.0.1:4100')).toBe('4100')
  expect(boardPort('http://localhost:3541/')).toBe('3541')
  expect(boardPort('http://localhost')).toBe(undefined)
  expect(shownText({ title: 'Plan', key: 'plan', index: 3, count: 7 })).toBe('Shown "Plan" (plan, 3/7)')
  expect(shownText({ title: 'Map', key: null, index: 1, count: 1 })).toBe('Shown "Map" (1/1)')
  expect(shownText({ title: 'Plan', key: 'plan', index: 1, count: 1, path: 'C:/s/p1.md' }, true)).toBe(
    'Card "Plan" (plan, 1/1) is ready. Write it to C:/s/p1.md; the card refreshes on each save.',
  )
  expect(paneText('Plan', false)).toBe('The board already has a tab for this file; it refreshes on each save.')
})

test('in the terminal: the overlay tool, file optional', async ($, on) => {
  const board = engine(on, GATE)
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  expect(board.registered[0]).toEqual({ name: 'show', required: ['title'] })
})

test('outside the terminal: the pane tool, file required', async ($, on) => {
  const board = engine(on, { CCK_URL })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  expect(board.registered).toEqual([{ name: 'show', required: ['title', 'file'] }])
})

test('outside the terminal: a file post adds a show pane on the board of server.json', async ($, on) => {
  const board = engine(on, {}, { status: 200, body: { pane: { id: 'p1' }, added: true } })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call(call({ title: 'Plan', file: 'C:/s/plan.html' }))
  expect(res.result).toBe(paneText('Plan', true))
  expect(board.requests).toEqual([
    {
      url: 'http://127.0.0.1:4100/api/panes/sid-1',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { target: 'C:/s/plan.html', title: 'Plan', show: true },
    },
  ])
})

test('outside the terminal: the same file again answers that the tab exists', async ($, on) => {
  engine(on, {}, { status: 200, body: { pane: { id: 'p1' }, added: false } })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call(call({ title: 'Plan', file: 'C:/s/plan.html' }))
  expect(res.result).toBe(paneText('Plan', false))
})

test('outside the terminal: a claim sends nothing and asks for a file', async ($, on) => {
  const board = engine(on, {})
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call(call({ title: 'Plan' }))
  expect(res.result).toBe(CLAIM_OFF_TERMINAL)
  expect(board.requests).toEqual([])
})

test('outside the terminal: no board, no request, an error that says so', async ($, on) => {
  // CCK_URL keeps the doorbell on its open poll: without a board it sleeps, and the unload rejects that sleep.
  const board = engine(on, { CCK_URL })
  delete board.files[SERVER_FILE]
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call(call({ title: 'Plan', file: 'C:/s/plan.md' }))
  expect(res.deny).toContain('not running')
  expect(board.requests).toEqual([])
})

test('outside the terminal: a board refusal reaches the model with its text', async ($, on) => {
  const error = 'Not a previewable text, markdown, HTML or image file'
  engine(on, {}, { status: 400, body: { error } })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call(call({ title: 'Zip', file: 'C:/s/a.zip' }))
  expect(res.deny).toBe(error)
})

test('a -p run gets no tool', async ($, on) => {
  const board = engine(on, GATE)
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false })
  expect(board.registered).toEqual([])
})

test('posts the body with the terminal token and answers with the position', async ($, on) => {
  const board = engine(on, GATE, {
    status: 200,
    body: { id: 'p1', title: 'Plan', key: 'plan', index: 2, count: 3, replaced: false },
  })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call(call({ title: 'Plan', key: 'plan', kind: 'markdown', file: 'C:/proj/plan.md' }))
  expect(res.result).toBe('Shown "Plan" (plan, 2/3)')
  expect(board.requests).toEqual([
    {
      url: `${CCK_URL}/api/terminals/${TERMINAL_ID}/show`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-terminal-token': 'tok-abc' },
      body: { sessionId: 'sid-1', title: 'Plan', key: 'plan', kind: 'markdown', file: 'C:/proj/plan.md' },
    },
  ])
})

test('sends the base for the card links', async ($, on) => {
  const board = engine(on, GATE, { status: 200, body: { id: 'p1', title: 'Stack', key: 'stack', index: 1, count: 1, path: 'C:/s/p1.md' } })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call(call({ title: 'Stack', key: 'stack', base: 'C:/proj-worktree' }))
  expect(board.requests[0]?.body).toEqual({ sessionId: 'sid-1', title: 'Stack', key: 'stack', base: 'C:/proj-worktree' })
})

test('a claim sends no file and answers with the file to write', async ($, on) => {
  const path = 'C:/s/.cck/show/p1.md'
  const board = engine(on, GATE, { status: 200, body: { id: 'p1', title: 'Plan', key: 'plan', index: 1, count: 1, path } })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call(call({ title: 'Plan', key: 'plan' }))
  expect(res.result).toBe(`Card "Plan" (plan, 1/1) is ready. Write it to ${path}; the card refreshes on each save.`)
  expect(board.requests[0]?.body).toEqual({ sessionId: 'sid-1', title: 'Plan', key: 'plan' })
})

test('a 400 answer reaches the model as an error with the server text', async ($, on) => {
  const error = 'file not found: C:/proj/gone.md'
  engine(on, GATE, { status: 400, body: { error } })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call(call({ title: 'Gone', file: 'C:/proj/gone.md' }))
  expect(res.deny).toBe(error)
})

test('a network error reaches the model as an error', async ($, on) => {
  engine(on, GATE, new Error('connect ECONNREFUSED 127.0.0.1:4100'))
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call(call({ title: 'Plan' }))
  expect(res.deny).toContain(`Cannot reach cck at ${CCK_URL}`)
  expect(res.deny).toContain('ECONNREFUSED')
})

test('no token file: no request, an error that names the board', async ($, on) => {
  const board = engine(on, GATE)
  delete board.files[TOKEN_FILE]
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const res = await $.tool.call(call({ title: 'Plan' }))
  expect(res.deny).toContain('No terminal token')
  expect(board.requests).toEqual([])
})

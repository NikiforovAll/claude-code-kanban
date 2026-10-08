import type { On, ToolCallArgs } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { boardPort, dropSkillLine, shownText, TOOL } from '../hooks/show'

const CCK_URL = 'http://127.0.0.1:4100'
const TERMINAL_ID = 'term-1'
const TOKEN_FILE = 'C:/cfg/.cck/terminal-tokens/4100.json'
const LISTING = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- claude-code-kanban:dispatch',
  '- claude-code-kanban:show',
  '- claude-code-kanban:kanban: Kanban board CLI',
  '- meta:show-me: Help the user understand the current topic visually',
].join('\n')

type Reply = { status: number; body: unknown } | Error
type Request = { url: string; method?: string; headers?: Record<string, string>; body?: unknown }

function engine(on: On, env: Record<string, string>, reply?: Reply) {
  const registered: string[] = []
  const requests: Request[] = []
  const files: Record<string, string> = { [TOKEN_FILE]: '{"token":"tok-abc"}' }
  on('env.get', (_$, e) => ({ value: { CLAUDE_CONFIG_DIR: 'C:/cfg', ...env }[e.name] }))
  on('fs.read', (_$, e) => {
    const text = files[e.path.replaceAll('\\', '/')]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__claude-code-kanban__${e.name}` } }
  })
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('http.fetch', (_$, e) => {
    if (!e.url.includes('/show')) return new Promise(() => {})
    const { method, headers, body } = (e.init ?? {}) as Omit<Request, 'url'>
    requests.push({ url: e.url, method, headers, body: typeof body === 'string' ? JSON.parse(body) : body })
    if (!reply) throw new Error('no reply')
    if (reply instanceof Error) return { deny: reply.message }
    return { value: { status: reply.status, ok: reply.status < 300, headers: {}, text: JSON.stringify(reply.body) } }
  })
  return { registered, requests, files }
}

const GATE = { CCK_URL, CCK_TERMINAL_ID: TERMINAL_ID }
const listing = { type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as const
const call = (input: Record<string, unknown>) => ({ tool: TOOL, ...input }) as ToolCallArgs

test('helpers: the port of CCK_URL, the answer line, the listing filter', async () => {
  expect(boardPort('http://127.0.0.1:4100')).toBe('4100')
  expect(boardPort('http://localhost:3541/')).toBe('3541')
  expect(boardPort('http://localhost')).toBe(undefined)
  expect(shownText({ title: 'Plan', key: 'plan', index: 3, count: 7 })).toBe('Shown "Plan" (plan, 3/7)')
  expect(shownText({ title: 'Map', key: null, index: 1, count: 1 })).toBe('Shown "Map" (1/1)')
  expect(shownText({ title: 'Plan', key: 'plan', index: 1, count: 1, path: 'C:/s/p1.md' }, true)).toBe(
    'Card "Plan" (plan, 1/1) is ready. Write it to C:/s/p1.md; the card refreshes on each save.',
  )
  expect(dropSkillLine(LISTING)).toBe(LISTING.replace('- claude-code-kanban:show\n', ''))
  expect(dropSkillLine('- claude-code-kanban:show: Show a diagram\n- x')).toBe('- x')
})

test('gate off: no tool, and the skill line is dropped', async ($, on) => {
  const board = engine(on, { CCK_URL })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  expect(board.registered).toEqual([])
  const { text } = await $.prompt.attachment(listing)
  expect(text).toBe(LISTING.replace('- claude-code-kanban:show\n', ''))
})

test('gate on: the tool is registered and the skill line stays', async ($, on) => {
  const board = engine(on, GATE)
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  expect(board.registered).toEqual(['show'])
  const { text } = await $.prompt.attachment(listing)
  expect(text).toBe(LISTING)
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

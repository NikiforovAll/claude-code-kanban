import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { boardUrl, RETRY_MS } from '../hooks/doorbell'

test('the board URL comes from CCK_URL, else from server.json', async () => {
  expect(boardUrl('http://127.0.0.1:4000/', '{"port":3541}')).toBe('http://127.0.0.1:4000')
  expect(boardUrl(undefined, '{"port":3541}')).toBe('http://127.0.0.1:3541')
  expect(boardUrl(undefined, '{"port":"3541"}')).toBe(undefined)
  expect(boardUrl(undefined, 'not json')).toBe(undefined)
  expect(boardUrl(undefined, undefined)).toBe(undefined)
})

function engine(on: On, replies: (() => { status: number; events?: string[] })[]) {
  const urls: string[] = []
  const prompts: string[] = []
  let sessionId = 'sid-1'
  on('fs.read', (_$, e) => {
    if (e.path.replaceAll('\\', '/') === 'C:/cfg/.cck/server.json') return { value: '{"port":3541}' }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('env.get', (_$, e) => ({ value: { CLAUDE_CONFIG_DIR: 'C:/cfg' }[e.name] }))
  on('session.id', () => ({ value: sessionId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('http.fetch', async (_$, e) => {
    urls.push(e.url)
    const reply = replies.shift()
    if (!reply) return new Promise(() => {})
    const { status, events = [] } = reply()
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify({ events }) } }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  return { urls, prompts, clear: () => (sessionId = 'sid-2') }
}

test('a -p run does not poll the board', async ($, on) => {
  const clock = mock.clock(on)
  const board = engine(on, [])
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false })
  await clock.settle()
  expect(board.urls).toEqual([])
})

test('polls the board, submits a burst as one prompt, and drops the backlog for a new session id', async ($, on) => {
  const clock = mock.clock(on)
  const replies = [
    () => ({ status: 200, events: ['line one', 'line two'] }),
    () => ({ status: 503 }),
    () => {
      board.clear()
      return { status: 200 }
    },
    () => ({ status: 200, events: ['after clear'] }),
  ]
  const board = engine(on, replies)
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(board.prompts).toEqual(['line one\nline two'])
  expect(board.urls).toEqual([
    'http://127.0.0.1:3541/api/sessions/sid-1/events?wait=25&first=1',
    'http://127.0.0.1:3541/api/sessions/sid-1/events?wait=25',
  ])

  await clock.advance(RETRY_MS)
  expect(board.urls.slice(2)).toEqual([
    'http://127.0.0.1:3541/api/sessions/sid-1/events?wait=25',
    'http://127.0.0.1:3541/api/sessions/sid-2/events?wait=25&first=1',
    'http://127.0.0.1:3541/api/sessions/sid-2/events?wait=25',
  ])
  expect(board.prompts).toEqual(['line one\nline two', 'after clear'])
})

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { boardUrl, parseReply, RETRY_MS } from '../hooks/doorbell'

test('the board URL comes from CCK_URL, else from server.json', async () => {
  expect(boardUrl('http://127.0.0.1:4000/', '{"port":3541}')).toBe('http://127.0.0.1:4000')
  expect(boardUrl(undefined, '{"port":3541}')).toBe('http://127.0.0.1:3541')
  expect(boardUrl(undefined, '{"port":"3541"}')).toBe(undefined)
  expect(boardUrl(undefined, 'not json')).toBe(undefined)
  expect(boardUrl(undefined, undefined)).toBe(undefined)
})

type Reply = { status: number; events?: string[]; seqs?: number[]; board?: string }

function engine(on: On, replies: (() => Reply)[], submit?: () => Promise<unknown>) {
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
    const { status, events = [], seqs, board } = reply()
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify({ events, seqs, board }) } }
  })
  on('prompt.submit', async (_$, e) => {
    prompts.push(e.text)
    if (submit) await submit()
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

  const base = 'http://127.0.0.1:3541/api/sessions'
  expect(board.prompts).toEqual(['line one\nline two'])
  expect(board.urls).toEqual([
    `${base}/sid-1/events?wait=25&board=&got=0&ack=0&first=1`,
    `${base}/sid-1/events?wait=25&board=&got=0&ack=0`,
  ])

  await clock.advance(RETRY_MS)
  expect(board.urls.slice(2)).toEqual([
    `${base}/sid-1/events?wait=25&board=&got=0&ack=0`,
    `${base}/sid-2/events?wait=25&board=&got=0&ack=0&first=1&prev=sid-1`,
    `${base}/sid-2/events?wait=25&board=&got=0&ack=0`,
  ])
  expect(board.prompts).toEqual(['line one\nline two', 'after clear'])
})

test('keeps polling while a submit waits, sends what came in as one prompt, and acks only after the submit', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  const replies = [
    () => ({ status: 200, events: ['move'], seqs: [1], board: 'b1' }),
    () => ({ status: 200, events: ['review one'], seqs: [2], board: 'b1' }),
    () => ({ status: 200, events: ['review two', 'review one'], seqs: [3, 2], board: 'b1' }),
  ]
  let held = true
  const board = engine(on, replies, () => (held ? new Promise<void>(r => (release = () => ((held = false), r()))) : Promise.resolve()))
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const base = 'http://127.0.0.1:3541/api/sessions/sid-1/events?wait=25'
  expect(board.prompts).toEqual(['move'])
  expect(board.urls).toEqual([
    `${base}&board=&got=0&ack=0&first=1`,
    `${base}&board=b1&got=1&ack=0`,
    `${base}&board=b1&got=2&ack=0`,
    `${base}&board=b1&got=3&ack=0`,
  ])

  release()
  await clock.settle()
  expect(board.prompts).toEqual(['move', 'review one\nreview two'])
})

test('acks a submitted line on the next poll', async ($, on) => {
  const clock = mock.clock(on)
  const replies = [() => ({ status: 200, events: ['review'], seqs: [4], board: 'b1' }), () => ({ status: 200, board: 'b1' })]
  const board = engine(on, replies)
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(board.urls.at(-1)).toContain('board=b1&got=4&ack=4')
})

test('starts the count again when the board restarts', async ($, on) => {
  const clock = mock.clock(on)
  const replies = [
    () => ({ status: 200, events: ['old'], seqs: [9], board: 'b1' }),
    () => ({ status: 200, board: 'b1' }),
    () => ({ status: 200, events: ['new'], seqs: [1], board: 'b2' }),
  ]
  const board = engine(on, replies)
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(board.prompts).toEqual(['old', 'new'])
  expect(board.urls.at(-1)).toContain('board=b2&got=1&ack=1')
})

test('reads a reply from a board without acks', () => {
  expect(parseReply('{"events":["a",3,"b"]}')).toEqual({ lines: [{ text: 'a', seq: undefined }, { text: 'b', seq: undefined }], board: '' })
  expect(parseReply('{"events":["a"],"seqs":[5],"board":"b1"}')).toEqual({ lines: [{ text: 'a', seq: 5 }], board: 'b1' })
})

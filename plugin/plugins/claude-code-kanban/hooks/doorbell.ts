import type { EngineInterface, Register } from 'claude-code'
import { cckRoot } from './context'

// $.http.fetch gives up on a request after 30 s, so the poll asks the board to answer sooner.
export const WAIT_SEC = 25
export const RETRY_MS = 10_000

export function boardUrl(cckUrl: string | undefined, serverJson: string | undefined) {
  if (cckUrl) return cckUrl.replace(/\/+$/, '')
  try {
    const { port } = JSON.parse(serverJson ?? '')
    return Number.isInteger(port) ? `http://127.0.0.1:${port}` : undefined
  } catch {
    return undefined
  }
}

let cck: Promise<string> | undefined

// The engine does not follow $ into an imported function, so only the path rule is shared.
function cckDir($: EngineInterface) {
  cck ??= Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME'), $.env.get('USERPROFILE')]).then(
    ([configDir, home, userProfile]) => cckRoot(configDir, home, userProfile),
  )
  return cck
}

// Read on every poll, so the mod follows a board that restarted on another port. CCK_URL comes
// from the board whose terminal started this session, which owns the session's queue.
async function findBoard($: EngineInterface) {
  const cckUrl = await $.env.get('CCK_URL')
  if (cckUrl) return boardUrl(cckUrl, undefined)
  try {
    return boardUrl(undefined, await $.fs.read(`${await cckDir($)}/server.json`))
  } catch {
    return undefined
  }
}

type Line = { text: string; seq?: number }

// A board before acks sends no seqs and drops a line once it answers with it.
export function parseReply(text: string) {
  const { events, seqs, board } = JSON.parse(text) as { events?: unknown; seqs?: unknown; board?: unknown }
  const lines: Line[] = Array.isArray(events)
    ? events.flatMap((e, i) =>
        typeof e === 'string'
          ? [{ text: e, seq: Array.isArray(seqs) && Number.isInteger(seqs[i]) ? (seqs[i] as number) : undefined }]
          : [],
      )
    : []
  return { lines, board: typeof board === 'string' ? board : '' }
}

async function poll($: EngineInterface, url: string, sessionId: string, query: string) {
  const r = await $.http.fetch(`${url}/api/sessions/${encodeURIComponent(sessionId)}/events?${query}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return parseReply(r.text)
}

// The board keeps a line until a poll acks it, and the ack goes out only after the submit, so a
// line the mod never got to the session is sent again. Seqs count per board run: `board` names
// the run, and the board ignores `got` and `ack` from another one.
//
// The session id changes on /clear, so it is read for every poll. The first poll for an id drops
// the task moves the board queued before this session listened (a move from hours ago is not an
// instruction) and names the id it leaves, so the board moves that id's reviews over.
async function listen($: EngineInterface) {
  let attached: string | undefined
  let board = ''
  let got = 0
  let acked = 0
  const buffer: Line[] = []
  let submitting = false

  // A submit waits until the session is idle. The loop keeps polling meanwhile, so the board sees
  // a live doorbell, and lines that come in wait here to go out as one prompt.
  const flush = () => {
    if (submitting || !buffer.length) return
    const burst = buffer.splice(0)
    const forBoard = board
    submitting = true
    void $.prompt
      .submit({ text: burst.map(l => l.text).join('\n') })
      .catch(() => {})
      .finally(() => {
        if (forBoard === board) for (const l of burst) if (l.seq !== undefined && l.seq > acked) acked = l.seq
        submitting = false
        flush()
      })
  }

  for (;;) {
    const [url, sessionId] = await Promise.all([findBoard($), $.session.id()])
    const first = attached !== sessionId
    const query = [`wait=${WAIT_SEC}`, `board=${encodeURIComponent(board)}`, `got=${got}`, `ack=${acked}`]
    if (first) query.push('first=1')
    if (first && attached) query.push(`prev=${encodeURIComponent(attached)}`)
    let reply: ReturnType<typeof parseReply> | undefined
    try {
      if (url) reply = await poll($, url, sessionId, query.join('&'))
    } catch {}
    if (!reply) {
      await $.clock.sleep(RETRY_MS)
      continue
    }
    attached = sessionId
    if (reply.board !== board) {
      board = reply.board
      got = 0
      acked = 0
    }
    for (const line of reply.lines) {
      if (line.seq !== undefined) {
        if (line.seq <= got) continue
        got = line.seq
      }
      buffer.push(line)
    }
    flush()
  }
}

let listening = false

// Only a session with a person at the prompt listens: a -p run ends on its own and must not wait on an open poll.
export const register: Register = on => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    if (!listening) {
      listening = true
      void listen($)
    }
    return result
  })
}

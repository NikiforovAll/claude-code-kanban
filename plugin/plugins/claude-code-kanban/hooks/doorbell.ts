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

async function poll($: EngineInterface, url: string, sessionId: string, first: boolean) {
  const query = `wait=${WAIT_SEC}${first ? '&first=1' : ''}`
  const r = await $.http.fetch(`${url}/api/sessions/${encodeURIComponent(sessionId)}/events?${query}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const { events } = JSON.parse(r.text) as { events?: unknown }
  return Array.isArray(events) ? events.filter((e): e is string => typeof e === 'string') : []
}

// The session id changes on /clear, so it is read for every poll. The first poll for an id drops
// what the board queued before this session listened: a move from hours ago is not an instruction.
async function listen($: EngineInterface) {
  let attached: string | undefined
  for (;;) {
    const [url, sessionId] = await Promise.all([findBoard($), $.session.id()])
    let events: string[] | undefined
    try {
      if (url) events = await poll($, url, sessionId, attached !== sessionId)
    } catch {}
    if (!events) {
      await $.clock.sleep(RETRY_MS)
      continue
    }
    attached = sessionId
    // A submit waits until the session is idle, and one prompt keeps a burst of moves in one turn.
    if (events.length) await $.prompt.submit({ text: events.join('\n') }).catch(() => {})
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

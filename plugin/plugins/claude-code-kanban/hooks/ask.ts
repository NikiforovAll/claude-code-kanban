import type { EngineInterface, Register } from 'claude-code'
import { cckRoot } from './context'
import { boardPort } from './show'

export const TOOL = 'mcp__claude-code-kanban__ask'

type AskInput = { title: string; file: string; size?: 'md' | 'lg' | 'full' }
type Target = { url: string; terminalId: string }

let cck: Promise<string> | undefined

function cckDir($: EngineInterface) {
  cck ??= Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME'), $.env.get('USERPROFILE')]).then(
    ([configDir, home, userProfile]) => cckRoot(configDir, home, userProfile),
  )
  return cck
}

let target: Promise<Target | undefined> | undefined

// Both vars come from ptyEnv, so only a session started in cck's embedded terminal has them.
function terminal($: EngineInterface) {
  target ??= Promise.all([$.env.get('CCK_URL'), $.env.get('CCK_TERMINAL_ID')]).then(([url, terminalId]) =>
    url && terminalId ? { url: url.replace(/\/+$/, ''), terminalId } : undefined,
  )
  return target
}

// Read on every call: a restarted board writes a new token.
async function terminalToken($: EngineInterface, url: string) {
  const port = boardPort(url)
  if (!port) return undefined
  try {
    const { token } = JSON.parse(await $.fs.read(`${await cckDir($)}/terminal-tokens/${port}.json`))
    return typeof token === 'string' && token ? token : undefined
  } catch {
    return undefined
  }
}

function errorText(status: number, text: string) {
  try {
    const { error } = JSON.parse(text)
    if (typeof error === 'string' && error) return error
  } catch {}
  return `cck answered HTTP ${status}`
}

async function send(
  $: EngineInterface,
  url: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ text: string } | { deny: string }> {
  try {
    const res = await $.http.fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return res.ok ? { text: res.text } : { deny: errorText(res.status, res.text) }
  } catch (err) {
    return { deny: `Cannot reach cck at ${url}: ${err instanceof Error ? err.message : String(err)}` }
  }
}
type Answer = { status: 'answered'; data: unknown } | { status: 'dismissed' | 'cancelled' | 'gone' | 'pending'; reason?: string }

// Under $.http.fetch's 30 s limit; the board answers pending at this mark.
export const WAIT_MS = 20_000

export function answerText(title: string, a: Answer) {
  if (a.status === 'answered') return `The user answered "${title}":\n${JSON.stringify(a.data, null, 2)}`
  if (a.status === 'dismissed' && a.reason === 'replaced') return `"${title}" was replaced by a newer question.`
  if (a.status === 'dismissed') return `The user skipped "${title}" without answering.`
  return `"${title}" is no longer open on the board; the user did not answer it.`
}

const askPath = (t: Target, id = '') =>
  `/api/terminals/${encodeURIComponent(t.terminalId)}/ask${id ? `/${encodeURIComponent(id)}` : ''}`

async function poll($: EngineInterface, t: Target, id: string): Promise<Answer | { deny: string }> {
  const token = await terminalToken($, t.url)
  if (!token) return { deny: `No terminal token for the cck server at ${t.url}.` }
  try {
    const res = await $.http.fetch(`${t.url}${askPath(t, id)}/wait?ms=${WAIT_MS}`, {
      headers: { 'x-terminal-token': token },
    })
    if (!res.ok) return { deny: errorText(res.status, res.text) }
    return JSON.parse(res.text) as Answer
  } catch (err) {
    return { deny: `Lost the cck board at ${t.url}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function cancel($: EngineInterface, t: Target, id: string) {
  const token = await terminalToken($, t.url)
  if (!token) return
  try {
    await $.http.fetch(`${t.url}${askPath(t, id)}`, { method: 'DELETE', headers: { 'x-terminal-token': token } })
  } catch {}
}

// The call waits until the user answers or skips. An interrupt aborts `signal`: the hook stops at once
// and closes the modal, because the dispatch has gone on without it.
async function ask($: EngineInterface, t: Target, input: AskInput, signal: AbortSignal) {
  const token = await terminalToken($, t.url)
  if (!token) return { deny: `No terminal token for the cck server at ${t.url}. It must run with the terminal enabled.` }
  const { title, file, size } = input
  const opened = await send($, t.url, askPath(t), { 'x-terminal-token': token }, {
    sessionId: await $.session.id(),
    title,
    file,
    size,
  })
  if ('deny' in opened) return opened
  const { id } = JSON.parse(opened.text) as { id: string }
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted')
    signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  for (;;) {
    const got = await Promise.race([poll($, t, id), aborted])
    if (got === 'aborted') {
      await cancel($, t, id)
      return { deny: 'Interrupted; the question was closed.' }
    }
    if ('deny' in got) return got
    if (got.status !== 'pending') return { result: answerText(title, got) }
  }
}

const ASK_TOOL = {
  description:
    'Ask the user through an HTML card in a modal over this terminal, and wait for the answer, which comes back as the tool result: the data the card sent, as JSON, or a line that says the user skipped. For fixed choices, use AskUserQuestion; use ask when the answer needs something to see or control: a preview, a diagram, sliders, a long form, a quiz sheet, a playground. Load the claude-code-kanban:ask skill first: it says how to write the card and how it sends the answer. Write the card to an HTML file in your scratchpad, then pass it as file.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The question, short: it titles the modal and the chip that reopens it' },
      file: { type: 'string', description: 'Absolute path of the HTML card' },
      size: {
        type: 'string',
        enum: ['md', 'lg', 'full'],
        description: 'Modal size: md for a short form, lg (default) for most cards, full for a playground or a quiz sheet',
      },
    },
    required: ['title', 'file'],
  },
}

// Only a session in cck's terminal has a board to draw the modal; elsewhere AskUserQuestion serves.
export const register: Register = (on) => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    if (await terminal($)) await $.tool.register({ name: 'ask', ...ASK_TOOL })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    const t = await terminal($)
    if (!t) return { deny: 'No cck board here: use AskUserQuestion.' }
    return ask($, t, e as unknown as AskInput, next.signal)
  })
}

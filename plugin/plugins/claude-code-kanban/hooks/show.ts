import type { EngineInterface, Register } from 'claude-code'
import { cckRoot } from './context'
import { boardUrl } from './doorbell'

export const TOOL = 'mcp__claude-code-kanban__show'

type ShowInput = { title: string; key?: string; kind?: 'markdown' | 'html'; file?: string; base?: string }
type Shown = { title: string; key?: string | null; index: number; count: number; path?: string | null }

export function boardPort(cckUrl: string) {
  return /^[a-z]+:\/\/[^/]*:(\d+)(?:\/|$)/i.exec(cckUrl)?.[1]
}

export function shownText({ title, key, index, count, path }: Shown, claim = false) {
  const at = `"${title}" (${key ? `${key}, ` : ''}${index}/${count})`
  return claim ? `Card ${at} is ready. Write it to ${path}; the card refreshes on each save.` : `Shown ${at}`
}

let cck: Promise<string> | undefined

function cckDir($: EngineInterface) {
  cck ??= Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME'), $.env.get('USERPROFILE')]).then(
    ([configDir, home, userProfile]) => cckRoot(configDir, home, userProfile),
  )
  return cck
}

let target: Promise<{ url: string; terminalId: string } | undefined> | undefined

// Both vars come from ptyEnv, so only a session started in cck's embedded terminal has them.
function terminal($: EngineInterface) {
  target ??= Promise.all([$.env.get('CCK_URL'), $.env.get('CCK_TERMINAL_ID')]).then(([url, terminalId]) =>
    url && terminalId ? { url: url.replace(/\/+$/, ''), terminalId } : undefined,
  )
  return target
}

// Read on every post, the way cli.js reads it for dispatch: a restarted board writes a new token.
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

async function post($: EngineInterface, t: { url: string; terminalId: string }, input: ShowInput) {
  const token = await terminalToken($, t.url)
  if (!token) return { deny: `No terminal token for the cck server at ${t.url}. It must run with the terminal enabled.` }
  const { title, key, kind, file, base } = input
  const body = { sessionId: await $.session.id(), title, key, kind, file, base }
  const res = await send($, t.url, `/api/terminals/${encodeURIComponent(t.terminalId)}/show`, { 'x-terminal-token': token }, body)
  if ('deny' in res) return res
  return { result: shownText(JSON.parse(res.text) as Shown, file == null) }
}

// Read on every post, as the doorbell does, so a board that restarted on another port is found.
async function findBoard($: EngineInterface) {
  try {
    return boardUrl(undefined, await $.fs.read(`${await cckDir($)}/server.json`))
  } catch {
    return undefined
  }
}

export const CLAIM_OFF_TERMINAL =
  'No overlay here: write the card to a markdown or HTML file in your scratchpad directory, then call show again with file.'

export function paneText(title: string, added: boolean) {
  return added
    ? `Added "${title}" as a tab of this session on the cck board, in the background. Tell the user it waits there; the tab refreshes on each save.`
    : `The board already has a tab for this file; it refreshes on each save.`
}

async function postPane($: EngineInterface, { title, file }: ShowInput) {
  if (file == null) return { result: CLAIM_OFF_TERMINAL }
  const [url, sessionId] = await Promise.all([findBoard($), $.session.id()])
  if (!url) return { deny: 'The cck board is not running. Ask the user to start it, or give them the file path.' }
  const res = await send($, url, `/api/panes/${encodeURIComponent(sessionId)}`, {}, { target: file, title, show: true })
  if ('deny' in res) return res
  const { added } = JSON.parse(res.text) as { added: boolean }
  return { result: paneText(title, added) }
}

const WHEN =
  'Post one when the user asks you to show, draw or visualize something, or when your answer is a comparison of 4 or more rows, a flow, or numbers over time. Pick the form that makes the point best: a table, chart, diagram, mockup, small widget or a mix.'

const FILE = { type: 'string', description: 'Absolute path of an existing markdown, HTML, image or text file' }

const PANE_TOOL = {
  description: `Show a card as a tab of this session on the cck board. ${WHEN} Write the card to a markdown or HTML file in your scratchpad directory, then pass it as file; post again after a new file, and edit the same file to update its tab, which refreshes on each save. For an HTML card, load the claude-code-kanban:show skill first for the HTML contract. The tab opens in the background: in your reply, say what the card shows and that it waits on the board.`,
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string', description: 'Tab title' }, file: FILE },
    required: ['title', 'file'],
  },
}

const OVERLAY_TOOL = {
  description: `Show a card in the cck overlay above this terminal. ${WHEN} Give each card a key that names what it shows (for example latency-chart), and post again with that key to update the card in place instead of adding a new one. Without file, the tool answers with a path: write the card there with Write, and change it with Edit; the card refreshes on each save. Pass file to show a file that already exists. To explain code with a call stack or a tree, load the claude-code-kanban:show skill first for the notation. The user sees the rendered card and knows you do not; in your reply, say what the card shows, and take the render as given.`,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Card title' },
      kind: {
        type: 'string',
        enum: ['markdown', 'html'],
        description:
          'markdown (default): mermaid, diff and code fences render. html: a body fragment; load the claude-code-kanban:show skill first for the HTML contract',
      },
      file: FILE,
      key: { type: 'string', description: 'Card name: the same key replaces the card in place and keeps its file' },
      base: {
        type: 'string',
        description:
          "Absolute path of the folder that the card's path:line links resolve against, usually the repo root. Always pass it with a call stack. Without it, links resolve against the session cwd, which is wrong for a worktree or another repo",
      },
    },
    required: ['title'],
  },
}

// A -p run is detached from the terminal, so only an interactive session gets the tool.
export const register: Register = on => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.tool.register({ name: 'show', ...((await terminal($)) ? OVERLAY_TOOL : PANE_TOOL) })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ShowInput
    const t = await terminal($)
    return t ? post($, t, input) : postPane($, input)
  })
}

import type { EngineInterface, Register } from 'claude-code'
import { cckRoot } from './context'

export const TOOL = 'mcp__claude-code-kanban__show'
export const SKILL_LINE = /^\s*-\s*claude-code-kanban:show(?=:|\s*$)/

type ShowInput = { title: string; key?: string; kind?: 'markdown' | 'html'; file?: string }
type Shown = { title: string; key?: string | null; index: number; count: number; path?: string | null }

export function boardPort(cckUrl: string) {
  return /^[a-z]+:\/\/[^/]*:(\d+)(?:\/|$)/i.exec(cckUrl)?.[1]
}

export function shownText({ title, key, index, count, path }: Shown, claim = false) {
  const at = `"${title}" (${key ? `${key}, ` : ''}${index}/${count})`
  return claim ? `Card ${at} is ready. Write it to ${path}; the card refreshes on each save.` : `Shown ${at}`
}

export function dropSkillLine(listing: string) {
  return listing
    .split('\n')
    .filter(l => !SKILL_LINE.test(l))
    .join('\n')
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

async function post($: EngineInterface, input: ShowInput) {
  const t = await terminal($)
  if (!t) return { deny: 'The overlay needs a Claude Code session started in the cck terminal.' }
  const token = await terminalToken($, t.url)
  if (!token) return { deny: `No terminal token for the cck server at ${t.url}. It must run with the terminal enabled.` }
  const { title, key, kind, file } = input
  const body = JSON.stringify({ sessionId: await $.session.id(), title, key, kind, file })
  let res: Awaited<ReturnType<EngineInterface['http']['fetch']>>
  try {
    res = await $.http.fetch(`${t.url}/api/terminals/${encodeURIComponent(t.terminalId)}/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-terminal-token': token },
      body,
    })
  } catch (err) {
    return { deny: `Cannot reach cck at ${t.url}: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!res.ok) return { deny: errorText(res.status, res.text) }
  return { result: shownText(JSON.parse(res.text) as Shown, file == null) }
}

// A -p run is detached from the terminal, so only an interactive session gets the tool.
export const register: Register = on => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    if (await terminal($)) {
      await $.tool.register({
        name: 'show',
        description:
          'Show a card in the cck overlay above this terminal. Post one when the user asks you to show, draw or visualize something, or when your answer is a comparison of 4 or more rows, a flow, or numbers over time. Pick the form that makes the point best: a table, chart, diagram, mockup, small widget or a mix. Give each card a key that names what it shows (for example latency-chart), and post again with that key to update the card in place instead of adding a new one. Without file, the tool answers with a path: write the card there with Write, and change it with Edit; the card refreshes on each save. Pass file to show a file that already exists. To explain code with a call stack or a tree, load the claude-code-kanban:show skill first for the notation. The user sees the rendered card and knows you do not; in your reply, say what the card shows, and take the render as given.',
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
            file: { type: 'string', description: 'Absolute path of an existing markdown, HTML, image or text file' },
            key: { type: 'string', description: 'Card name: the same key replaces the card in place and keeps its file' },
          },
          required: ['title'],
        },
      })
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => post($, e as unknown as ShowInput))

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    if (await terminal($)) return next(e)
    return next({ ...e, text: dropSkillLine(e.text) })
  })
}

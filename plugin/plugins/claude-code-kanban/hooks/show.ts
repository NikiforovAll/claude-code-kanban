import type { EngineInterface, Register } from 'claude-code'
import { cckRoot } from './context'

export const TOOL = 'mcp__claude-code-kanban__show'
export const SKILL_LINE = /^\s*-\s*claude-code-kanban:show(?=:|\s*$)/

type ShowInput = { title: string; key?: string; kind?: 'markdown' | 'html'; content?: string; file?: string }
type Shown = { title: string; key?: string | null; index: number; count: number }

export function boardPort(cckUrl: string) {
  return /^[a-z]+:\/\/[^/]*:(\d+)(?:\/|$)/i.exec(cckUrl)?.[1]
}

export function shownText({ title, key, index, count }: Shown) {
  return `Shown "${title}" (${key ? `${key}, ` : ''}${index}/${count})`
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
  const { title, key, kind, content, file } = input
  const body = JSON.stringify({ sessionId: await $.session.id(), title, key, kind, content, file })
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
  return { result: shownText(JSON.parse(res.text) as Shown) }
}

// A -p run is detached from the terminal, so only an interactive session gets the tool.
export const register: Register = on => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    if (await terminal($)) {
      await $.tool.register({
        name: 'show',
        description:
          'Show a titled markdown or HTML card, or a file, in the cck overlay above this terminal. Load the claude-code-kanban:show skill first.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Card title' },
            kind: { type: 'string', enum: ['markdown', 'html'], description: 'Required with content' },
            content: { type: 'string', description: 'Markdown or an HTML body fragment, at most 64 KB' },
            file: { type: 'string', description: 'Absolute path of a file to show, instead of kind and content' },
            key: { type: 'string', description: 'Replaces the post with this key' },
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

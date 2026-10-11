// The supervisor's side of a swarm, run by the swarm skill from the session that started it
// (the store's parent).
//   node supervisor.mjs watch <listId>               one line per notice, for Claude Code's Monitor tool
//   node supervisor.mjs <command> <listId> ['<json>']  a store command as the supervisor
// The supervisor gets no swarm tools, so a session that never starts a swarm pays nothing for them.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { configDir } from './start.mjs'
import { CHANGES_FILE, compact, main } from './store.mjs'

const POLL_MS = 1500
export const SUMMARY_CHARS = 600

export function swarmRequest(listId, env = process.env) {
  if (!/^swarm-[a-z0-9-]+$/.test(listId ?? '')) throw new Error('give the swarm id (listId) that /swarm printed')
  const config = configDir(env)
  const dir = `${config}/.cck/swarm/${listId}`
  let registry
  try {
    registry = JSON.parse(fs.readFileSync(`${dir}/swarm.json`, 'utf8'))
  } catch {
    throw new Error(`no swarm ${listId} in ${config}`)
  }
  const id = env.CLAUDE_CODE_SESSION_ID
  if (!id || id !== registry.parent) throw new Error('only the session that started the swarm acts as its supervisor')
  return { dir, tasksDir: `${config}/tasks/${listId}`, base: registry.base, parent: registry.parent, roster: registry.workers, actor: { id } }
}

const oneLine = (text) => compact(String(text ?? '').replace(/\s+/g, ' ').trim(), SUMMARY_CHARS)

export function noticeLine(n) {
  switch (n.kind) {
    case 'complete':
      return `${n.worker} declared the goal complete under revision ${n.revision}: ${oneLine(n.summary)}`
    case 'blocked':
      return `${n.worker} is blocked: ${oneLine(n.summary)}`
    case 'stopped':
      return `${n.worker} stopped: ${oneLine(n.summary)}`
    default:
      return n.summary
  }
}

export async function watch(request, write = (line) => process.stdout.write(`${line}\n`), { pollMs = POLL_MS } = {}) {
  const changesFile = path.join(request.dir, CHANGES_FILE)
  let seen = ''
  for (;;) {
    let now = '-'
    try {
      now = fs.readFileSync(changesFile, 'utf8')
    } catch {}
    if (now !== seen) {
      let out
      try {
        out = main('notices', request)
      } catch (err) {
        out = { ok: false, error: err.message }
      }
      if (!out.ok) {
        write(`The swarm watch failed: ${out.error}`)
        return 1
      }
      seen = String(out.result.changes)
      for (const n of out.result.notices) write(noticeLine(n))
      if (out.result.ended) {
        write('The swarm has ended.')
        return 0
      }
    }
    await sleep(pollMs)
  }
}

export function command(name, request, json) {
  let args = {}
  if (json) {
    try {
      args = JSON.parse(json)
    } catch {
      throw new Error('the arguments must be one JSON object')
    }
  }
  return main(name, { idempotency_key: randomUUID(), ...args, ...request, cwd: process.cwd() })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [name, listId, json] = process.argv.slice(2)
  try {
    const request = swarmRequest(listId)
    if (name === 'watch') process.exitCode = await watch(request)
    else {
      const out = command(name, request, json)
      process.stdout.write(`${JSON.stringify(out)}\n`)
      if (!out.ok) process.exitCode = 1
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exitCode = 1
  }
}

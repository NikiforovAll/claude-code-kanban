// The supervisor's side of a swarm, run by the swarm skill from the session that started it
// (the store's parent).
//   node supervisor.mjs watch <listId>               one line per notice, for Claude Code's Monitor tool
//   node supervisor.mjs <command> <listId> ['<json>']  a store command as the supervisor
//   node supervisor.mjs board|stop [listId]          /swarm-status and /swarm-stop; the listId defaults to this session's running swarm
// The supervisor gets no swarm tools, so a session that never starts a swarm pays nothing for them.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { cck, configDir, storeRequest } from './start.mjs'
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
  return storeRequest(config, registry)
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

// The newest swarm this session started that has not ended.
export function ownSwarm(env = process.env) {
  const root = `${configDir(env)}/.cck/swarm`
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {}
  return names
    .flatMap((name) => {
      try {
        const r = JSON.parse(fs.readFileSync(`${root}/${name}/swarm.json`, 'utf8'))
        return r.parent === env.CLAUDE_CODE_SESSION_ID && r.state !== 'ended' ? [r] : []
      } catch {
        return []
      }
    })
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0]?.listId
}

export function boardText(listId, b) {
  const lines = [`Swarm ${listId}: ${b.state}, request revision ${b.request_revision}`]
  if (b.outcome) lines.push(`Ended ${b.outcome.outcome}: ${oneLine(b.outcome.summary)}`)
  for (const w of b.workers) {
    const on = w.dependency ? ` on ${w.dependency}` : ''
    lines.push(`  ${w.worker}: ${w.state}${on}${w.running ? ', in a turn' : ''}${w.summary ? `. ${oneLine(w.summary)}` : ''}`)
  }
  const { tasks, publications, findings } = b.collections
  lines.push(`Tasks ${tasks.total}, publications ${publications.total}, findings ${findings.total}`)
  for (const t of b.tasks.filter((x) => x.state !== 'done')) lines.push(`  #${t.task_id} ${t.state}${t.owner ? ` by ${t.owner}` : ''}: ${t.title}`)
  return lines.join('\n')
}

// DeLM's /delm-stop: stop the workers, confirm they ended, then end the swarm as stopped. A worker
// that still runs leaves the swarm running, so its work is never ended under it. The worktrees stay.
// Each poll spawns the cck CLI, which takes most of a second on Windows.
export async function stop(request, { run = cck, waitMs = 10_000, pollMs = 1000 } = {}) {
  const roster = (request.roster ?? []).filter((w) => w.sessionId)
  const running = () => {
    const live = new Set(JSON.parse(run(['dispatch', 'list', '--json'])).map((r) => r.session))
    return roster.filter((w) => live.has(w.sessionId))
  }
  for (const w of running()) run(['dispatch', 'end', w.sessionId, '--json'])
  let left = running()
  for (const end = Date.now() + waitMs; left.length && Date.now() < end; left = running()) await sleep(pollMs)
  if (left.length) {
    return { ok: false, error: `${left.map((w) => w.name).join(', ')} still running; the swarm keeps running. End them from the board, then run /swarm-stop again.` }
  }
  const reason = 'the supervisor stopped the swarm'
  for (const w of main('status', request).board.workers.filter((x) => x.state !== 'stopped')) {
    const out = main('worker_stop', { ...request, idempotency_key: `swarm-stop-${w.worker}`, worker: w.worker, reason })
    if (!out.ok) return out
  }
  return main('end', { ...request, idempotency_key: 'swarm-stop', outcome: 'stopped', summary: 'Stopped with /swarm-stop.' })
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
  const [name, given, json] = process.argv.slice(2)
  const ok = (out) => {
    if (!out.ok) throw new Error(out.error)
    return out
  }
  const own = {
    board: async (listId, request) => boardText(listId, ok(main('status', request)).board),
    stop: async (listId, request) => {
      ok(await stop(request))
      return `Stopped swarm ${listId}. Its workers ended; their worktrees and the board stay.`
    },
  }[name]
  try {
    const listId = given ?? (own ? ownSwarm() : undefined)
    if (own) process.stdout.write(`${listId ? await own(listId, swarmRequest(listId)) : 'No swarm is running in this session.'}\n`)
    else if (name === 'watch') process.exitCode = await watch(swarmRequest(listId))
    else {
      const out = command(name, swarmRequest(listId), json)
      process.stdout.write(`${JSON.stringify(out)}\n`)
      if (!out.ok) process.exitCode = 1
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exitCode = 1
  }
}

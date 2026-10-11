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
import { cleanup, deliver, NOT_DELIVERED, preserve, worktreeRoot, worktrees } from './deliver.mjs'
import { readJson, writeJson } from './files.mjs'
import { cck, configDir, storeRequest } from './start.mjs'
import { CHANGES_FILE, compact, END_OUTCOMES, main } from './store.mjs'

const POLL_MS = 1500
const FINISH_OUTCOMES = END_OUTCOMES.filter((o) => o !== 'delivery_conflict')
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
// The board view lists open tasks first, so a full view shows every open task it can.
const openTasks = (board) => board.tasks.filter((t) => t.state !== 'done')
const taskRows = (tasks) => tasks.map((t) => `#${t.task_id} ${t.state}${t.owner ? ` by ${t.owner}` : ''}: ${oneLine(t.title)}`).join('; ')

export function noticeLine(n) {
  switch (n.kind) {
    case 'complete':
      return `${n.worker} declared the goal complete under revision ${n.revision}: ${oneLine(n.summary)}${n.open?.length ? ` Open tasks to review: ${taskRows(n.open)}.` : ''}`
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

// DeLM's end of a run: stop the workers and confirm they ended, then deliver the candidate's result
// (complete) or save every worker's changes to a recovery bundle (partial, stopped), remove the
// worktrees and end the swarm. A worker that still runs leaves the swarm running, so its work is
// never ended under it. <dir>/result.json is written before the first write to the project, so a
// rerun finishes the end that run chose, whatever outcome it is given.
// Each poll spawns the cck CLI, which takes most of a second on Windows.
export async function finish(request, { outcome, summary }, { run = cck, waitMs = 10_000, pollMs = 1000, cwd = process.cwd() } = {}) {
  const resultFile = path.join(request.dir, 'result.json')
  let result = readJson(resultFile)
  const registry = readJson(path.join(request.dir, 'swarm.json'))
  if (!registry.project) return { ok: false, error: 'this swarm has no project path in swarm.json; start a new swarm' }
  // On Windows a shell whose cwd is in a worktree locks it, and the cleanup fails after delivery.
  const inside = path.relative(worktreeRoot(registry.project), cwd)
  if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) return { ok: false, error: `your shell's working directory ${cwd} is inside a worker's worktree, which blocks its removal; cd to ${registry.project} and run this again` }
  if (!result) {
    if (!FINISH_OUTCOMES.includes(outcome)) return { ok: false, error: `outcome must be ${FINISH_OUTCOMES.join(', ')}` }
    if (typeof summary !== 'string' || !summary.trim()) return { ok: false, error: 'give the summary' }
    const status = main('status', request)
    if (!status.ok) return status
    if (status.board.state === 'ended') return { ok: false, error: 'This swarm has ended.' }
    const { candidate } = status.board
    if (outcome === 'complete' && !candidate) {
      return { ok: false, error: 'no worker declared the goal complete under the current request revision; send a request, or end the swarm as partial' }
    }
    const open = openTasks(status.board)
    if (outcome === 'complete' && open.length) {
      return { ok: false, error: `review the open tasks first: ${taskRows(open)}. Close each moot one with task_close and a reason (task_release a claimed one first), or send a request for the work it names.` }
    }
    const roster = (request.roster ?? []).filter((w) => w.sessionId)
    const running = () => {
      const live = new Set(JSON.parse(run(['dispatch', 'list', '--json'])).map((r) => r.session))
      return roster.filter((w) => live.has(w.sessionId))
    }
    for (const w of running()) run(['dispatch', 'end', w.sessionId, '--json'])
    let left = running()
    for (const end = Date.now() + waitMs; left.length && Date.now() < end; left = running()) await sleep(pollMs)
    if (left.length) return { ok: false, error: `${left.map((w) => w.name).join(', ')} still running; the swarm keeps running. End them from the board, then run this again.` }
    const reason = outcome === 'stopped' ? 'the supervisor stopped the swarm' : `the supervisor ended the swarm as ${outcome}`
    for (const w of status.board.workers.filter((x) => x.state !== 'stopped')) {
      const out = main('worker_stop', { ...request, idempotency_key: `swarm-finish-${w.worker}`, worker: w.worker, reason })
      if (!out.ok) return out
    }
    // Stopping the workers released their claims. A task left open would stay pending on the board.
    for (let board = main('status', request).board, left = openTasks(board); left.length; left = openTasks(board)) {
      for (const t of left) {
        const out = main('task_close', { ...request, idempotency_key: `swarm-finish-${outcome}-task-${t.task_id}`, task_id: t.task_id, reason: `the swarm ended as ${outcome}` })
        if (!out.ok) return out
        board = out.board
      }
    }
    const { project, base } = registry
    const trees = worktrees(project, roster.map((w) => w.name))
    if (outcome === 'complete' && !trees[candidate.worker]) return { ok: false, error: `the worktree of ${candidate.worker} is gone; end the swarm as partial` }
    result = { outcome, summary, worker: candidate?.worker ?? null, artifacts: candidate?.artifacts ?? [], project, base, trees }
    writeJson(resultFile, result)
  }
  if (!result.delivery) {
    const { project, base, trees, artifacts } = result
    let delivery = NOT_DELIVERED
    if (result.outcome === 'complete') delivery = deliver({ dir: request.dir, project, base, wt: trees[result.worker].path, artifacts })
    if (!delivery.delivered) delivery = { ...delivery, recovery: preserve({ dir: request.dir, project, base, trees, artifacts }) }
    result = { ...result, outcome: delivery.conflicts.length ? 'delivery_conflict' : result.outcome, delivery }
    writeJson(resultFile, result)
  }
  cleanup(result.project, result.trees)
  const out = main('end', { ...request, idempotency_key: 'swarm-finish', outcome: result.outcome, summary: result.summary })
  const { delivery, ...rest } = result
  return out.ok ? { ok: true, result: { ...rest, ...delivery } } : out
}

const list = (paths, max = 20) => (paths.length > max ? `${paths.slice(0, max).join(', ')} and ${paths.length - max} more` : paths.join(', '))

// DeLM's final report (src/run/mod.rs:478-510).
export function resultText(listId, r) {
  if (r.outcome === 'delivery_conflict') {
    return `Not delivered. Delivery needs conflict resolution for: ${list(r.conflicts)}. Your edits and the proposed changes are preserved in ${r.recovery}. Swarm ${listId} ended as delivery_conflict.`
  }
  if (!r.delivered) return `Swarm ${listId} ended as ${r.outcome}. Every worker's changes are saved in ${r.recovery}; the worktrees are removed.`
  const lines = [r.changed.length ? `Delivered ${r.changed.length} file${r.changed.length === 1 ? '' : 's'} from ${r.worker} into ${r.project}: ${list(r.changed)}.` : `The result of ${r.worker} changes no file in ${r.project}.`]
  if (r.merged.length || r.environment_files_changed.length) {
    lines.push(`Run the needed local setup or a focused check before you report it ready. Merged with your edits: ${list(r.merged) || 'none'}. Environment files changed: ${list(r.environment_files_changed) || 'none'}.`)
  }
  const excluded = Object.keys(r.excluded)
  if (excluded.length) lines.push(`Not delivered: ${list(excluded)} (recognized credentials).`)
  if (r.recovery) lines.push(`The versions it replaced are in ${r.recovery}.`)
  lines.push(`Swarm ${listId} ended as complete; the worktrees are removed.`)
  return lines.join('\n')
}

function parseArgs(json) {
  if (!json) return {}
  try {
    return JSON.parse(json)
  } catch {
    throw new Error('the arguments must be one JSON object')
  }
}

export function command(name, request, json) {
  return main(name, { idempotency_key: randomUUID(), ...parseArgs(json), ...request, cwd: process.cwd() })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [name, given, json] = process.argv.slice(2)
  const ok = (out) => {
    if (!out.ok) throw new Error(out.error)
    return out
  }
  const own = {
    board: async (listId, request) => boardText(listId, ok(main('status', request)).board),
    stop: async (listId, request) => resultText(listId, ok(await finish(request, { outcome: 'stopped', summary: 'Stopped with /swarm-stop.' })).result),
    end: async (listId, request) => resultText(listId, ok(await finish(request, parseArgs(json))).result),
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

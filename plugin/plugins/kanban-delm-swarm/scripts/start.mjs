// Starts a swarm: claims a folder and a task list unique to this start, writes the registry,
// stores the supervisor's spec as request revision 1, then has cck dispatch the workers.
// Run by the swarm skill from the parent session.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renameRetry } from './files.mjs'
import { main } from './store.mjs'

// DeLM's research harness runs 2 or 4 workers; its product runs 2.
const MIN_WORKERS = 2
const MAX_WORKERS = 4
const DAY_MS = 86_400_000
const DEFAULT_CLEANUP_DAYS = 30
const WORKER_POLICY = new URL('../worker.md', import.meta.url)

// The same formula as hooks/swarm.ts, so the parent and the workers name the same folder.
export const configDir = (env = process.env) =>
  (env.CLAUDE_CONFIG_DIR || `${env.HOME ?? env.USERPROFILE}/.claude`).replaceAll('\\', '/')

export const slug = (goal) =>
  goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 24).replace(/-+$/, '') || 'goal'

// The mkdir is the claim, so two starts never share a folder, a store or a registry.
// A task list of that name already on disk belongs to someone else, so it is skipped too.
export function claim(config, goal, suffix = () => randomBytes(3).toString('hex')) {
  const root = `${config}/.cck/swarm`
  fs.mkdirSync(root, { recursive: true })
  for (let i = 0; i < 20; i++) {
    const hex = suffix()
    const listId = `swarm-${slug(goal)}-${hex}`
    if (fs.existsSync(`${config}/tasks/${listId}`)) continue
    try {
      fs.mkdirSync(`${root}/${listId}`)
      return { listId, suffix: hex, dir: `${root}/${listId}` }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
  throw new Error('no free swarm id after 20 tries')
}

// Swarm folders are plugin state under .cck/, kept as long as Claude Code keeps transcripts
// (cleanupPeriodDays), counted from the last write to any file in the folder.
export function prune(config, now = Date.now()) {
  const root = `${config}/.cck/swarm`
  let days
  try {
    days = JSON.parse(fs.readFileSync(`${config}/settings.json`, 'utf8')).cleanupPeriodDays
  } catch {}
  const maxAgeMs = (Number.isInteger(days) && days > 0 ? days : DEFAULT_CLEANUP_DAYS) * DAY_MS
  const removed = []
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {}
  for (const name of names) {
    const dir = `${root}/${name}`
    try {
      const at = Math.max(fs.statSync(dir).mtimeMs, ...fs.readdirSync(dir).map((f) => fs.statSync(`${dir}/${f}`).mtimeMs))
      if (now - at > maxAgeMs) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed.push(name)
      }
    } catch {}
  }
  return removed
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameRetry(tmp, file)
}

// CCK_CLI names a cck checkout's server.js. Else the claude-code-kanban on PATH, which on
// Windows is an npm .cmd shim that Node runs only through a shell.
function cck(args) {
  const local = process.env.CCK_CLI
  const win = process.platform === 'win32' && !local
  const [cmd, argv] = local ? [process.execPath, [local, ...args]] : ['claude-code-kanban', win ? args.map((a) => `"${a}"`) : args]
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', shell: win, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    throw new Error(`claude-code-kanban ${args.slice(0, 2).join(' ')} failed: ${String(err.stderr || err.message).trim()}`)
  }
}

export function groupPath(groups, sessionId) {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const names = []
  let g = groups.find((x) => !x.dispatch && x.members?.some((m) => m.type === 'session' && m.ref === sessionId))
  for (; g; g = byId.get(g.parent)) names.unshift(g.name)
  return names.join('/')
}

// DeLM's research prompts (STARTUP_A and STARTUP_B): the first worker in the roster makes the
// first split, so no planner or planning gate stands between the request and the work.
const FIRST_SPLIT =
  'You are first in the roster, so you make the first split. Inspect the request and just enough of the project to choose the simplest approach. Then create tasks that give every peer ready, nonoverlapping work, with the inputs, the interfaces and the first usable dependency. Do not wait for a whole plan: claim your own part and implement it in this same turn. Add the remaining work as it becomes clear.'
const AFTER_SPLIT = (first) =>
  `${first} makes the first split. Meanwhile, explore the entry point and the environment the result runs in, and share findings that change the implementation or show a missing prerequisite. As soon as a ready task is on the board, claim it and implement it in this same turn. After that, you can also create tasks for distinct required work.`

// The store request the supervisor's commands run with.
export const storeRequest = (config, registry) => ({
  dir: `${config}/.cck/swarm/${registry.listId}`,
  tasksDir: `${config}/tasks/${registry.listId}`,
  base: registry.base,
  parent: registry.parent,
  roster: registry.workers,
  actor: { id: registry.parent },
})

function transcriptPath(sessionId) {
  try {
    return JSON.parse(cck(['session', 'view', sessionId, '--json'])).jsonlPath ?? null
  } catch {
    return null
  }
}

export function workerSpec({ spec, name, listId, names, transcript }) {
  const peers = names.filter((n) => n !== name)
  return [
    `# Swarm worker ${name}`,
    '',
    `You are one of ${names.length} workers on one request in swarm ${listId}. Peers: ${peers.join(', ') || 'none'}. No one leads: you coordinate through the shared board with the swarm_* tools.`,
    '',
    name === names[0] ? FIRST_SPLIT : AFTER_SPLIT(names[0]),
    '',
    '## Request (revision 1)',
    '',
    spec,
    '',
    ...(transcript ? [`The supervisor wrote this request from its conversation with the user: ${transcript}. Read it only when the request leaves a question open.`, ''] : []),
    '## How to work',
    '',
    fs.readFileSync(WORKER_POLICY, 'utf8').trim(),
    '',
    "The board shows the swarm's tasks. Change them only through the swarm tools.",
  ].join('\n')
}

export function start({ goal, spec: rawSpec, n = 2, cwd = process.cwd(), env = process.env }) {
  const spec = rawSpec?.trim()
  if (!goal?.trim()) throw new Error('give the goal')
  if (!spec) throw new Error('give the spec with --spec-file')
  if (!Number.isInteger(n) || n < MIN_WORKERS || n > MAX_WORKERS) throw new Error(`--n must be ${MIN_WORKERS} to ${MAX_WORKERS}`)
  const parent = env.CLAUDE_CODE_SESSION_ID
  if (!parent) throw new Error('run /swarm from a Claude Code session')
  let base
  try {
    base = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    throw new Error(`${cwd} is not a git repository with a commit: each worker runs in its own worktree`)
  }
  const config = configDir(env)
  prune(config)
  const { listId, suffix, dir } = claim(config, goal)
  const group = [groupPath(JSON.parse(cck(['group', 'list', '--all', '--json'])).groups, parent), listId].filter(Boolean).join('/')
  const workers = Array.from({ length: n }, (_, i) => ({ name: `w${i + 1}-${suffix}` }))
  const registry = { listId, group, goal: goal.trim(), parent, base, workers, state: 'running', startedAt: new Date().toISOString() }
  const stored = main('spec', { ...storeRequest(config, registry), text: spec })
  if (!stored.ok) throw new Error(`the spec: ${stored.error}`)
  writeJson(`${dir}/swarm.json`, registry)
  // Made before the first dispatch: a user group named like the dispatch group takes its
  // sessions in from the first frame, so they never jump between groups.
  cck(['group', 'create', group, '--json'])
  const names = workers.map((w) => w.name)
  const transcript = transcriptPath(parent)
  for (const w of workers) {
    const specFile = `${dir}/spec-${w.name}.md`
    fs.writeFileSync(specFile, `${workerSpec({ spec, name: w.name, listId, names, transcript })}\n`)
    let out
    try {
      out = JSON.parse(
        cck(['dispatch', 'start', '--cwd', cwd, '--spec-file', specFile, '--name', w.name, '--group', listId, '--task-list', listId, '--worktree', w.name, '--json']),
      )
    } catch (err) {
      // With no worker running, nothing would ever end the swarm; workers already started keep it.
      if (!workers.some((x) => x.sessionId)) {
        writeJson(`${dir}/swarm.json`, { ...registry, state: 'ended' })
        try {
          cck(['group', 'rm', group, '--json'])
        } catch {}
      }
      throw err
    }
    w.sessionId = out.session
    writeJson(`${dir}/swarm.json`, registry)
    cck(['session', 'group', w.sessionId, group, '--parent', parent, '--json'])
  }
  return { listId, dir, group, workers }
}

function parseArgs(argv) {
  const out = { goal: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--n') out.n = Number(argv[++i])
    else if (a === '--spec-file') out.spec = fs.readFileSync(argv[++i], 'utf8')
    else if (a === '--cwd') out.cwd = argv[++i]
    else out.goal.push(a)
  }
  return { ...out, goal: out.goal.join(' ') }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(start(parseArgs(process.argv.slice(2))), null, 2)}\n`)
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exitCode = 1
  }
}

// Starts a swarm: claims a folder and a task list unique to this start, writes the registry,
// stores the supervisor's spec as request revision 1, then has cck dispatch the workers.
// Run by the swarm skill from the parent session.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { worktreeRoot } from './deliver.mjs'
import { configDir, readJson, writeJson } from './files.mjs'
import { workerNames } from './names.mjs'
import { main } from './store.mjs'

// DeLM's research harness runs 2 or 4 workers; its product runs 2.
const MIN_WORKERS = 2
const MAX_WORKERS = 4
const DAY_MS = 86_400_000
const DEFAULT_CLEANUP_DAYS = 30
const WORKER_POLICY = new URL('../worker.md', import.meta.url)

export { configDir }

export const slug = (goal) =>
  goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 24).replace(/-+$/, '') || 'goal'

// The mkdir is the claim, so two starts never share a folder, a store or a registry. The id also
// names the task list and the group, so a name either already holds is refused too.
export function claim(config, listId, groups = []) {
  const root = `${config}/.cck/swarm`
  fs.mkdirSync(root, { recursive: true })
  let holder = fs.existsSync(`${config}/tasks/${listId}`) ? 'a task list' : groups.some((g) => g.name === listId) ? 'a group' : null
  if (!holder) {
    try {
      fs.mkdirSync(`${root}/${listId}`)
      return { listId, dir: `${root}/${listId}` }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      holder = 'another swarm'
    }
  }
  throw new Error(`the swarm name ${listId} is taken by ${holder}; run start again with --name <another short name>`)
}

// A worker's name is its peer name and its worktree, so it must be free among the live dispatches
// and the project's leftover worktrees and worktree-<name> branches.
function takenWorkerNames(project) {
  const live = JSON.parse(cck(['dispatch', 'list', '--all', '--json'])).map((d) => d.name)
  const branches = execFileSync('git', ['-C', project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((b) => b.slice('worktree-'.length))
  let trees = []
  try {
    trees = fs.readdirSync(worktreeRoot(project))
  } catch {}
  return new Set([...live, ...branches, ...trees])
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

// CCK_CLI names a cck checkout's server.js. Else the claude-code-kanban on PATH, which on
// Windows is an npm .cmd shim that Node runs only through a shell.
export function cck(args) {
  const local = process.env.CCK_CLI
  const win = process.platform === 'win32' && !local
  const [cmd, argv] = local ? [process.execPath, [local, ...args]] : ['claude-code-kanban', win ? args.map((a) => `"${a}"`) : args]
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', shell: win, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    throw new Error(`claude-code-kanban ${args.slice(0, 2).join(' ')} failed: ${String(err.stderr || err.message).trim()}`)
  }
}

export function checkCck() {
  try {
    cck(['--version'])
  } catch (err) {
    throw new Error(`the swarm needs the claude-code-kanban CLI: install it with \`npm install -g claude-code-kanban\`, or set CCK_CLI to a cck checkout's server.js.\n${err.message}`)
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

// cck shows a session the task list that _task-maps maps it to, one list per session. The
// workers' plugin mod maps them; this maps the supervisor before they start, as their mod
// rewrites the file read-modify-write.
export function mapSupervisor(config, listId, sessionId, project) {
  const root = `${config}/.cck/agent-activity/_task-maps`
  fs.mkdirSync(root, { recursive: true })
  for (const name of fs.readdirSync(root).filter((f) => f.endsWith('.json') && f !== `${listId}.json`)) {
    const map = readJson(`${root}/${name}`)
    if (!map?.[sessionId]) continue
    delete map[sessionId]
    if (Object.keys(map).length) writeJson(`${root}/${name}`, map)
    else fs.rmSync(`${root}/${name}`, { force: true })
  }
  writeJson(`${root}/${listId}.json`, { ...readJson(`${root}/${listId}.json`), [sessionId]: { project, updatedAt: new Date().toISOString() } })
}

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

export const dispatchArgs = ({ cwd, specFile, name, listId, model, claudeArgs = [] }) => [
  ...['dispatch', 'start', '--cwd', cwd, '--spec-file', specFile, '--name', name, '--group', listId, '--task-list', listId, '--worktree', name, '--json'],
  ...(model ? ['--model', model] : []),
  ...(claudeArgs.length ? ['--', ...claudeArgs] : []),
]

export function start({ goal, name, spec: rawSpec, n = 2, cwd = process.cwd(), env = process.env, model, claudeArgs = [] }) {
  const spec = rawSpec?.trim()
  if (!goal?.trim()) throw new Error('give the goal')
  if (!spec) throw new Error('give the spec with --spec-file')
  if (!Number.isInteger(n) || n < MIN_WORKERS || n > MAX_WORKERS) throw new Error(`--n must be ${MIN_WORKERS} to ${MAX_WORKERS}`)
  const parent = env.CLAUDE_CODE_SESSION_ID
  if (!parent) throw new Error('run /swarm from a Claude Code session')
  let project
  let base
  try {
    ;[project, base] = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\r?\n/)
  } catch {
    throw new Error(`${cwd} is not a git repository with a commit: each worker runs in its own worktree`)
  }
  checkCck()
  const config = configDir(env)
  prune(config)
  const { groups } = JSON.parse(cck(['group', 'list', '--all', '--json']))
  const workers = workerNames(n, takenWorkerNames(project)).map((w) => ({ name: w }))
  const { listId, dir } = claim(config, `swarm-${slug(name?.trim() || goal)}`, groups)
  const group = [groupPath(groups, parent), listId].filter(Boolean).join('/')
  const registry = { listId, group, goal: goal.trim(), parent, project, base, workers, state: 'running', startedAt: new Date().toISOString() }
  const stored = main('spec', { ...storeRequest(config, registry), text: spec })
  if (!stored.ok) throw new Error(`the spec: ${stored.error}`)
  writeJson(`${dir}/swarm.json`, registry)
  mapSupervisor(config, listId, parent, project)
  // Made before the first dispatch: a user group named like the dispatch group takes its
  // sessions in from the first frame, so they never jump between groups.
  cck(['group', 'create', group, '--json'])
  // The workers show indented under the supervisor only when it is in their group.
  cck(['session', 'group', parent, group, '--json'])
  const names = workers.map((w) => w.name)
  const transcript = transcriptPath(parent)
  for (const w of workers) {
    const specFile = `${dir}/spec-${w.name}.md`
    fs.writeFileSync(specFile, `${workerSpec({ spec, name: w.name, listId, names, transcript })}\n`)
    let out
    try {
      out = JSON.parse(
        cck(dispatchArgs({ cwd, specFile, name: w.name, listId, model, claudeArgs })),
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
    if (a === '--') {
      out.claudeArgs = argv.slice(i + 1)
      break
    }
    if (a === '--n') out.n = Number(argv[++i])
    else if (a === '--spec-file') out.spec = fs.readFileSync(argv[++i], 'utf8')
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--model') out.model = argv[++i]
    else if (a === '--name') out.name = argv[++i]
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

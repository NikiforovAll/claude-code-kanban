// The trivial end-to-end run of a swarm on a toy project. See README.md for the run book.
//   node e2e.mjs setup                              a fresh toy repo at <root>/repo
//   node e2e.mjs supervise [--n 2] [--model sonnet] [--stop] [-- <claude args>]  dispatches a supervisor session that runs start
//   node e2e.mjs start [--n 2] [--model sonnet] [-- <claude args>]   a swarm on it, with this session as the supervisor
//   node e2e.mjs conflict                           the user edits a line the workers change
//   node e2e.mjs report [listId]                    wall time, outcome, timeline and leftovers of a run
//   node e2e.mjs clean                              removes the repo's leftover worktrees and branches
// <root> is SWARM_E2E_ROOT, else kanban-swarm-e2e in the temp dir.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDir } from '../scripts/files.mjs'
import { cck } from '../scripts/start.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE).replaceAll('\\', '/')
const SCRIPTS = `${PLUGIN}/scripts`
const ROOT = (process.env.SWARM_E2E_ROOT ?? path.join(fs.realpathSync.native(os.tmpdir()), 'kanban-swarm-e2e')).replaceAll('\\', '/')
const REPO = `${ROOT}/repo`
const RUNS = `${ROOT}/runs.json`
const GOAL = 'String helpers'
const STUB = "throw new Error('slugify is not implemented')"
const { logRow, nameMap, ms } = createRequire(import.meta.url)('../viewer/lib/events.js')

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const node = (script, args) => spawnSync(process.execPath, [`${SCRIPTS}/${script}`, ...args], { encoding: 'utf8' })
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const runs = () => readJson(RUNS) ?? []

function leftovers() {
  const trees = git('worktree', 'list', '--porcelain')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9))
    .slice(1)
  const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-*').split('\n').filter(Boolean)
  return { trees, branches }
}

function setup() {
  if (fs.existsSync(`${REPO}/.git`) && leftovers().trees.length) throw new Error(`${REPO} still has swarm worktrees; run clean first`)
  fs.rmSync(REPO, { recursive: true, force: true })
  fs.cpSync(`${HERE}/fixture/project`, REPO, { recursive: true })
  fs.writeFileSync(`${REPO}/.gitignore`, 'node_modules/\n.claude/\n')
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=swarm-e2e', '-c', 'user.email=swarm-e2e@localhost', 'commit', '-qm', 'toy project')
  return `A fresh toy repo at ${REPO} (base ${git('rev-parse', '--short', 'HEAD')}). Next: node e2e.mjs supervise`
}

function split(argv) {
  const cut = argv.indexOf('--')
  return cut < 0 ? { own: argv, given: [] } : { own: argv.slice(0, cut), given: argv.slice(cut + 1) }
}
const opt = (own, name, fallback) => (own.includes(name) ? own[own.indexOf(name) + 1] : fallback)

function start(argv) {
  if (!process.env.CLAUDE_CODE_SESSION_ID) throw new Error('run start from the Claude Code session that supervises the swarm')
  const { own, given } = split(argv)
  const claudeArgs = ['--plugin-dir', PLUGIN, ...(given.length ? given : ['--permission-mode', 'auto'])]
  const out = node('start.mjs', ['--n', opt(own, '--n', '2'), '--model', opt(own, '--model', 'sonnet'), '--cwd', REPO, '--spec-file', `${HERE}/fixture/spec.md`, GOAL, '--', ...claudeArgs])
  if (out.status !== 0) throw new Error(out.stderr.trim())
  const started = JSON.parse(out.stdout)
  fs.writeFileSync(RUNS, JSON.stringify([...runs(), { listId: started.listId, config: configDir(process.env), at: new Date().toISOString() }], null, 2))
  return [
    out.stdout.trim(),
    '',
    `Watch: node "${SCRIPTS}/supervisor.mjs" watch ${started.listId} 2>&1`,
    `Viewer: follow ${PLUGIN}/skills/swarm-viewer/SKILL.md with ${started.listId}`,
  ].join('\n')
}

// The supervisor is a dispatched session with the plugin loaded, so /swarm-status and /swarm-stop
// work in it.
function supervise(argv) {
  const stop = argv.includes('--stop')
  argv = argv.filter((a) => a !== '--stop')
  const { own, given } = split(argv)
  const startArgs = argv.join(' ')
  const specFile = `${ROOT}/supervisor.md`
  fs.writeFileSync(
    specFile,
    [
      '# Swarm e2e supervisor',
      '',
      'You supervise one swarm on a toy project, an end-to-end check of the kanban-delm-swarm plugin. The user watches and may step in.',
      '',
      `1. Run \`node "${HERE}/e2e.mjs" start ${startArgs}\` and report its output. On an error, report it and stop.`,
      `2. Follow ${PLUGIN}/skills/swarm/SKILL.md from step 3 to the end, with the base directory ${PLUGIN}/skills/swarm.`,
      stop
        ? `3. This run checks the stop path. Right after start, run \`node "${SCRIPTS}/supervisor.mjs" status <listId>\` every 5 s. As soon as a task is claimed, end the swarm as stopped.`
        : "3. On a complete notice, run `npm test` in the candidate worker's worktree. End the swarm as complete when it passes; else send a request.",
      `4. After the swarm ends, run \`node "${HERE}/e2e.mjs" report\`, report its output, and stop.`,
    ].join('\n'),
  )
  const out = JSON.parse(
    cck(['dispatch', 'start', '--cwd', REPO, '--spec-file', specFile, '--name', `swarm-e2e-${Date.now().toString(36)}`, '--model', opt(own, '--model', 'sonnet'), '--json', '--', '--plugin-dir', PLUGIN, ...(given.length ? given : ['--permission-mode', 'auto'])]),
  )
  return `Dispatched the supervisor, session ${out.session}. Follow it on the board.`
}

function conflict() {
  const file = `${REPO}/src/slugify.js`
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes(STUB)) throw new Error(`${file} no longer has the stub line; the conflict needs it unchanged in the repo`)
  fs.writeFileSync(file, text.replace(STUB, "throw new Error('slugify: edited by the user during the run')"))
  return `Edited the stub line of ${file}. A delivery of a slugify change now conflicts.`
}

const clock = (from, t) => {
  const s = Math.max(0, Math.round((t - from) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function report(listId = runs().at(-1)?.listId) {
  if (!listId) throw new Error('no run yet; give the listId')
  const dir = `${configDir(process.env)}/.cck/swarm/${listId}`
  const registry = readJson(`${dir}/swarm.json`)
  if (!registry) throw new Error(`no swarm ${listId} in ${configDir(process.env)}`)
  const result = readJson(`${dir}/result.json`)
  const exported = node('supervisor.mjs', ['export', listId])
  const parsed = JSON.parse(exported.stdout || '{}')
  const events = parsed.events ?? parsed.result?.events ?? []
  const from = Date.parse(registry.startedAt)
  const end = events.find((e) => e.kind === 'end')
  const names = nameMap(events, registry)
  const tests = spawnSync(process.execPath, ['--test'], { cwd: REPO, encoding: 'utf8' })
  const { trees, branches } = leftovers()
  const d = result?.delivery
  const lines = [
    `# Swarm e2e: ${listId}`,
    '',
    `- Workers: ${registry.workers.map((w) => w.name).join(', ')}`,
    `- State: ${registry.state}; outcome: ${result?.outcome ?? 'none yet'}`,
    `- Wall time: ${end ? clock(from, ms(end.ts)) : `${clock(from, Date.now())} so far`}`,
    ...(d ? [`- Delivered: ${d.delivered}; changed: ${d.changed.join(', ') || 'none'}; merged: ${d.merged.join(', ') || 'none'}; conflicts: ${d.conflicts.join(', ') || 'none'}`, `- Recovery: ${d.recovery ?? 'none'}`] : []),
    `- node --test in the repo: ${tests.status === 0 ? 'pass' : `fail (exit ${tests.status})`}`,
    `- git status: ${git('status', '--short').split('\n').filter(Boolean).join('; ') || 'clean'}`,
    `- Leftover worktrees: ${trees.join(', ') || 'none'}; branches: ${branches.join(', ') || 'none'}`,
    ...(exported.status === 0 ? [] : [`- Export failed: ${exported.stderr.trim()}`]),
    '',
    '## Timeline',
    '',
    ...events.map((e) => {
      const r = logRow(e, names)
      return `- ${clock(from, r.t)} ${r.who}: ${r.text}`
    }),
  ]
  const text = `${lines.join('\n')}\n`
  fs.writeFileSync(`${ROOT}/report-${listId}.md`, text)
  return `${text}\nSaved to ${ROOT}/report-${listId}.md`
}

function clean() {
  const { trees, branches } = leftovers()
  for (const t of trees) git('worktree', 'remove', '--force', t)
  if (branches.length) git('branch', '-D', ...branches)
  git('worktree', 'prune')
  return `Removed ${trees.length} worktrees and ${branches.length} branches from ${REPO}.`
}

const [cmd, ...rest] = process.argv.slice(2)
const commands = { setup, supervise: () => supervise(rest), start: () => start(rest), conflict, report: () => report(rest[0]), clean }
try {
  if (!commands[cmd]) throw new Error(`usage: node e2e.mjs ${Object.keys(commands).join('|')}`)
  fs.mkdirSync(ROOT, { recursive: true })
  process.stdout.write(`${commands[cmd]()}\n`)
} catch (err) {
  process.stderr.write(`${err.message}\n`)
  process.exitCode = 1
}

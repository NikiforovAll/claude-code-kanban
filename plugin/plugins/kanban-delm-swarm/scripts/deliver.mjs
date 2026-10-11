// The end of a swarm in the user's project, after DeLM's src/workspace/delivery.rs. Every file is
// planned against the start commit before any write; a conflict on any file writes nothing. The
// Git index and HEAD of the project are never touched. The caller stops every worker first.
import { isUtf8 } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readJson, renameRetry, writeJson } from './files.mjs'

// DeLM's text_merge limit and its recognized_credential and environment_manifest lists.
const MERGE_LIMIT = 8 * 1024 * 1024
const CREDENTIAL_NAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa', '.netrc', 'credentials.json', 'auth.json']
const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template']
const PRIVATE_KEY = /-----BEGIN (?:ENCRYPTED |RSA |DSA |OPENSSH |EC )?PRIVATE KEY-----/
const ENVIRONMENT_FILES = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'pyproject.toml',
  'uv.lock',
  'Pipfile',
  'Pipfile.lock',
  'poetry.lock',
  'environment.yml',
  'environment.yaml',
  'Gemfile',
  'Gemfile.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
]
const MAX_BUFFER = 1024 * 1024 * 1024

export const NOT_DELIVERED = Object.freeze({ delivered: false, changed: [], merged: [], conflicts: [], excluded: {}, environment_files_changed: [], recovery: null })

const sha256 = (data) => (data ? createHash('sha256').update(data).digest('hex') : null)
const same = (a, b) => (a && b ? a.equals(b) : a === b)
const names = (out) => out.split('\0').filter(Boolean)

function git(cwd, args, encoding = 'utf8') {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER })
  } catch (err) {
    throw new Error(`git ${args[0]} failed in ${cwd}: ${String(err.stderr || err.message).trim()}`)
  }
}

function credential(p, data) {
  const name = path.posix.basename(p).toLowerCase()
  if (name === '.env' || (name.startsWith('.env.') && !ENV_EXAMPLES.includes(name)) || CREDENTIAL_NAMES.includes(name)) return true
  const head = data.subarray(0, 8192).toString('latin1')
  return (name === '.npmrc' && /_auth|password\s*=/i.test(head)) || PRIVATE_KEY.test(head)
}

const environmentFile = (p) => {
  const name = path.posix.basename(p)
  return ENVIRONMENT_FILES.includes(name) || (name.startsWith('requirements') && name.endsWith('.txt'))
}

// The regular file at `p` under `root`: {data} with data null when it is missing, or {bad} when
// it cannot be delivered. A symlink on the way is never followed.
function read(root, p) {
  const parts = p.split('/')
  const last = parts.length - 1
  let at = root
  for (let i = 0; ; i++) {
    at = path.join(at, parts[i])
    let stat
    try {
      stat = fs.lstatSync(at)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { data: null }
      throw err
    }
    if (stat.isSymbolicLink()) return { bad: 'a symlink' }
    if (i < last) {
      if (!stat.isDirectory()) return { bad: 'a file where a folder is' }
      continue
    }
    if (!stat.isFile()) return { bad: 'not a regular file' }
    return { data: fs.readFileSync(at), mode: stat.mode & 0o777 }
  }
}

// Claude Code's --worktree <name> checks out <repo>/.claude/worktrees/<name>.
export const worktreeRoot = (project) => path.join(project, '.claude', 'worktrees')

export function worktrees(project, workers) {
  const found = {}
  for (const block of git(project, ['worktree', 'list', '--porcelain', '-z']).split('\0\0')) {
    const lines = block.split('\0')
    const at = lines.find((l) => l.startsWith('worktree '))?.slice(9)
    const name = at && /[/\\]\.claude[/\\]worktrees[/\\]([^/\\]+)$/.exec(at)?.[1]
    if (workers.includes(name)) found[name] = { path: at, branch: lines.find((l) => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null }
  }
  return found
}

// The start commit's files, read once per path for both delivery and the recovery bundle. One
// git spawn per path: `cat-file --batch --filters` reports the size before the filters, so its
// output cannot be split.
class Base {
  static #open = new Map()

  static of(project, commit) {
    const key = `${project}\0${commit}`
    if (!Base.#open.has(key)) Base.#open.set(key, new Base(project, commit))
    return Base.#open.get(key)
  }

  constructor(project, commit) {
    this.project = project
    this.commit = commit
    this.tree = new Map()
    this.files = new Map()
    for (const entry of names(git(project, ['ls-tree', '-r', '-z', '--full-tree', commit]))) {
      const tab = entry.indexOf('\t')
      const [mode, type] = entry.slice(0, tab).split(' ')
      this.tree.set(entry.slice(tab + 1), { mode, type })
    }
  }

  // As a checkout writes it, so a line ending conversion does not read as a change.
  read(p) {
    if (!this.files.has(p)) {
      const entry = this.tree.get(p)
      if (!entry) this.files.set(p, { data: null })
      else if (entry.type !== 'blob' || entry.mode === '120000') this.files.set(p, { bad: 'not a regular file at the start' })
      else this.files.set(p, { data: git(this.project, ['cat-file', '--filters', `${this.commit}:${p}`], 'buffer') })
    }
    return this.files.get(p)
  }
}

function walk(root, rel) {
  let stat
  try {
    stat = fs.lstatSync(path.join(root, rel))
  } catch {
    return []
  }
  if (!stat.isDirectory()) return [rel]
  return fs.readdirSync(path.join(root, rel)).flatMap((name) => walk(root, `${rel}/${name}`))
}

// A worker's changes against the start commit: tracked files it changed or committed, new files
// Git does not ignore, and the declared artifacts, which may be ignored. Each is {p, credential}
// or {p, want, start}; a file the same as at the start is left out.
function* workerChanges(wt, base, artifacts) {
  const paths = new Set([
    ...names(git(wt, ['diff', '--name-only', '-z', '--no-renames', base.commit])),
    ...names(git(wt, ['ls-files', '-z', '--others', '--exclude-standard'])),
    ...artifacts.flatMap((a) => walk(wt, a)),
  ])
  for (const p of [...paths].sort()) {
    const want = read(wt, p)
    if (want.data && credential(p, want.data)) {
      yield { p, credential: true }
      continue
    }
    const start = base.read(p)
    if (!want.bad && !start.bad && same(want.data, start.data)) continue
    yield { p, want, start }
  }
}

function merge(stage, current, base, candidate) {
  const sides = [current, base, candidate]
  if (sides.some((d) => d.length > MERGE_LIMIT || d.includes(0) || !isUtf8(d))) return null
  const files = ['current', 'base', 'candidate'].map((name) => path.join(stage, `merge-${name}`))
  try {
    files.forEach((file, i) => fs.writeFileSync(file, sides[i]))
    return execFileSync('git', ['merge-file', '-p', ...files], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER })
  } catch (err) {
    if (err.status > 0 && err.status < 128) return null
    throw new Error(`git merge-file failed: ${String(err.stderr || err.message).trim()}`)
  } finally {
    for (const file of files) fs.rmSync(file, { force: true })
  }
}

function plan({ project, base, wt, artifacts, stage }) {
  const changes = []
  const conflicts = []
  const merged = []
  const excluded = {}
  for (const { p, credential, want, start } of workerChanges(wt, base, artifacts)) {
    if (credential) {
      excluded[p] = 'recognized credential; not delivered'
      continue
    }
    const now = read(project, p)
    if (want.bad || start.bad || now.bad) {
      conflicts.push(p)
      continue
    }
    if (same(now.data, want.data)) continue
    let result = want.data
    let mode = want.mode
    if (!same(now.data, start.data)) {
      result = now.data && start.data && want.data ? merge(stage, now.data, start.data, want.data) : null
      if (!result) {
        conflicts.push(p)
        continue
      }
      mode = now.mode
      merged.push(p)
    }
    changes.push({ path: p, before: sha256(now.data), after: sha256(result), mode, result, previous: now.data })
  }
  return { changes, conflicts, merged, excluded }
}

function apply(root, stage, c, i) {
  const target = path.join(root, c.path)
  const now = read(root, c.path)
  const sha = now.bad ? undefined : sha256(now.data)
  if (sha === c.after) return
  if (sha !== c.before) throw new Error(`${c.path} changed during delivery; it was not overwritten, and the journal in ${stage} is kept. Run the same command again once it is settled.`)
  if (c.after === null) {
    fs.rmSync(target)
    for (let d = path.dirname(target); d !== root && path.dirname(d) !== d; d = path.dirname(d)) {
      try {
        fs.rmdirSync(d)
      } catch {
        break
      }
    }
    return
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.swarm-${process.pid}.tmp`
  fs.copyFileSync(path.join(stage, `next-${i}`), tmp)
  if (process.platform !== 'win32') fs.chmodSync(tmp, c.mode)
  renameRetry(tmp, target)
}

// The candidate worker's result into the project, through a journal in <dir>/delivery that a
// rerun resumes. A change whose file the user edited since it was planned is never overwritten.
// The project's versions that the delivery replaced stay there as previous-<journal index>.
export function deliver({ dir, project, base: commit, wt, artifacts = [] }) {
  const root = path.resolve(project)
  const stage = path.join(dir, 'delivery')
  const journalFile = path.join(stage, 'journal.json')
  let journal = readJson(journalFile)
  if (!journal) {
    fs.mkdirSync(stage, { recursive: true })
    const planned = plan({ project: root, base: Base.of(project, commit), wt, artifacts, stage })
    if (planned.conflicts.length) return { ...NOT_DELIVERED, conflicts: planned.conflicts, excluded: planned.excluded }
    const changes = planned.changes.map(({ result, previous, ...c }, i) => {
      if (result) fs.writeFileSync(path.join(stage, `next-${i}`), result)
      if (previous) fs.writeFileSync(path.join(stage, `previous-${i}`), previous)
      return c
    })
    journal = { merged: planned.merged, excluded: planned.excluded, changes, complete: false }
    writeJson(journalFile, journal)
  }
  if (!journal.complete) {
    journal.changes.forEach((c, i) => apply(root, stage, c, i))
    for (const c of journal.changes) {
      const now = read(root, c.path)
      if (now.bad || sha256(now.data) !== c.after) throw new Error(`${c.path} changed during delivery; the journal in ${stage} is kept`)
    }
    journal.complete = true
    writeJson(journalFile, journal)
    journal.changes.forEach((_, i) => fs.rmSync(path.join(stage, `next-${i}`), { force: true }))
  }
  const changed = journal.changes.map((c) => c.path)
  return {
    ...NOT_DELIVERED,
    delivered: true,
    changed,
    merged: journal.merged,
    excluded: journal.excluded,
    environment_files_changed: changed.filter(environmentFile),
    recovery: journal.changes.some((c) => c.before) ? stage : null,
  }
}

// DeLM's preserve_partial: every worker's changes against the start commit, as SHA-256 named blobs
// and a manifest, in <dir>/recovery. Nothing in it is applied.
export function preserve({ dir, project, base: commit, trees, artifacts = [] }) {
  const bundle = path.join(dir, 'recovery')
  const manifestFile = path.join(bundle, 'complete.json')
  if (fs.existsSync(manifestFile)) return bundle
  fs.mkdirSync(bundle, { recursive: true })
  const base = Base.of(project, commit)
  const workers = []
  const excluded = {}
  for (const [name, tree] of Object.entries(trees)) {
    if (!fs.existsSync(tree.path)) continue
    const changes = {}
    for (const { p, credential, want, start } of workerChanges(tree.path, base, artifacts)) {
      if (credential) excluded[`${name}/${p}`] = 'recognized credential; not saved'
      else if (want.bad) changes[p] = { unsupported: want.bad }
      else {
        const [from, to] = [start.data, want.data].map((data) => {
          const sha = sha256(data)
          if (sha && !fs.existsSync(path.join(bundle, sha))) fs.writeFileSync(path.join(bundle, sha), data)
          return sha
        })
        changes[p] = { base: from, result: to }
      }
    }
    workers.push({ worker: name, branch: tree.branch, changes })
  }
  writeJson(manifestFile, {
    project,
    base: commit,
    workers,
    excluded,
    format: 'Each file version is a blob named by its SHA-256. base and result name the versions at the start commit and in the worker tree; null means no file. No Git index change is saved.',
  })
  return bundle
}

// Removes each worker's worktree and branch. A rerun skips what is already gone.
export function cleanup(project, trees) {
  const live = new Set(Object.values(worktrees(project, Object.keys(trees))).map((t) => t.path))
  const failed = []
  for (const [name, tree] of Object.entries(trees)) {
    try {
      if (live.has(tree.path)) git(project, ['worktree', 'remove', '--force', '--force', tree.path])
    } catch (err) {
      failed.push(`${name}: ${err.message}`)
    }
  }
  const branches = new Set(git(project, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n'))
  const stale = Object.values(trees).map((t) => t.branch).filter((b) => b && branches.has(b))
  try {
    if (stale.length) git(project, ['branch', '-D', ...stale])
  } catch (err) {
    failed.push(err.message)
  }
  if (Object.values(trees).some((t) => !live.has(t.path))) git(project, ['worktree', 'prune'])
  if (failed.length) throw new Error(`the changes are saved, but removing the worktrees failed: ${failed.join('; ')}`)
}

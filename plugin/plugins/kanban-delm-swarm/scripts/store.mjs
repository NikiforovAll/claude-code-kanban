// The swarm's shared store: an event log, tasks and publications in SQLite, written by every
// worker's tool calls, each one a short `node store.mjs <command>` process with the request on stdin.
// The tools, limits and rules follow DeLM's product board (src/board/mod.rs, src/board/discovery.rs).
import { isUtf8 } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { renameRetry, sleep } from './files.mjs'

const SCHEMA_VERSION = 3
const MAX_ARGUMENT_BYTES = 128 * 1024
// A tool call is one $.process.run, which gives up at 30 s.
const WAIT_CAP_SECONDS = 25
const WAIT_POLL_MS = 250
const VIEW_LIMIT = 24
const LIST_LIMIT = 12
const KINDS = ['implementation', 'verification', 'integration']
const TASK_STATES = ['available', 'claimed', 'done']
const WORKER_STATES = ['working', 'waiting', 'blocked']
const OUTCOMES = ['complete', 'partial', 'blocked', 'waiting']
const END_OUTCOMES = ['complete', 'partial', 'stopped']
// A waiting worker's dependency has no producer when no one works on it.
const IDLE_STATES = ['stopped', 'blocked', 'waiting']
// The same limits as LIMITS in hooks/swarm.ts, from DeLM's tool definitions.
const TASK_FIELDS = {
  title: { max: 256, required: true },
  description: { max: 2048, required: true },
  interface: { max: 2048 },
  earliest_contribution: { max: 1024 },
  done_when: { max: 1024 },
}
const KEY = { max: 128, required: true }
const SUMMARY = { max: 2048, required: true }
const NAME = { max: 256, required: true }
const DEPENDENCY = { max: 512, required: true }
const REVISION = '(SELECT revision FROM context WHERE id = 1)'
const PUBLISH_FIELDS = { interfaces: { max: 8192 }, unfinished: { max: 8192 } }
const STATUS_FIELDS = ['state', 'summary', 'dependency', 'finding']
// DeLM's limits for a publication without large_artifact.
const PUBLISH_LIMITS = { files: 1024, bytes: 64 * 1024 * 1024 }
const EXPAND_LIMITS = { files: 32, maxBytes: 8192, maxBytesCap: 32768, total: 65536 }
const MAX_DEPENDENCIES = 128
const MAX_SPLIT = 16
const TASK_EVENTS = ['task_create', 'task_claim', 'task_update', 'task_release', 'task_split', 'task_finish', 'task_close', 'task_owner_stopped']
// Events that give a peer something new to act on, so they end a waiting status call.
const WAKE_EVENTS = ['task_create', 'task_release', 'task_finish', 'task_owner_stopped', 'publication', 'finding', 'request', 'end']
// DeLM's wait_ready (src/board/mod.rs): a task became available after the cursor, or an
// integration task is available and another integration task finished after it, unless an
// integration task is claimed.
const READY_SQL = `SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.state = 'available'
  AND (t.version > ?1 OR (json_extract(t.body, '$.kind') = 'integration' AND EXISTS(
    SELECT 1 FROM tasks d WHERE d.state = 'done' AND d.version > ?1 AND json_extract(d.body, '$.kind') = 'integration')))
  AND (json_extract(t.body, '$.kind') != 'integration' OR NOT EXISTS(
    SELECT 1 FROM tasks c WHERE c.state = 'claimed' AND json_extract(c.body, '$.kind') = 'integration'))) AS ready`

class BoardError extends Error {}

// The board's two shared collections as rows of the same shape, for the view, the totals and list.
const SOURCES = {
  publications:
    "SELECT id, actor, (SELECT revision FROM events WHERE seq = publications.id) AS revision, json_extract(body, '$.summary') AS summary, json_extract(body, '$.unfinished') AS unfinished, json_extract(body, '$.dependencies') AS dependencies, json_array_length(body, '$.files') AS files FROM publications",
  findings: "SELECT seq AS id, actor, revision, json_extract(payload, '$.text') AS text FROM events WHERE kind = 'finding'",
}

const display = (actor) => actor.name ?? actor.id

function text(args, key, { max, required = false }) {
  const value = args[key]
  if (value === undefined && !required) return ''
  if (typeof value !== 'string') throw new BoardError(`${key} must be a string`)
  if (Buffer.byteLength(value) > max || (required && !value.trim())) {
    throw new BoardError(required ? `${key} must be nonempty and at most ${max} bytes` : `${key} must be a string of at most ${max} bytes`)
  }
  return value
}

const placeholders = (n) => Array(n).fill('?').join(',')

const fields = (args, spec) => Object.fromEntries(Object.entries(spec).map(([key, s]) => [key, text(args, key, s)]))

function positiveId(args, key) {
  const value = args[key]
  if (!Number.isInteger(value) || value < 1) throw new BoardError(`${key} must be a positive integer`)
  return value
}

function count(args, key, fallback, min, max) {
  const value = args[key]
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) throw new BoardError(`${key} must be an integer from ${min} to ${max}`)
  return value
}

function compact(value, max) {
  const chars = [...(typeof value === 'string' ? value : '')]
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}...`
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]))
  }
  return value
}
const fingerprint = (value) => sha256(JSON.stringify(stable(value)))

// A file version is compared as its JSON text, so it is always built with the same key order.
const version = (data, executable) => ({ sha256: sha256(data), bytes: data.length, executable })
const sameVersion = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function changeOf(base, result) {
  if (!base) return 'added'
  if (!result) return 'deleted'
  return sameVersion(base, result) ? 'unchanged' : 'modified'
}

function checkPath(p) {
  if (typeof p !== 'string' || !p || p !== p.trim()) throw new BoardError('paths must be nonempty strings')
  const posix = p.replace(/\\/g, '/')
  if (path.posix.isAbsolute(posix) || path.win32.isAbsolute(p)) throw new BoardError(`${p}: use a path relative to your workspace`)
  const parts = posix.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new BoardError(`${p}: path must not contain '.', '..' or empty parts`)
  if (parts.some((part) => part.toLowerCase() === '.git')) throw new BoardError(`${p}: Git metadata cannot be published or applied`)
  return posix
}

function selection(value, optional) {
  if (value === undefined) {
    if (optional) return null
    throw new BoardError('paths is required')
  }
  if (!Array.isArray(value)) throw new BoardError('paths must be an array')
  const seen = new Set()
  return value.map((raw) => {
    const p = checkPath(raw)
    if (seen.has(p)) throw new BoardError('duplicate path in selection')
    seen.add(p)
    return p
  })
}

// The file at `p` in a workspace, or null when it is missing. A symlink anywhere on the way is
// refused, so a publish cannot read, and an apply cannot write, outside the workspace.
// Windows has no executable bit, so there a file takes `executable` from the version it is compared with.
function local(cwd, p, executable = false) {
  let at = cwd
  for (const part of p.split('/')) {
    at = path.join(at, part)
    let stat
    try {
      stat = fs.lstatSync(at)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
      throw err
    }
    if (stat.isSymbolicLink()) throw new BoardError(`${p}: symlinks cannot be published or applied`)
  }
  const stat = fs.statSync(at)
  if (!stat.isFile()) throw new BoardError(`${p} is not a regular file`)
  const data = fs.readFileSync(at)
  return { version: version(data, process.platform === 'win32' ? executable : !!(stat.mode & 0o111)), data }
}

function selectFiles(files, paths) {
  const chosen = selection(paths, true)
  if (!chosen) return files
  const byPath = new Map(files.map((f) => [f.path, f]))
  return chosen.map((p) => {
    if (!byPath.has(p)) throw new BoardError(`${p} is not in publication`)
    return byPath.get(p)
  })
}

class Store {
  // tasksDir: the Claude Code task list the store mirrors the tasks into.
  // base: the commit the workers' worktrees start from; the base version of a published file.
  // parent: the session that started the swarm; roster: the registry's workers, [{name, sessionId}].
  constructor({ dir, tasksDir, base, parent, roster, readOnly = false } = {}) {
    this.dir = dir
    this.tasksDir = tasksDir
    this.base = base
    this.parent = parent
    this.roster = Array.isArray(roster) ? roster.filter((w) => w?.sessionId && w.name) : []
    const file = path.join(dir, 'swarm.db')
    if (readOnly) {
      if (!fs.existsSync(file)) throw new BoardError('no swarm store in this folder')
      this.db = new DatabaseSync(file, { readOnly: true })
      return
    }
    fs.mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(file, { timeout: 10_000 })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  migrate() {
    const { user_version: current } = this.db.prepare('PRAGMA user_version').get()
    if (current === SCHEMA_VERSION) return
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get()
    if (current !== 0 || n) throw new BoardError('this swarm store was made by another plugin version; start a new swarm')
    this.db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      actor TEXT NOT NULL, name TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS context (
      id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'running', outcome TEXT);
    INSERT OR IGNORE INTO context(id, revision) VALUES (1, 1);
    CREATE TABLE IF NOT EXISTS workers (
      actor TEXT PRIMARY KEY, name TEXT, state TEXT NOT NULL DEFAULT 'working', summary TEXT NOT NULL DEFAULT '',
      dependency TEXT, wait_seq INTEGER, acked INTEGER NOT NULL DEFAULT 1, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, created INTEGER NOT NULL, author TEXT NOT NULL, owner TEXT,
      state TEXT NOT NULL CHECK(state IN ('available','claimed','done')), body TEXT NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (
      actor TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('applying','done')), response TEXT, detail TEXT, PRIMARY KEY(actor, key));
    CREATE TABLE IF NOT EXISTS publications (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS publication_files (
      publication_id INTEGER NOT NULL, path TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(publication_id, path));
    CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, content BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS publication_files_path ON publication_files(path, result);
    CREATE INDEX IF NOT EXISTS events_kind ON events(kind);
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT`)
  }

  close() {
    this.db.close()
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    this.touched = new Set()
    this.diskTop = null
    try {
      const seed = this.db.prepare('INSERT OR IGNORE INTO workers(actor, name, updated) VALUES (?, ?, 0)')
      for (const w of this.roster) seed.run(w.sessionId, w.name)
      const result = fn()
      // Written under the write lock, so two workers' files cannot land out of order.
      // A COMMIT that fails after this leaves a file ahead of the log until the next write to that task.
      this.writeTaskFiles()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // A worker's change acknowledges the request revision it was made under: the response that
  // carries it also carries the request changes the worker had not seen.
  append(actor, kind, payload) {
    const r = this.db
      .prepare(`INSERT INTO events(actor, name, kind, payload, revision) VALUES (?, ?, ?, ?, ${REVISION})`)
      .run(actor.id, actor.name ?? null, kind, JSON.stringify(payload))
    const seq = Number(r.lastInsertRowid)
    if (!actor.parent) {
      this.db
        .prepare(
          `INSERT INTO workers(actor, name, updated, acked) VALUES (?, ?, ?, ${REVISION}) ON CONFLICT(actor) DO UPDATE SET name = COALESCE(excluded.name, workers.name), acked = excluded.acked`,
        )
        .run(actor.id, actor.name ?? null, seq)
    }
    if (actor.name && this.nameCache) this.nameCache[actor.id] = actor.name
    if (TASK_EVENTS.includes(kind)) this.touched.add(payload.task_id)
    return seq
  }

  label(actorId) {
    if (actorId == null) return null
    if (actorId === this.parent) return 'parent'
    this.nameCache ??= Object.fromEntries(this.db.prepare('SELECT actor, name FROM workers WHERE name IS NOT NULL').all().map((r) => [r.actor, r.name]))
    return this.nameCache[actorId] ?? actorId
  }

  lastSeq() {
    return this.db.prepare('SELECT MAX(seq) AS s FROM events').get().s ?? 0
  }

  static row(r) {
    return { task_id: r.id, ...JSON.parse(r.body), state: r.state, author: r.author, owner: r.owner, version: r.version }
  }

  tasks(ids) {
    return this.db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders(ids.length)}) ORDER BY id`).all(...ids).map(Store.row)
  }

  task(id) {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (!r) throw new BoardError('unknown task')
    return Store.row(r)
  }

  publication(id) {
    return this.db.prepare('SELECT id, actor FROM publications WHERE id = ?').get(id)
  }

  publicationBody(id) {
    const r = this.db.prepare('SELECT actor, body FROM publications WHERE id = ?').get(id)
    if (!r) throw new BoardError('unknown publication')
    return { actor: r.actor, ...JSON.parse(r.body) }
  }

  blob(hash) {
    const r = this.db.prepare('SELECT content FROM blobs WHERE sha256 = ?').get(hash)
    if (!r) throw new BoardError('a published file is missing from the store')
    const data = Buffer.from(r.content)
    if (sha256(data) !== hash) throw new BoardError('a published file does not match its recorded hash')
    return data
  }

  // A byte range for display only, so it skips the hash check that apply and diff make.
  blobRange(hash, offset, length) {
    const r = this.db.prepare('SELECT substr(content, ?, ?) AS slice FROM blobs WHERE sha256 = ?').get(offset + 1, length, hash)
    if (!r) throw new BoardError('a published file is missing from the store')
    return Buffer.from(r.slice)
  }

  summarize(t) {
    return {
      task_id: t.task_id,
      author: this.label(t.author),
      owner: this.label(t.owner),
      state: t.state,
      version: t.version,
      kind: t.kind,
      title: t.title,
      description: compact(t.description, 256),
      interface: compact(t.interface, 256),
      dependencies: t.dependencies,
      handoff: compact(t.handoff, 256),
      checkpoint: t.checkpoint ?? null,
    }
  }

  publicationRow(r, summaryChars) {
    return {
      publication_id: r.id,
      author: this.label(r.actor),
      revision: r.revision,
      summary: compact(r.summary, summaryChars),
      files: r.files,
      dependencies: JSON.parse(r.dependencies),
      unfinished: compact(r.unfinished, 256),
    }
  }

  findingRow(r) {
    return { finding_id: r.id, author: this.label(r.actor), revision: r.revision, text: compact(r.text, 1024) }
  }

  context() {
    return this.db.prepare('SELECT revision, state, outcome FROM context WHERE id = 1').get()
  }

  workerId(name) {
    return this.roster.find((w) => w.name === name)?.sessionId ?? this.db.prepare('SELECT actor FROM workers WHERE name = ?').get(name)?.actor ?? null
  }

  // A dependency is `task:<id>` or `worker:<name>`, DeLM's `task:<id>` or `worker:<1|2>`.
  parseDependency(dependency) {
    const m = /^(task|worker):(.+)$/s.exec(dependency ?? '')
    if (!m) throw new BoardError('waiting dependency must be task:<id> or worker:<name>')
    if (m[1] === 'task') {
      if (!/^\d+$/.test(m[2]) || Number(m[2]) < 1) throw new BoardError('invalid waiting dependency ID')
      const t = this.db.prepare('SELECT id, owner, state FROM tasks WHERE id = ?').get(Number(m[2]))
      if (!t) throw new BoardError('unknown waiting task')
      return { task: t.id, owner: t.owner, state: t.state }
    }
    const id = this.workerId(m[2])
    if (!id) throw new BoardError('unknown waiting worker')
    return { worker: id, owner: id }
  }

  checkWait(actor, dependency) {
    if (!dependency) throw new BoardError('waiting requires a named dependency')
    const d = this.parseDependency(dependency)
    if (d.owner === actor.id) throw new BoardError('waiting dependency belongs to this worker; continue that work instead')
    if (d.state === 'done') throw new BoardError(`task ${d.task} is already finished; read its contribution instead of waiting`)
    return dependency
  }

  // DeLM's wait_ready: new available work, the named task finished, or the named worker
  // published under the current request revision, all after the worker started waiting.
  ready(w, d) {
    if (this.db.prepare(READY_SQL).get(w.wait_seq).ready) return true
    if (d.task) return !!this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND state = 'done' AND version > ?").get(d.task, w.wait_seq)
    return !!this.db.prepare(`SELECT 1 FROM publications p JOIN events e ON e.seq = p.id WHERE p.actor = ? AND p.id > ? AND e.revision = ${REVISION}`).get(d.worker, w.wait_seq)
  }

  // DeLM resumes a waiter once when no one can produce what it waits for: an unclaimed task,
  // or an owner or worker that is itself stopped, blocked or waiting.
  stalled(d, states) {
    const idle = (id) => id == null || IDLE_STATES.includes(states.get(id) ?? 'stopped')
    return d.task ? d.state !== 'done' && idle(d.owner) : idle(d.worker)
  }

  setWorker(actorId, state, summary, dependency, seq) {
    this.db
      .prepare('UPDATE workers SET state = ?, summary = ?, dependency = ?, wait_seq = ?, updated = ? WHERE actor = ?')
      .run(state, summary, dependency, state === 'waiting' ? seq : null, seq, actorId)
  }

  // The request revisions after the last one this worker acknowledged.
  requestUpdates(actorId) {
    const acked = this.db.prepare('SELECT acked FROM workers WHERE actor = ?').get(actorId)?.acked ?? 1
    return this.db
      .prepare("SELECT revision, json_extract(payload, '$.text') AS text FROM events WHERE kind = 'request' AND revision > ? ORDER BY seq")
      .all(acked)
      .map(({ revision, text }) => ({ revision, text }))
  }

  counts() {
    const total = (from) => this.db.prepare(`SELECT COUNT(*) AS n FROM (${from})`).get().n
    const totals = { tasks: total('SELECT id FROM tasks'), publications: total(SOURCES.publications), findings: total(SOURCES.findings) }
    return Object.fromEntries(Object.entries(totals).map(([k, n]) => [k, { total: n, shown: Math.min(n, VIEW_LIMIT), has_more: n > VIEW_LIMIT }]))
  }

  // The compact board every response carries: the latest records of each collection, with totals.
  // A waiting worker shows whether it is ready to resume and whether its dependency has no producer.
  view() {
    const { revision, state, outcome } = this.context()
    const workers = this.db.prepare('SELECT * FROM workers ORDER BY rowid').all()
    const states = new Map(workers.map((w) => [w.actor, w.state]))
    return {
      sequence: this.lastSeq(),
      request_revision: revision,
      state,
      outcome: outcome && JSON.parse(outcome),
      workers: workers.map((w) => {
        const row = { worker: w.name ?? w.actor, state: w.state, summary: w.summary, dependency: w.dependency, sequence: w.updated }
        if (w.state !== 'waiting') return row
        const d = this.parseDependency(w.dependency)
        const ready = this.ready(w, d)
        return { ...row, ready, stalled: !ready && this.stalled(d, states) }
      }),
      tasks: this.db
        .prepare("SELECT * FROM tasks ORDER BY (state = 'done'), version DESC LIMIT ?")
        .all(VIEW_LIMIT)
        .map((r) => this.summarize(Store.row(r))),
      publications: this.db
        .prepare(`SELECT * FROM (${SOURCES.publications}) ORDER BY id DESC LIMIT ?`)
        .all(VIEW_LIMIT)
        .map((r) => this.publicationRow(r, 2048)),
      findings: this.db
        .prepare(`SELECT * FROM (${SOURCES.findings}) ORDER BY id DESC LIMIT ?`)
        .all(VIEW_LIMIT)
        .map((r) => this.findingRow(r)),
      view_limit: VIEW_LIMIT,
      collections: this.counts(),
    }
  }

  // The store's task id is the Claude Code task id, so it skips ids already in the task list.
  // The folder is read once per transaction; ids created after that are in the table.
  nextTaskId() {
    if (this.diskTop == null) {
      this.diskTop = 0
      if (this.tasksDir && fs.existsSync(this.tasksDir)) {
        for (const f of fs.readdirSync(this.tasksDir)) {
          const n = /^(\d+)\.json$/.exec(f)?.[1]
          if (n) this.diskTop = Math.max(this.diskTop, Number(n))
        }
        try {
          this.diskTop = Math.max(this.diskTop, Number(fs.readFileSync(path.join(this.tasksDir, '.highwatermark'), 'utf8')) || 0)
        } catch {}
      }
    }
    return Math.max(this.diskTop, this.db.prepare('SELECT MAX(id) AS m FROM tasks').get().m ?? 0) + 1
  }

  taskFile(t) {
    const status = { available: 'pending', claimed: 'in_progress', done: 'completed' }[t.state]
    const sections = [
      t.description,
      t.interface && `**Interface:** ${t.interface}`,
      t.done_when && `**Done when:** ${t.done_when}`,
      t.handoff && t.state !== 'done' && `**Handoff:** ${t.handoff}`,
      t.summary && `**Done:** ${t.summary}`,
    ]
    return {
      id: String(t.task_id),
      subject: t.title,
      description: sections.filter(Boolean).join('\n\n'),
      activeForm: t.title,
      status,
      blocks: [],
      blockedBy: [],
      ...(t.owner ? { owner: this.label(t.owner) } : {}),
      metadata: { swarm: true, kind: t.kind, version: t.version },
    }
  }

  writeTaskFiles() {
    if (!this.tasksDir || !this.touched.size) return
    fs.mkdirSync(this.tasksDir, { recursive: true })
    for (const t of this.tasks([...this.touched])) {
      const file = path.join(this.tasksDir, `${t.task_id}.json`)
      const tmp = `${file}.${process.pid}.tmp`
      try {
        fs.writeFileSync(tmp, `${JSON.stringify(this.taskFile(t), null, 2)}\n`)
        renameRetry(tmp, file)
      } catch (err) {
        fs.rmSync(tmp, { force: true })
        throw err
      }
    }
  }

  // Each path's version in the base commit, with its content; a path not in the base is absent.
  // Two git calls for the whole publication, both before the write lock.
  baseVersions(cwd, paths) {
    const found = new Map()
    if (!this.base || !paths.length) return found
    const git = (args, input) => execFileSync('git', ['-C', cwd, ...args], { input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 2 * PUBLISH_LIMITS.bytes })
    const wanted = new Set(paths)
    const blobs = []
    for (const entry of git(['ls-tree', '-z', this.base, '--', ...paths]).toString('utf8').split('\0')) {
      const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(entry)
      if (m && m[2] === 'blob' && wanted.has(m[4])) blobs.push({ path: m[4], executable: m[1] === '100755', object: m[3] })
    }
    if (!blobs.length) return found
    const out = git(['cat-file', '--batch'], `${blobs.map((b) => b.object).join('\n')}\n`)
    let at = 0
    for (const b of blobs) {
      const end = out.indexOf(0x0a, at)
      const size = Number(out.subarray(at, end).toString('utf8').split(' ')[2])
      const data = Buffer.from(out.subarray(end + 1, end + 1 + size))
      at = end + 1 + size + 1
      found.set(b.path, { version: version(data, b.executable), data })
    }
    return found
  }

  // Reads the published files from the caller's workspace before the transaction opens, so no
  // file or git read holds the write lock. A path missing from the workspace is a deletion.
  freeze(cwd, args) {
    const summary = text(args, 'summary', SUMMARY)
    const paths = selection(args.paths, false)
    if (paths.length > PUBLISH_LIMITS.files) throw new BoardError('publication manifest is too large; split the contribution')
    const dependencies = this.dependencies(args)
    const extra = fields(args, PUBLISH_FIELDS)
    const bases = this.baseVersions(cwd, paths)
    let bytes = 0
    const files = paths.map((p) => {
      const base = bases.get(p) ?? null
      const result = local(cwd, p, base?.version.executable)
      if (!result && !base) throw new BoardError(`${p} is neither in your workspace nor in the base commit`)
      bytes += result?.version.bytes ?? 0
      if (bytes > PUBLISH_LIMITS.bytes) throw new BoardError('publication exceeds 64 MiB; split it into selective publications')
      return { path: p, base, result }
    })
    return { summary, ...extra, dependencies, files, bytes }
  }

  // A mutation runs once per idempotency key: a retry with the same arguments gets the stored
  // result, and the same key with other arguments is refused. The board is not stored: the
  // caller reads a fresh one after the commit, outside the write lock.
  mutate(actor, command, args) {
    const key = text(args, 'idempotency_key', KEY)
    const { cwd, ...signed } = args
    const digest = fingerprint(signed)
    const prior = () => {
      const row = this.db.prepare('SELECT name, digest, state, response, detail FROM requests WHERE actor = ? AND key = ?').get(actor.id, key)
      if (!row) return null
      if (row.name !== command || row.digest !== digest) throw new BoardError('idempotency key was already used with different arguments')
      if (row.state === 'done') return JSON.parse(row.response)
      return this.reconcileApply(actor, key, cwd, JSON.parse(row.detail))
    }
    const ended = () => {
      if (this.context().state === 'ended') throw new BoardError('This swarm has ended.')
    }
    const replay = prior()
    if (replay) return replay
    ended()
    if (command === 'apply') return this.apply(actor, key, digest, args)
    const captured = command === 'publish' ? this.freeze(cwd, args) : null
    try {
      return this.tx(() => {
        const again = prior()
        if (again) return again
        ended()
        const result = this[command](actor, args, captured)
        this.db
          .prepare("INSERT INTO requests(actor, key, name, digest, state, response) VALUES (?, ?, ?, ?, 'done', ?)")
          .run(actor.id, key, command, digest, JSON.stringify(result))
        return result
      })
    } catch (err) {
      // A refusal the viewer needs to see is logged after the rollback, in its own transaction.
      if (err instanceof BoardError && err.event) this.tx(() => this.append(actor, err.event.kind, err.event.payload))
      throw err
    }
  }

  dependencies(args) {
    if (args.dependencies === undefined) return []
    if (!Array.isArray(args.dependencies)) throw new BoardError('dependencies must be publication IDs')
    if (args.dependencies.length > MAX_DEPENDENCIES) throw new BoardError('too many publication dependencies')
    for (const id of args.dependencies) {
      if (!Number.isInteger(id) || id < 1 || !this.publication(id)) {
        throw new BoardError(
          `unknown dependency publication ${JSON.stringify(id)}; use publication_id values returned by swarm_publish or swarm_list(collection=publications), not task IDs or task numbers; omit dependencies until a contribution exists`,
        )
      }
    }
    return args.dependencies
  }

  taskBody(args) {
    const kind = args.kind ?? 'implementation'
    if (!KINDS.includes(kind)) throw new BoardError('invalid task kind')
    return { ...fields(args, TASK_FIELDS), kind, dependencies: this.dependencies(args) }
  }

  // A task's version is the seq of the event that last changed it, so a request that names an
  // old version cannot change a task that was released or claimed again, even by the same worker.
  // `replace` drops the body fields not in `changes`, such as an old handoff.
  setTask(t, changes, version, replace = false) {
    const { task_id: _id, author: _author, version: _version, state, owner, ...body } = replace
      ? { state: t.state, owner: t.owner, ...changes }
      : { ...t, ...changes }
    this.db
      .prepare('UPDATE tasks SET owner = ?, state = ?, body = ?, version = ? WHERE id = ?')
      .run(owner ?? null, state, JSON.stringify(body), version, t.task_id)
  }

  claimed(actor, t, version, extra = {}) {
    return { task_id: t.task_id, owner: display(actor), state: 'claimed', version, ...extra }
  }

  owned(actor, args) {
    const id = positiveId(args, 'task_id')
    const expected = positiveId(args, 'expected_version')
    const t = this.task(id)
    if (t.owner !== actor.id || t.state !== 'claimed') throw new BoardError(`task ${id}: only the current owner may change a claimed task`)
    if (t.version !== expected) throw new BoardError(`task ${id}: stale task version; read the current board before changing this task`)
    return t
  }

  // The parent may name an assignee: the task is then created claimed by that worker.
  task_create(actor, args) {
    const body = this.taskBody(args)
    let owner = null
    if (args.assignee !== undefined) {
      if (!actor.parent) throw new BoardError('only the parent assigns a task; create it open, then claim it')
      owner = this.workerId(text(args, 'assignee', NAME))
      if (!owner) throw new BoardError('unknown assignee')
    }
    const state = owner ? 'claimed' : 'available'
    const id = this.nextTaskId()
    const version = this.append(actor, 'task_create', { task_id: id, ...body, ...(owner ? { assignee: this.label(owner) } : {}) })
    this.db
      .prepare('INSERT INTO tasks(id, created, author, owner, state, body, version) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, version, actor.id, owner, state, JSON.stringify(body), version)
    return { task_id: id, state, ...(owner ? { owner: this.label(owner) } : {}), version }
  }

  task_close(actor, args) {
    const t = this.task(positiveId(args, 'task_id'))
    if (t.state !== 'available') {
      throw new BoardError(`task ${t.task_id} is ${t.state === 'done' ? 'already finished' : `claimed by ${this.label(t.owner)}; release it first`}`)
    }
    const summary = `Closed: ${text(args, 'reason', SUMMARY)}`
    const version = this.append(actor, 'task_close', { task_id: t.task_id, summary })
    this.setTask(t, { state: 'done', summary, closed: true }, version)
    return { task_id: t.task_id, state: 'done', closed: true, version }
  }

  task_claim(actor, args) {
    const id = positiveId(args, 'task_id')
    const t = this.task(id)
    const own = t.state === 'claimed' && t.owner === actor.id
    if (own) return this.claimed(actor, t, t.version)
    if (t.state !== 'available') {
      const err = new BoardError(`task ${id} is already ${t.state === 'done' ? 'finished' : `owned by ${this.label(t.owner)}`}; pick other work`)
      err.event = { kind: 'claim_lost', payload: { task_id: id, owner: t.owner, state: t.state } }
      throw err
    }
    if (t.kind === 'integration') {
      const other = this.db
        .prepare("SELECT id FROM tasks WHERE state = 'claimed' AND json_extract(body, '$.kind') = 'integration' LIMIT 1")
        .get()
      if (other) throw new BoardError(`integration is already claimed as task ${other.id}; contribute other useful work`)
    }
    const version = this.append(actor, 'task_claim', { task_id: id })
    this.setTask(t, { owner: actor.id, state: 'claimed' }, version)
    return this.claimed(actor, t, version)
  }

  task_update(actor, args) {
    const t = this.owned(actor, args)
    const given = Object.fromEntries(Object.entries(TASK_FIELDS).filter(([key]) => args[key] !== undefined))
    const changes = fields(args, given)
    if (args.dependencies !== undefined) changes.dependencies = this.dependencies(args)
    if (!Object.keys(changes).length) throw new BoardError('task update must change at least one task field')
    const version = this.append(actor, 'task_update', { task_id: t.task_id, ...changes })
    this.setTask(t, changes, version)
    return this.claimed(actor, t, version)
  }

  // The parent releases any claimed task with no version: the new version makes the owner's
  // next change fail as stale.
  task_release(actor, args) {
    const t = actor.parent ? this.task(positiveId(args, 'task_id')) : this.owned(actor, args)
    if (t.state !== 'claimed') throw new BoardError(`task ${t.task_id} is not claimed`)
    const changes = { handoff: text(args, 'summary', SUMMARY) }
    if (args.publication_id !== undefined) {
      const pub = this.publication(positiveId(args, 'publication_id'))
      if (!pub) throw new BoardError('unknown checkpoint publication')
      if (pub.actor !== actor.id) throw new BoardError('release checkpoint must be published by the releasing worker')
      changes.checkpoint = pub.id
    }
    const payload = { handoff: changes.handoff, checkpoint: changes.checkpoint ?? null, ...(actor.parent && { owner: this.label(t.owner) }) }
    const version = this.release(actor, t, 'task_release', payload, changes)
    return { task_id: t.task_id, state: 'available', version }
  }

  release(actor, t, kind, payload, changes) {
    const version = this.append(actor, kind, { task_id: t.task_id, ...payload })
    this.setTask(t, { ...changes, owner: null, state: 'available' }, version)
    return version
  }

  // Keeps a smaller part of the claimed task and exposes the rest as new tasks, all in one
  // transaction, so one bad child leaves the board as it was.
  task_split(actor, args) {
    const t = this.owned(actor, args)
    const children = args.tasks
    if (!Array.isArray(children)) throw new BoardError('tasks must be an array')
    if (children.length < 1 || children.length > MAX_SPLIT) throw new BoardError('split must expose one to sixteen independent remaining tasks')
    if (!args.remaining || typeof args.remaining !== 'object') throw new BoardError('remaining describes the work you still own')
    const remaining = this.taskBody(args.remaining)
    if (remaining.kind !== t.kind) throw new BoardError('split cannot change the current task kind')
    const created = children.map((child) => {
      if (!child || typeof child !== 'object' || Array.isArray(child)) throw new BoardError('each split task must be an object')
      return this.task_create(actor, child)
    })
    const version = this.append(actor, 'task_split', { task_id: t.task_id, task: remaining, created })
    this.setTask(t, remaining, version, true)
    return this.claimed(actor, t, version, { created })
  }

  task_finish(actor, args) {
    const t = this.owned(actor, args)
    const result = { task_id: t.task_id, state: 'done', summary: text(args, 'summary', SUMMARY), whole_task_complete: false }
    const version = this.append(actor, 'task_finish', result)
    this.setTask(t, { state: 'done', summary: result.summary }, version)
    return { ...result, version }
  }

  // The publication id is the seq of its event. File contents go to `blobs` by hash, so a file
  // published twice, or a base that many publications share, is stored once.
  publish(actor, _args, captured) {
    const files = captured.files.map((f) => ({
      path: f.path,
      change: changeOf(f.base?.version, f.result?.version),
      base: f.base?.version ?? null,
      result: f.result?.version ?? null,
    }))
    const id = this.append(actor, 'publication', {
      summary: captured.summary,
      file_count: files.length,
      files: files.map((f) => ({ path: f.path, change: f.change, bytes: f.result?.bytes ?? 0 })),
    })
    const { summary, interfaces, unfinished, dependencies, bytes } = captured
    this.db.prepare('INSERT INTO publications(id, actor, body) VALUES (?, ?, ?)').run(id, actor.id, JSON.stringify({ summary, interfaces, unfinished, dependencies, bytes, files }))
    const blob = this.db.prepare('INSERT OR IGNORE INTO blobs(sha256, content) VALUES (?, ?)')
    const file = this.db.prepare('INSERT INTO publication_files(publication_id, path, result) VALUES (?, ?, ?)')
    captured.files.forEach((f, i) => {
      for (const side of [f.base, f.result]) if (side) blob.run(side.version.sha256, side.data)
      file.run(id, f.path, JSON.stringify(files[i].result))
    })
    return { publication_id: id, summary, file_count: files.length }
  }

  worker(actorId) {
    return this.db.prepare('SELECT state, summary, dependency FROM workers WHERE actor = ?').get(actorId)
  }

  // Sets the caller's status, appends a finding, or both. Waiting must name what it waits for.
  status(actor, args) {
    const current = this.worker(actor.id) ?? { state: 'working', summary: '', dependency: null }
    const state = args.state ?? current.state
    if (!WORKER_STATES.includes(state)) throw new BoardError('invalid worker status')
    const summary = args.summary !== undefined ? text(args, 'summary', { max: 2048 }) : current.summary
    const given = args.dependency !== undefined ? text(args, 'dependency', DEPENDENCY) : current.dependency
    const dependency = state === 'waiting' ? this.checkWait(actor, given) : null
    const finding = args.finding !== undefined ? text(args, 'finding', { max: 4096, required: true }) : null
    const body = { worker: display(actor), state, summary, dependency }
    const seq = this.append(actor, 'status', body)
    this.setWorker(actor.id, state, summary, dependency, seq)
    if (finding) body.finding_id = this.append(actor, 'finding', { text: finding })
    return body
  }

  // DeLM's delm_complete: the worker's outcome for the whole request, made under the current
  // request revision. `complete` is the goal-met claim the parent checks before it ends the swarm.
  complete(actor, args) {
    const { revision } = this.context()
    if (args.expected_revision !== revision) {
      throw new BoardError('completion must acknowledge the current board request_revision; this declaration is stale')
    }
    const { outcome } = args
    if (!OUTCOMES.includes(outcome)) throw new BoardError('invalid completion outcome')
    const summary = text(args, 'summary', { max: 4096, required: true })
    const dependency = outcome === 'waiting' ? this.checkWait(actor, args.dependency === undefined ? null : text(args, 'dependency', DEPENDENCY)) : null
    const body = { worker: display(actor), outcome, summary, dependency, expected_revision: revision }
    const seq = this.append(actor, 'outcome', body)
    this.setWorker(actor.id, { waiting: 'waiting', blocked: 'blocked' }[outcome] ?? 'working', summary, dependency, seq)
    return body
  }

  // Parent only: a new revision of the request, for every worker's next response.
  request(actor, args) {
    const change = text(args, 'text', { max: 8192, required: true })
    const revision = this.context().revision + 1
    this.db.prepare('UPDATE context SET revision = ? WHERE id = 1').run(revision)
    this.append(actor, 'request', { revision, text: change })
    return { request_revision: revision }
  }

  // DeLM's release_worker_claims, for a worker whose session stopped: its claimed tasks become
  // available with a handoff. A worker stops itself; the parent names the worker.
  worker_stop(actor, args) {
    if (!actor.parent && args.worker !== undefined) throw new BoardError('a worker stops only itself')
    const target = actor.parent ? this.workerId(text(args, 'worker', NAME)) : actor.id
    if (!target) throw new BoardError('unknown worker')
    const reason = text(args, 'reason', SUMMARY)
    const handoff = `Owner stopped: ${reason}. Reuse published contributions; unpublished files have not been imported.`
    const released = []
    for (const r of this.db.prepare("SELECT * FROM tasks WHERE owner = ? AND state = 'claimed' ORDER BY id").all(target)) {
      const t = Store.row(r)
      this.release(actor, t, 'task_owner_stopped', { owner: this.label(target), reason }, { handoff })
      released.push(t.task_id)
    }
    const seq = this.append(actor, 'worker_stopped', { worker: this.label(target), reason, released })
    this.setWorker(target, 'stopped', reason, null, seq)
    return { worker: this.label(target), state: 'stopped', released }
  }

  // Parent only. After the end, every change is refused; reads still work.
  end(actor, args) {
    if (!END_OUTCOMES.includes(args.outcome)) throw new BoardError(`outcome must be ${END_OUTCOMES.join(', ')}`)
    const body = { outcome: args.outcome, summary: text(args, 'summary', SUMMARY) }
    const sequence = this.append(actor, 'end', body)
    this.db.prepare("UPDATE context SET state = 'ended', outcome = ? WHERE id = 1").run(JSON.stringify({ ...body, sequence }))
    return { ...body, sequence }
  }

  // The board now, or as soon as a peer posts work after `since` (`wait` seconds, at most 25).
  // The wait polls without holding the write lock and writes nothing.
  look(actor, args) {
    const seconds = Math.min(Number(args.wait) || 0, WAIT_CAP_SECONDS)
    const result = { worker: display(actor) }
    if (seconds > 0) {
      const since = args.since === undefined ? this.lastSeq() : count(args, 'since', 0, 0, Number.MAX_SAFE_INTEGER)
      const target = args.target === undefined ? null : positiveId(args, 'target')
      const started = Date.now()
      const peerEvents = this.db.prepare(`SELECT seq, actor, kind FROM events WHERE seq > ? AND actor != ? AND kind IN (${placeholders(WAKE_EVENTS.length)}) ORDER BY seq`)
      const done = this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND state = 'done'")
      let woke = 'timeout'
      let events = []
      for (;;) {
        events = peerEvents.all(since, actor.id, ...WAKE_EVENTS).map((r) => ({ sequence: r.seq, worker: this.label(r.actor), kind: r.kind }))
        if (events.length) woke = 'update'
        else if (target != null && done.get(target)) woke = 'already'
        if (woke !== 'timeout' || Date.now() - started >= seconds * 1000) break
        sleep(WAIT_POLL_MS)
      }
      Object.assign(result, { waited: (Date.now() - started) / 1000, woke_by: woke, woken: events })
    }
    return result
  }

  // A bounded page of one collection in stable id order. The cursor fixes which records belong
  // to the listing (those that existed at its first page), not their state; a filtered task
  // listing refuses its cursor once any task's state or owner changed, so no newly matching task
  // is skipped.
  list(actor, args) {
    const { collection } = args
    if (!['tasks', 'publications', 'findings'].includes(collection)) throw new BoardError('unknown board collection')
    const limit = count(args, 'limit', LIST_LIMIT, 1, VIEW_LIMIT)
    const taskState = args.task_state ?? null
    if (taskState != null && !TASK_STATES.includes(taskState)) throw new BoardError('unknown task state')
    const owner = args.owner ?? null
    if (owner != null && owner !== 'self' && owner !== 'peer') throw new BoardError('owner filter must be self or peer')
    if (collection !== 'tasks' && (taskState || owner)) throw new BoardError('task filters only apply to tasks')
    const sequence = this.lastSeq()
    const { revision } = this.context()
    let prior = null
    if (args.cursor !== undefined) {
      try {
        prior = JSON.parse(text(args, 'cursor', { max: 1024, required: true }))
      } catch (err) {
        if (err instanceof BoardError) throw err
        throw new BoardError('invalid list cursor; restart without a cursor')
      }
      if (prior?.v !== 1 || prior.collection !== collection || prior.task_state !== taskState || prior.owner !== owner || prior.actor !== actor.id) {
        throw new BoardError('list cursor does not match this collection or filters; restart without a cursor')
      }
      if (!Number.isInteger(prior.after) || !Number.isInteger(prior.through) || prior.after < 0 || prior.through > sequence) {
        throw new BoardError('invalid list cursor boundary')
      }
      if (prior.revision !== revision) throw new BoardError('The request changed; restart swarm_list without a cursor')
    }
    const through = prior?.through ?? sequence
    const after = prior?.after ?? 0
    let rows
    let total
    let taskSequence = null
    if (collection === 'tasks') {
      taskSequence = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS s FROM tasks WHERE created <= ?').get(through).s
      if (prior && (taskState || owner) && prior.task_sequence !== taskSequence) {
        throw new BoardError('task state or ownership changed while paging; restart swarm_list without a cursor for current work')
      }
      const where = ['created <= ?']
      const params = [through]
      if (taskState) {
        where.push('state = ?')
        params.push(taskState)
      }
      if (owner) {
        where.push(owner === 'self' ? 'owner = ?' : 'owner IS NOT NULL AND owner != ?')
        params.push(actor.id)
      }
      total = this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where.join(' AND ')}`).get(...params).n
      rows = this.db.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} AND id > ? ORDER BY id LIMIT ?`).all(...params, after, limit + 1)
    } else {
      const source = SOURCES[collection]
      total = this.db.prepare(`SELECT COUNT(*) AS n FROM (${source}) WHERE id <= ?`).get(through).n
      rows = this.db.prepare(`SELECT * FROM (${source}) WHERE id <= ? AND id > ? ORDER BY id LIMIT ?`).all(through, after, limit + 1)
    }
    const more = rows.length > limit
    rows = rows.slice(0, limit)
    const next = more
      ? JSON.stringify({ v: 1, collection, actor: actor.id, revision, through, after: rows.at(-1).id, task_state: taskState, owner, task_sequence: taskSequence })
      : null
    const row = { tasks: (r) => this.summarize(Store.row(r)), publications: (r) => this.publicationRow(r, 512), findings: (r) => this.findingRow(r) }[collection]
    return {
      collection,
      items: rows.map(row),
      total,
      next_cursor: next,
      through_sequence: through,
      observed_sequence: sequence,
      request_revision: revision,
      new_events_available: sequence > through,
    }
  }

  // One task, finding or publication in full. A publication's files come as byte ranges
  // (`offset`, `max_bytes`), at most 64 KiB in all; bytes that are not UTF-8 are not shown.
  expand(_actor, args) {
    const targets = ['publication_id', 'task_id', 'finding_id'].filter((k) => args[k] !== undefined)
    if (targets.length !== 1) throw new BoardError('expand exactly one publication_id, task_id or finding_id')
    if (targets[0] === 'task_id') {
      const t = this.task(positiveId(args, 'task_id'))
      return { ...t, author: this.label(t.author), owner: this.label(t.owner) }
    }
    if (targets[0] === 'finding_id') {
      const id = positiveId(args, 'finding_id')
      const r = this.db.prepare(`SELECT * FROM (${SOURCES.findings}) WHERE id = ?`).get(id)
      if (!r) throw new BoardError('unknown finding')
      return { finding_id: id, author: this.label(r.actor), text: r.text }
    }
    const id = positiveId(args, 'publication_id')
    const { actor, ...body } = this.publicationBody(id)
    const chosen = selectFiles(body.files, args.paths)
    if (chosen.length > EXPAND_LIMITS.files) throw new BoardError('expand at most 32 selected files at a time')
    const offset = count(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
    const maxBytes = count(args, 'max_bytes', EXPAND_LIMITS.maxBytes, 1, EXPAND_LIMITS.maxBytesCap)
    let remaining = EXPAND_LIMITS.total
    const files = chosen.map((f) => {
      if (!f.result) return f
      const length = Math.min(maxBytes, remaining, Math.max(f.result.bytes - offset, 0))
      const slice = length ? this.blobRange(f.result.sha256, offset, length) : Buffer.alloc(0)
      remaining -= slice.length
      const range = { offset, returned_bytes: slice.length, total_bytes: f.result.bytes }
      if (isUtf8(slice)) return { ...f, ...range, text: slice.toString('utf8') }
      return { ...f, ...range, binary: true, note: 'Selected bytes are not UTF-8; apply imports the exact file.' }
    })
    return { publication_id: id, author: this.label(actor), ...body, files }
  }

  knownVersion(p, v) {
    return !!this.db.prepare('SELECT 1 FROM publication_files WHERE path = ? AND result = ?').get(p, JSON.stringify(v ?? null))
  }

  // Imports whole files from a publication. A local file is compatible when it equals the base,
  // the version being applied, or any version someone published for that path; anything else
  // is the caller's own unpublished work, and one such file refuses the whole apply.
  // The plan is recorded before the first write, so a crash mid-way is reconciled on retry.
  apply(actor, key, digest, args) {
    const { cwd } = args
    const id = positiveId(args, 'publication_id')
    const selected = selectFiles(this.publicationBody(id).files, args.paths)
    if (!selected.length) throw new BoardError('publication has no selected files')
    const conflicts = []
    const contents = new Map()
    for (const f of selected) {
      const current = local(cwd, f.path, (f.result ?? f.base)?.executable)?.version ?? null
      if (!sameVersion(current, f.base) && !sameVersion(current, f.result) && !this.knownVersion(f.path, current)) conflicts.push(f.path)
      if (f.result) contents.set(f.path, this.blob(f.result.sha256))
    }
    if (conflicts.length) {
      throw new BoardError(`local changes diverged from the base and from published versions: ${conflicts.join(', ')}. Reconcile these files explicitly before importing.`)
    }
    const detail = { publication_id: id, files: selected.map((f) => ({ path: f.path, result: f.result })) }
    this.db
      .prepare("INSERT INTO requests(actor, key, name, digest, state, detail) VALUES (?, ?, 'apply', ?, 'applying', ?)")
      .run(actor.id, key, digest, JSON.stringify(detail))
    for (const f of detail.files) {
      const full = path.join(cwd, f.path)
      if (!f.result) {
        fs.rmSync(full, { force: true })
        continue
      }
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, contents.get(f.path))
      fs.chmodSync(full, f.result.executable ? 0o755 : 0o644)
    }
    return this.reconcileApply(actor, key, cwd, detail)
  }

  reconcileApply(actor, key, cwd, detail) {
    for (const f of detail.files) {
      if (!sameVersion(local(cwd, f.path, f.result?.executable)?.version, f.result)) {
        throw new BoardError(`previous import outcome is unknown or local files changed at ${f.path}; no success is recorded and no additional files were written`)
      }
    }
    return this.tx(() => {
      const result = { publication_id: detail.publication_id, paths: detail.files.map((f) => f.path), confirmed: true }
      this.append(actor, 'apply', result)
      this.db.prepare("UPDATE requests SET state = 'done', response = ? WHERE actor = ? AND key = ?").run(JSON.stringify(result), actor.id, key)
      return result
    })
  }

  // Read-only: the events after `since`, for a viewer that folds them into its own model.
  export({ since = 0 } = {}) {
    const after = count({ since }, 'since', 0, 0, Number.MAX_SAFE_INTEGER)
    return {
      sequence: this.lastSeq(),
      events: this.db
        .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq')
        .all(after)
        .map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
    }
  }

  // Read-only: one published file as a unified diff against its base.
  diff(args) {
    const id = positiveId(args, 'publication_id')
    const p = checkPath(args.path)
    const f = this.publicationBody(id).files.find((x) => x.path === p)
    if (!f) throw new BoardError(`${p} is not in publication`)
    const before = f.base ? this.blob(f.base.sha256) : Buffer.alloc(0)
    const after = f.result ? this.blob(f.result.sha256) : Buffer.alloc(0)
    const head = { publication_id: id, path: p, change: f.change }
    if (!isUtf8(before) || !isUtf8(after)) return { ...head, binary: true }
    return { ...head, diff: unifiedDiff(before, after, f.base ? `a/${p}` : '/dev/null', f.result ? `b/${p}` : '/dev/null') }
  }
}

function unifiedDiff(before, after, a, b) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-diff-'))
  try {
    fs.writeFileSync(path.join(tmp, 'a'), before)
    fs.writeFileSync(path.join(tmp, 'b'), after)
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', 'a', 'b'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
      return ''
    } catch (err) {
      if (err.status !== 1) throw err
      return String(err.stdout).replace(/^diff --git .*\n(index .*\n)?/, '').replace(/^--- a\/a$/m, `--- ${a}`).replace(/^\+\+\+ b\/b$/m, `+++ ${b}`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const always = () => true
const changes = (role, names) => names.map((c) => [c, { mutates: always, role }])
// role: who may make the change; a command with no role is open to the parent and the workers.
const COMMANDS = {
  ...Object.fromEntries([
    ...changes(undefined, ['task_create', 'task_release', 'worker_stop']),
    ...changes('worker', ['task_claim', 'task_update', 'task_split', 'task_finish', 'publish', 'apply', 'complete']),
    ...changes('parent', ['task_close', 'request', 'end']),
  ]),
  status: { mutates: (args) => STATUS_FIELDS.some((k) => args[k] !== undefined), role: 'worker', read: 'look' },
  list: {},
  expand: {},
  export: { readOnly: true },
  diff: { readOnly: true },
}
const PARENT_CHANGES = Object.keys(COMMANDS).filter((c) => COMMANDS[c].mutates && COMMANDS[c].role !== 'worker')

// node store.mjs <command>, with {dir, tasksDir, base, parent, roster, actor: {id, name}, cwd, ...args}
// on stdin. Prints {ok: true, ...} or {ok: false, error}; a rejected call is not a crash, so it exits 0.
// A tool command answers {result, board}, plus request_updates for a worker that has not seen the
// latest request revisions. `export` and `diff` are for viewers: they open the store read-only,
// need no actor and write nothing.
export function main(command, request) {
  if (!Object.hasOwn(COMMANDS, command)) return { ok: false, error: `unknown command: ${command}` }
  const spec = COMMANDS[command]
  const { dir, tasksDir, base, parent, roster, actor: caller, ...args } = request
  if (!dir) return { ok: false, error: 'dir is required' }
  if (command === 'export' && !fs.existsSync(path.join(dir, 'swarm.db'))) return { ok: true, sequence: 0, events: [] }
  if (!spec.readOnly && !caller?.id) return { ok: false, error: 'actor.id is required' }
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGUMENT_BYTES) {
    return { ok: false, error: 'the call exceeds 128 KiB; publish files and expand them selectively' }
  }
  const actor = parent && caller?.id === parent ? { id: caller.id, name: 'parent', parent: true } : caller
  const mutates = !!spec.mutates?.(args)
  if (mutates && spec.role === 'worker' && actor.parent) {
    return { ok: false, error: `the parent cannot ${command}; it acts with ${PARENT_CHANGES.join(', ')}` }
  }
  if (mutates && spec.role === 'parent' && !actor.parent) return { ok: false, error: `only the parent can ${command}` }
  let store
  try {
    store = new Store({ dir, tasksDir, base, parent, roster, readOnly: !!spec.readOnly })
    if (spec.readOnly) return { ok: true, ...store[command](args) }
    const updates = actor.parent ? [] : store.requestUpdates(actor.id)
    const result = mutates ? store.mutate(actor, command, args) : store[spec.read ?? command](actor, args)
    return { ok: true, result, board: store.view(), ...(updates.length ? { request_updates: updates } : {}) }
  } catch (err) {
    if (err instanceof BoardError) return { ok: false, error: err.message }
    throw err
  } finally {
    store?.close()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const request = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  process.stdout.write(`${JSON.stringify(main(process.argv[2], request))}\n`)
}

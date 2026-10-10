// The swarm's shared store: one append-only event log in SQLite, written by every worker's
// tool calls, each one a short `node store.mjs <command>` process with the request on stdin.
// The queue is derived by replaying the log. Ported from DeLM's board/shared_context.py.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const FILE_LIMITS = { files: 40, totalBytes: 400_000, fileBytes: 200_000 }
// A tool call is one $.process.run, which gives up at 30 s.
const WAIT_CAP_SECONDS = 25
const WAIT_POLL_MS = 250
const NOTE_TYPES = ['FACT', 'FAIL']

class BoardError extends Error {}

// The id an event is about: an item id for claim and done, else the entry's own id.
const touchedId = (kind, payload) => (kind === 'claim' || kind === 'done' ? payload.item : payload.id)

function limited(field, value) {
  if (typeof value !== 'string' || !value.trim()) throw new BoardError(`${field} must be non-empty text`)
  return value
}

const normalized = (subject) => subject.toLowerCase().split(/\s+/).filter(Boolean).join(' ')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const newId = () => randomUUID().replace(/-/g, '').slice(0, 12)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]))
  }
  return value
}
const fingerprint = (value) => sha256(JSON.stringify(stable(value)))

function checkPath(p) {
  if (typeof p !== 'string' || !p || p !== p.trim()) throw new BoardError('every attached file needs a path')
  const posix = p.replace(/\\/g, '/')
  if (path.posix.isAbsolute(posix) || path.win32.isAbsolute(p)) {
    throw new BoardError(`${p}: use a path relative to your workspace`)
  }
  const parts = posix.split('/')
  if (parts.includes('..') || ['', '.'].includes(parts.at(-1))) throw new BoardError(`${p}: path must not contain '..'`)
  return path.posix.normalize(posix)
}

const metadata = (f) => ({
  path: f.path,
  bytes: f.bytes,
  change: f.change,
  sha256: f.sha256,
  ...(f.originalError ? { originalError: f.originalError } : {}),
})

class Store {
  // tasksDir: the Claude Code task list the store mirrors the queue into.
  // base: the commit the workers' worktrees start from; the "original" of an attached file.
  constructor({ dir, tasksDir, base } = {}) {
    this.dir = dir
    this.tasksDir = tasksDir
    this.base = base
    fs.mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(path.join(dir, 'swarm.db'), { timeout: 10_000 })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      actor TEXT NOT NULL, name TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bodies (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, actor TEXT NOT NULL, files TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS publications (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL, item_id INTEGER,
      payload TEXT NOT NULL, fingerprint TEXT NOT NULL, request_id TEXT, UNIQUE(actor, request_id));
    CREATE INDEX IF NOT EXISTS events_kind ON events(kind, actor)`)
  }

  close() {
    this.db.close()
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    this.touched = new Set()
    this.nameCache = null
    try {
      const result = fn()
      // Written under the write lock, so two workers' files cannot land out of order.
      // A COMMIT that fails after this leaves a file ahead of the log until the next write to that item.
      this.writeTaskFiles()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  append(actor, kind, payload) {
    const r = this.db
      .prepare('INSERT INTO events(actor, name, kind, payload) VALUES (?, ?, ?, ?)')
      .run(actor.id, actor.name ?? null, kind, JSON.stringify(payload))
    if (kind === 'item' || kind === 'claim' || kind === 'done') this.touched.add(touchedId(kind, payload))
    this.nameCache = null
    return Number(r.lastInsertRowid)
  }

  events(...kinds) {
    return this.db
      .prepare(`SELECT seq, actor, kind, payload FROM events WHERE kind IN (${kinds.map(() => '?').join(',')}) ORDER BY seq`)
      .all(...kinds)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  names() {
    this.nameCache ??= Object.fromEntries(
      this.db.prepare('SELECT actor, name FROM events WHERE name IS NOT NULL ORDER BY seq').all().map((r) => [r.actor, r.name]),
    )
    return this.nameCache
  }

  label(actorId) {
    return this.names()[actorId] ?? actorId
  }

  queueState() {
    const items = new Map()
    for (const { actor, kind, payload } of this.events('item', 'claim', 'done')) {
      if (kind === 'item') items.set(payload.id, { ...payload, state: 'open' })
      else if (kind === 'claim') Object.assign(items.get(payload.item), { state: 'claimed', owner: actor })
      else if (items.has(payload.item)) {
        Object.assign(items.get(payload.item), {
          state: 'done',
          summary: payload.summary,
          owner: actor,
          publicationId: payload.publicationId,
        })
      }
    }
    return [...items.values()]
  }

  lastSeq() {
    return this.db.prepare('SELECT MAX(seq) AS s FROM events').get().s ?? 0
  }

  lastRead(actorId) {
    return this.db.prepare("SELECT MAX(seq) AS s FROM events WHERE actor = ? AND kind = 'read'").get(actorId).s
  }

  currentStatus(actorId) {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE actor = ? AND kind = 'status' ORDER BY seq DESC LIMIT 1")
      .get(actorId)
    return row ? JSON.parse(row.payload).text : null
  }

  view(reader) {
    const label = (id) => this.label(id)
    const status = {}
    for (const { actor, payload } of this.events('status')) status[actor] = payload.text
    const attached = Object.fromEntries(this.events('body').map((e) => [e.payload.id, e.payload.files]))
    const queue = this.queueState().map((item) => {
      const files = attached[item.publicationId]
      return { ...item, ...(item.owner ? { owner: label(item.owner) } : {}), ...(files ? { files } : {}) }
    })
    const notes = this.events('note').map(({ actor, payload }) => ({
      ...payload,
      actor: label(actor),
      ...(attached[payload.id] ? { files: attached[payload.id] } : {}),
    }))
    return {
      reader: label(reader),
      status: Object.entries(status).map(([actor, text]) => ({ actor: label(actor), text })),
      queue,
      notes,
      seq: this.lastSeq(),
    }
  }

  static compact(item) {
    const keep = ['id', 'subject', 'state', 'owner', 'files', 'publicationId']
    return Object.fromEntries(Object.entries(item).filter(([k]) => keep.includes(k)))
  }

  // Active work plus what changed since this actor's last served view. An unchanged active item
  // comes compact: its detail was served when it appeared, and `read` with `full` serves it again.
  // A read or a wait lists the whole active queue that way; a write's answer carries only changes.
  served(actor, via, full = false) {
    const result = this.view(actor.id)
    const previous = this.lastRead(actor.id)
    result.full = full || previous == null
    if (!result.full) {
      const changed = new Set()
      const statuses = new Set()
      for (const row of this.db.prepare('SELECT actor, kind, payload FROM events WHERE seq > ?').iterate(previous)) {
        if (row.kind === 'status') statuses.add(this.label(row.actor))
        else if (['item', 'note', 'body', 'claim', 'done'].includes(row.kind)) changed.add(touchedId(row.kind, JSON.parse(row.payload)))
      }
      const listed = via === 'read' || via === 'wait'
      result.queue = result.queue.flatMap((i) => {
        if (changed.has(i.id) || changed.has(i.publicationId)) return [i]
        return listed && i.state !== 'done' ? [Store.compact(i)] : []
      })
      result.notes = result.notes.filter((n) => changed.has(n.id))
      result.status = result.status.filter((s) => statuses.has(s.actor))
    }
    this.append(actor, 'read', { via, seq: result.seq })
    return result
  }

  peerUpdates(actorId, previous) {
    const woken = this.db
      .prepare("SELECT actor, kind FROM events WHERE seq > ? AND actor != ? AND kind IN ('item', 'note', 'body', 'done') ORDER BY seq")
      .all(previous ?? 0, actorId)
    if (!woken.length) return null
    this.nameCache = null
    return woken.map((r) => ({ actor: this.label(r.actor), kind: r.kind }))
  }

  published(target) {
    return this.events('done', 'body', 'note').some(({ payload }) =>
      [payload.item, payload.id, payload.publicationId].includes(target),
    )
  }

  nextItemId() {
    const row = this.db.prepare("SELECT MAX(json_extract(payload, '$.id')) AS m FROM events WHERE kind = 'item'").get()
    let top = row.m ?? 0
    if (this.tasksDir && fs.existsSync(this.tasksDir)) {
      for (const f of fs.readdirSync(this.tasksDir)) {
        const n = /^(\d+)\.json$/.exec(f)?.[1]
        if (n) top = Math.max(top, Number(n))
      }
      try {
        top = Math.max(top, Number(fs.readFileSync(path.join(this.tasksDir, '.highwatermark'), 'utf8')) || 0)
      } catch {}
    }
    return top + 1
  }

  taskFile(item) {
    const status = { open: 'pending', claimed: 'in_progress', done: 'completed' }[item.state]
    const description = item.state === 'done' ? `${item.detail}\n\n**Done:** ${item.summary}` : item.detail
    return {
      id: String(item.id),
      subject: item.subject,
      description,
      activeForm: item.subject,
      status,
      blocks: [],
      blockedBy: [],
      ...(item.owner ? { owner: this.label(item.owner) } : {}),
      metadata: { swarm: true },
    }
  }

  writeTaskFiles() {
    if (!this.tasksDir || !this.touched.size) return
    fs.mkdirSync(this.tasksDir, { recursive: true })
    for (const item of this.queueState().filter((i) => this.touched.has(i.id))) {
      const file = path.join(this.tasksDir, `${item.id}.json`)
      const tmp = `${file}.${process.pid}.tmp`
      try {
        fs.writeFileSync(tmp, `${JSON.stringify(this.taskFile(item), null, 2)}\n`)
        renameRetry(tmp, file)
      } catch (err) {
        fs.rmSync(tmp, { force: true })
        throw err
      }
    }
  }

  original(cwd, p) {
    if (!this.base) return null
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      if (!git('ls-tree', this.base, '--', p).length) return null
      return git('show', `${this.base}:./${p}`)
    } catch (err) {
      return { error: String(err.stderr || err.message).trim().slice(0, 300) }
    }
  }

  // Reads the attached files from the caller's workspace and pairs each with its original;
  // done before the transaction opens, so no git call holds the write lock.
  snapshot(cwd, paths) {
    if (!Array.isArray(paths) || !paths.length) throw new BoardError('files must be a non-empty list of paths')
    if (paths.length > FILE_LIMITS.files) throw new BoardError(`${paths.length} files attached; at most ${FILE_LIMITS.files} allowed`)
    const seen = new Set()
    let total = 0
    return paths.map((raw) => {
      const p = checkPath(raw)
      if (seen.has(p)) throw new BoardError(`${p}: attached twice`)
      seen.add(p)
      const full = path.join(cwd, p)
      let data
      try {
        data = fs.readFileSync(full)
      } catch {
        throw new BoardError(`${p}: no such file in your workspace`)
      }
      if (data.length > FILE_LIMITS.fileBytes) {
        throw new BoardError(`${p} is ${data.length} bytes; at most ${FILE_LIMITS.fileBytes} per file`)
      }
      total += data.length
      if (total > FILE_LIMITS.totalBytes) {
        throw new BoardError(`attached files total more than ${FILE_LIMITS.totalBytes} bytes`)
      }
      const mode = fs.statSync(full).mode & 0o111 ? 'x' : '-'
      const hash = sha256(data)
      const orig = this.original(cwd, p)
      const base = { path: p, content: data.toString('utf8'), bytes: data.length, sha256: hash, mode }
      if (orig?.error) return { ...base, change: 'unknown', originalSha256: null, original: null, originalError: orig.error }
      if (orig == null) return { ...base, change: 'new', originalSha256: null, original: null }
      const originalSha256 = sha256(orig)
      return {
        ...base,
        change: originalSha256 === hash ? 'unchanged' : 'modified',
        originalSha256,
        original: orig.toString('utf8'),
      }
    })
  }

  register(actor, entryId, stored) {
    const seq = this.append(actor, 'body', { id: entryId, files: stored.map(metadata) })
    this.db
      .prepare('INSERT INTO bodies(id, seq, actor, files) VALUES (?, ?, ?, ?)')
      .run(entryId, seq, actor.id, JSON.stringify(stored))
  }

  publicationId(entryId) {
    const byId = this.db.prepare('SELECT id FROM publications WHERE id = ?').get(String(entryId))
    if (byId) return byId.id
    const byItem = this.db
      .prepare('SELECT id FROM publications WHERE item_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(Number(entryId) || -1)
    return byItem ? byItem.id : String(entryId)
  }

  body(entryId) {
    const row = this.db.prepare('SELECT actor, seq, files FROM bodies WHERE id = ?').get(this.publicationId(entryId))
    if (!row) throw new BoardError('no files are attached to an entry with this id')
    return { author: this.label(row.actor), seq: row.seq, files: JSON.parse(row.files) }
  }

  // Every version of each path that agents other than `actor` registered: path → content hash → seq.
  // A copy equal to one came from an apply, so a peer version may replace it, unless that copy
  // was registered after the one being applied. The caller's own versions are never overwritten.
  // Reads the body events' metadata, never the stored contents.
  peerVersions(actorId) {
    const versions = new Map()
    for (const { seq, actor, payload } of this.events('body')) {
      if (actor === actorId) continue
      for (const f of payload.files) {
        const byHash = versions.get(f.path) ?? new Map()
        byHash.set(f.sha256, Math.max(byHash.get(f.sha256) ?? 0, seq))
        versions.set(f.path, byHash)
      }
    }
    return versions
  }

  static select(files, paths) {
    if (!paths?.length) return files
    const byPath = new Map(files.map((f) => [f.path, f]))
    const missing = paths.filter((p) => !byPath.has(p))
    if (missing.length) throw new BoardError(`no attached file named ${missing.join(', ')}`)
    return paths.map((p) => byPath.get(p))
  }

  replayed(actor, requestId, print) {
    if (requestId == null) return null
    limited('requestId', requestId)
    const row = this.db.prepare('SELECT * FROM publications WHERE actor = ? AND request_id = ?').get(actor.id, requestId)
    if (row && row.fingerprint !== print) throw new BoardError('requestId was already used for different content')
    return row
  }

  recordPublication(actor, kind, id, payload, requestId, print, itemId = null) {
    this.db
      .prepare('INSERT INTO publications(id, actor, kind, item_id, payload, fingerprint, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, actor.id, kind, itemId, JSON.stringify(payload), print, requestId ?? null)
    return { id, kind, item_id: itemId }
  }

  publicationResponse(actor, row, via) {
    const response = { publicationId: row.id, view: this.served(actor, via) }
    if (row.kind === 'done') {
      response.item = row.item_id
      response.queueEmpty = this.queueState().every((i) => i.state === 'done')
    }
    return response
  }

  // Claims `target` for the actor, who must hold nothing else; `target` may be one the caller just created.
  take(actor, queue, target, via) {
    const held = queue.find((i) => i.state === 'claimed' && i.owner === actor.id)
    if (held) throw new BoardError(`you already hold an unfinished item: ${held.id}`)
    this.append(actor, 'claim', { item: target.id })
    this.append(actor, 'status', { text: target.subject, auto: true })
    return { item: target.id, owner: actor.name ?? actor.id, state: 'claimed', won: true, view: this.served(actor, via) }
  }

  // `entry(id)` checks the request and returns the event payload, `after` runs once it is logged;
  // a retried requestId answers as the first call did.
  publish(actor, kind, { files, cwd, requestId, print }, entry, after = () => {}) {
    const stored = files?.length ? this.snapshot(cwd, files) : []
    const fp = fingerprint({ ...print, files: stored.map((f) => [f.path, f.sha256]) })
    return this.tx(() => {
      const previous = this.replayed(actor, requestId, fp)
      if (previous) return this.publicationResponse(actor, previous, kind)
      const id = newId()
      const payload = entry(id)
      const row = this.recordPublication(actor, kind, id, payload, requestId, fp, payload.item ?? null)
      this.append(actor, kind, payload)
      if (stored.length) this.register(actor, id, stored)
      after()
      return this.publicationResponse(actor, row, kind)
    })
  }

  writeItem(actor, subject, detail) {
    const id = this.nextItemId()
    this.append(actor, 'item', { id, subject, detail })
    return id
  }

  // Any worker may add work; a subject that matches an existing item keeps that item and its state.
  add(actor, { items }) {
    if (!Array.isArray(items) || !items.length) throw new BoardError('add needs a non-empty list of items')
    const checked = items.map((i) => {
      if (!i || typeof i !== 'object') throw new BoardError('each item needs a subject and detail')
      return [limited('subject', i.subject), limited('detail', i.detail)]
    })
    return this.tx(() => {
      const known = new Map(this.queueState().map((i) => [normalized(i.subject), i]))
      const result = checked.map(([subject, detail]) => {
        let existing = known.get(normalized(subject))
        const created = !existing
        if (created) {
          existing = { id: this.writeItem(actor, subject, detail), subject, detail, state: 'open' }
          known.set(normalized(subject), existing)
        }
        return {
          id: existing.id,
          state: existing.state,
          created,
          ...(existing.owner ? { owner: this.label(existing.owner) } : {}),
        }
      })
      return { items: result, view: this.served(actor, 'add') }
    })
  }

  claim(actor, { item }) {
    return this.tx(() => {
      const queue = this.queueState()
      const target = queue.find((i) => i.id === Number(item))
      if (!target) throw new BoardError('unknown item')
      if (target.state !== 'open') {
        return { item: target.id, owner: this.label(target.owner), state: target.state, won: false, view: this.served(actor, 'claim') }
      }
      return this.take(actor, queue, target, 'claim')
    })
  }

  // Creates and claims one scope in one step. Matching subjects name the same work; a retry
  // answers with the existing ownership or completion.
  reserve(actor, { subject, detail }) {
    limited('subject', subject)
    limited('detail', detail)
    return this.tx(() => {
      const queue = this.queueState()
      let target = queue.find((i) => normalized(i.subject) === normalized(subject))
      if (target && target.state !== 'open') {
        const answer = {
          item: target.id,
          owner: this.label(target.owner),
          state: target.state,
          won: target.state === 'claimed' && target.owner === actor.id,
          created: false,
          view: this.served(actor, 'reserve'),
        }
        // The incremental view may already have left this completion out.
        if (target.state === 'done') Object.assign(answer, { publicationId: target.publicationId, summary: target.summary })
        return answer
      }
      const created = !target
      if (created) target = { id: this.writeItem(actor, subject, detail), subject }
      return { ...this.take(actor, queue, target, 'reserve'), created }
    })
  }

  done(actor, { item, summary, files, cwd, requestId }) {
    limited('summary', summary)
    const print = { kind: 'done', item: Number(item), summary }
    let target
    return this.publish(
      actor,
      'done',
      { files, cwd, requestId, print },
      (publicationId) => {
        target = this.queueState().find((i) => i.id === Number(item))
        if (!target) throw new BoardError('unknown item')
        if (target.state !== 'claimed' || target.owner !== actor.id) {
          throw new BoardError('only the agent holding this item may complete it')
        }
        return { item: target.id, summary, publicationId }
      },
      () => this.append(actor, 'status', { text: `done: ${target.subject}`, auto: true }),
    )
  }

  note(actor, { type, text, scope, basis, files, cwd, requestId }) {
    if (!NOTE_TYPES.includes(type)) throw new BoardError('note type must be FACT or FAIL')
    const payload = { type, text: limited('text', text), scope: limited('scope', scope), basis: limited('basis', basis) }
    return this.publish(actor, 'note', { files, cwd, requestId, print: { kind: 'note', payload } }, (id) => ({ ...payload, id }))
  }

  status(actor, { text }) {
    limited('text', text)
    return this.tx(() => {
      this.append(actor, 'status', { text })
      return { saved: true, view: this.served(actor, 'status') }
    })
  }

  // A view now, or as soon as a peer posts work (`wait` seconds, at most 25). The wait polls
  // without holding the write lock. A wait that times out serves nothing and leaves the cursor.
  read(actor, { full = false, wait = 0, target } = {}) {
    if (!wait) return this.tx(() => this.served(actor, 'read', full))
    const seconds = Math.min(Number(wait), WAIT_CAP_SECONDS)
    const previous = this.tx(() => {
      if (target != null) {
        const text = `waiting for ${target}`
        if (this.currentStatus(actor.id) !== text) this.append(actor, 'status', { text, auto: true })
      }
      return this.lastRead(actor.id)
    })
    const already = target != null && this.published(target)
    const started = Date.now()
    let woke = null
    for (;;) {
      const events = this.peerUpdates(actor.id, previous)
      if (events) woke = { by: 'update', events }
      else if (already) woke = { by: 'already', events: [] }
      if (woke || Date.now() - started >= seconds * 1000) break
      sleep(WAIT_POLL_MS)
    }
    const waited = (Date.now() - started) / 1000
    return this.tx(() => {
      const wokeBy = woke ? woke.by : 'timeout'
      this.append(actor, 'wait', { target: target ?? null, requested: seconds, waited, wokeBy })
      if (!woke) return { reader: actor.name ?? actor.id, updates: false, waited, wokeBy, queue: [], notes: [], status: [] }
      return { ...this.served(actor, 'wait', full), updates: true, waited, wokeBy, woken: woke.events }
    })
  }

  // The files behind an entry as diffs against their originals, or the named files in full.
  // Bodies never change once written, so the diffs are built outside the write lock.
  expand(actor, { id, paths }) {
    const { author, files } = this.body(id)
    const shown = Store.select(files, paths).map((f) => {
      const whole = paths?.length || f.original == null
      return {
        ...metadata(f),
        shown: whole ? 'full' : 'diff',
        text: whole ? f.content : unifiedDiff(f.original, f.content, `original/${f.path}`, `${author}/${f.path}`),
      }
    })
    this.tx(() => this.append(actor, 'expand', { id, files: shown.map((f) => f.path) }))
    return { id, author, files: shown }
  }

  // Copies a peer's attached files into the caller's workspace. Per file: a copy equal to the
  // attached version is `unchanged`; one equal to the original or to a peer's version is overwritten
  // (`write`), unless that peer version is newer than the one applied (`kept`); anything else is the
  // caller's own work (`conflict`), and one conflict refuses the whole apply.
  apply(actor, { id, paths, cwd }) {
    return this.tx(() => {
      const { author, seq, files } = this.body(id)
      const decisions = {}
      const granted = []
      const versions = this.peerVersions(actor.id)
      for (const f of Store.select(files, paths)) {
        const full = path.join(cwd, f.path)
        const current = fs.existsSync(full) ? sha256(fs.readFileSync(full)) : null
        const peers = versions.get(f.path) ?? new Map()
        if (current === f.sha256) decisions[f.path] = 'unchanged'
        else if (peers.has(current) && peers.get(current) > seq) decisions[f.path] = 'kept'
        else if (current == null || (!f.originalError && current === f.originalSha256) || peers.has(current)) {
          decisions[f.path] = 'write'
          granted.push(f)
        } else decisions[f.path] = 'conflict'
      }
      const applied = !Object.values(decisions).includes('conflict')
      const written = []
      if (applied) {
        for (const f of granted) {
          const full = path.join(cwd, f.path)
          fs.mkdirSync(path.dirname(full), { recursive: true })
          fs.writeFileSync(full, f.content)
          if (f.mode === 'x') fs.chmodSync(full, 0o755)
          written.push(f.path)
        }
      }
      this.append(actor, 'apply', { id, decisions, applied, written })
      return { id, author, applied, decisions, written, view: this.served(actor, 'apply') }
    })
  }

  export() {
    return this.db
      .prepare('SELECT * FROM events ORDER BY seq')
      .all()
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
  }
}

// On Windows a rename over a file that a watcher has open fails for a moment.
function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to)
    } catch (err) {
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
      sleep(20)
    }
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

const COMMANDS = ['add', 'claim', 'reserve', 'done', 'note', 'status', 'read', 'expand', 'apply', 'export']

// node store.mjs <command>, with {dir, tasksDir, base, actor: {id, name}, cwd, ...args} on stdin.
// Prints {ok: true, ...result} or {ok: false, error}; a rejected write is not a crash, so it exits 0.
export function main(command, request) {
  if (!COMMANDS.includes(command)) return { ok: false, error: `unknown command: ${command}` }
  const { dir, tasksDir, base, actor, ...args } = request
  if (!dir) return { ok: false, error: 'dir is required' }
  if (command !== 'export' && !actor?.id) return { ok: false, error: 'actor.id is required' }
  const store = new Store({ dir, tasksDir, base })
  try {
    return { ok: true, ...(command === 'export' ? { events: store.export() } : store[command](actor, args)) }
  } catch (err) {
    if (err instanceof BoardError) return { ok: false, error: err.message }
    throw err
  } finally {
    store.close()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const request = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  process.stdout.write(`${JSON.stringify(main(process.argv[2], request))}\n`)
}

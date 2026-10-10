// Builds the test swarm by driving the real store through one simulated hour: a parent, 3 workers, 9 tasks.
// node test/fixture/build.mjs [--out <dir>] [--store <store.mjs>] [--step-ms <n>] [--running]
// --step-ms waits n ms between steps, so a running viewer shows the swarm grow live.
// --running leaves swarm.json in the running state, as a swarm that has not ended.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
export const SUFFIX = 'a3f9c2'
export const LIST_ID = `swarm-add-csv-export-to-the-${SUFFIX}`
const T0 = Date.parse('2026-10-10T09:00:00Z')
const GOAL = 'Add CSV export to the logview CLI: `logview --format csv <file>` writes one RFC 4180 row per log record, with tests and README usage.'

export async function build({ out, store = path.join(here, '..', '..', '..', 'scripts', 'store.mjs'), stepMs = 0, running = false, listId = LIST_ID }) {
  const { main } = await import(pathToFileURL(path.resolve(store)).href)
  const dir = path.resolve(out)
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]

  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['swarm.db', 'swarm.db-wal', 'swarm.db-shm', 'swarm.json']) fs.rmSync(path.join(dir, f), { force: true })
  const work = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'swarm-fixture-'))

  const repo = path.join(work, 'repo')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const put = (root, file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }

  const BASE_FILES = {
    'package.json': '{\n  "name": "logview",\n  "version": "0.3.0",\n  "bin": { "logview": "src/cli.js" },\n  "scripts": { "test": "node --test" }\n}\n',
    'README.md': '# logview\n\nPrint structured logs.\n\n    logview <file>\n',
    'src/cli.js': "#!/usr/bin/env node\nconst minimist = require('minimist')\nconst { parse } = require('./parser')\nconst args = minimist(process.argv.slice(2), { string: ['format'] })\n// --format is reserved for later output formats\nfor (const r of parse(require('fs').readFileSync(args._[0], 'utf8'))) console.log(r.ts, r.level, r.message)\n",
    'src/parser.js': "exports.parse = (text) => text.split('\\n').filter(Boolean).map((line) => {\n  const [ts, level, ...rest] = line.split(' ')\n  return { ts, level, message: rest.join(' ') }\n})\n",
    'test/parser.test.js': "const test = require('node:test')\nconst assert = require('node:assert')\nconst { parse } = require('../src/parser')\ntest('parses one line', () => assert.equal(parse('2026-01-01T00:00:00Z INFO hi')[0].level, 'INFO'))\n",
  }
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  for (const [f, t] of Object.entries(BASE_FILES)) put(repo, f, t)
  git(repo, 'add', '-A')
  git(repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'logview 0.3.0')
  const base = git(repo, 'rev-parse', 'HEAD')

  const workers = [1, 2, 3].map((n) => ({ name: `w${n}-${SUFFIX}`, sessionId: `0000000${n}-f1x7-4e00-8000-00000000000${n}` }))
  const wt = {}
  for (const w of workers) {
    wt[w.name] = path.join(work, w.name)
    git(repo, 'worktree', 'add', '-q', '-b', w.name, wt[w.name])
  }
  const [w1, w2, w3] = workers.map((w) => ({ id: w.sessionId, name: w.name }))
  const parent = { id: '00000000-pare-4e00-8000-000000000000', name: 'parent' }

  const db = () => new DatabaseSync(path.join(dir, 'swarm.db'))
  let lastSeq = 0
  let minute = 0
  let keys = 0

  // Each step's events get the simulated clock, so the fixture always shows the same hour.
  function stamp() {
    if (!fs.existsSync(path.join(dir, 'swarm.db'))) return
    const d = db()
    const rows = d.prepare('SELECT seq FROM events WHERE seq > ? ORDER BY seq').all(lastSeq)
    const set = d.prepare('UPDATE events SET ts = ? WHERE seq = ?')
    rows.forEach((row, i) => {
      set.run(new Date(T0 + minute * 60_000 + i * 200).toISOString(), row.seq)
      lastSeq = row.seq
    })
    d.close()
  }

  function attempt(command, actor, args = {}) {
    const r = main(command, { dir, base, parent: parent.id, roster: workers, actor, cwd: wt[actor.name], idempotency_key: `k${++keys}`, ...args })
    stamp()
    return r
  }

  function call(command, actor, args) {
    const r = attempt(command, actor, args)
    if (!r.ok) throw new Error(`${command} by ${actor.name}: ${r.error}`)
    return r.result ?? r
  }

  const versions = {}
  const lost = []
  const create = (actor, title, description) => call('task_create', actor, { title, description }).task_id
  function claim(actor, id) {
    const r = attempt('task_claim', actor, { task_id: id })
    if (!r.ok) {
      lost.push(`${actor.name.slice(0, 2)}#${id}`)
      return false
    }
    versions[id] = r.result.version
    return true
  }
  const finish = (actor, id, summary) => call('task_finish', actor, { task_id: id, expected_version: versions[id], summary })
  const publish = (actor, summary, paths) => call('publish', actor, { summary, paths }).publication_id
  const finding = (actor, text) => call('status', actor, { finding: text })
  const look = (actor) => call('status', actor, {})

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function at(m, fn) {
    minute = m
    fn()
    if (stepMs) await sleep(stepMs)
  }

  const registry = { listId, group: `logview/${listId}`, goal: GOAL, parent: parent.id, base, workers, state: 'running', startedAt: new Date(T0).toISOString() }
  const writeRegistry = () => fs.writeFileSync(path.join(dir, 'swarm.json'), `${JSON.stringify(registry, null, 2)}\n`)
  writeRegistry()

  const pubs = {}
  const ids = {}

  await at(0, () => look(w1))
  await at(0.5, () => {
    create(parent, 'Parse log lines into records', 'Messages may contain spaces and quotes; keep ts, level, message.')
    create(parent, 'Add CSV writer', 'src/csv.js: rows of records to RFC 4180 text.')
    create(parent, 'Wire --format csv flag into CLI', 'src/cli.js picks the writer from --format.')
    create(parent, 'Escape commas and quotes in CSV fields', 'Quote fields with comma, quote or newline; double inner quotes.')
    create(parent, 'Add tests for CSV export', 'test/csv.test.js plus a parser case for quoted messages.')
    create(parent, 'Update README usage', 'Document --format csv with an example.')
  })
  await at(1, () => {
    look(w2)
    look(w3)
  })
  await at(2, () => {
    claim(w1, 1)
    claim(w2, 1)
    claim(w2, 2)
    claim(w3, 1)
    claim(w3, 2)
    claim(w3, 3)
  })
  await at(4, () => finding(w3, 'Args are parsed by minimist; --format is declared as a string but unused (src/cli.js lines 2-5).'))
  await at(8, () => finding(w1, 'Ruled out: splitting on single spaces breaks messages with runs of spaces. parse() mis-split 3 of 20 sample lines.'))
  await at(10, () => call('status', w2, { summary: 'writing src/csv.js' }))
  await at(14, () => finding(w1, 'A line is ISO timestamp, level, then the message; only the first two fields are space-delimited.'))

  await at(18, () => {
    put(wt[w1.name], 'src/parser.js', "const LINE = /^(\\S+) (\\S+) (.*)$/\nexports.parse = (text) => text.split(/\\r?\\n/).filter(Boolean).map((line) => {\n  const [, ts, level, message] = LINE.exec(line) ?? [null, line, '', '']\n  return { ts, level, message }\n})\n")
    pubs.parser = publish(w1, 'Parser keeps the whole message after ts and level.', ['src/parser.js'])
    finish(w1, 1, 'Parser keeps the whole message after ts and level.')
  })
  await at(19, () => call('expand', w2, { publication_id: pubs.parser }))
  await at(20, () => call('apply', w2, { publication_id: pubs.parser }))
  await at(22, () => claim(w1, 4))
  await at(23, () => put(wt[w1.name], 'src/csv.js', "// draft\nexports.field = (v) => `\"${String(v)}\"`\n"))
  await at(24, () => {
    put(wt[w2.name], 'src/csv.js', "exports.toCsv = (records) => ['ts,level,message', ...records.map((r) => [r.ts, r.level, r.message].join(','))].join('\\r\\n') + '\\r\\n'\n")
    pubs.csv = publish(w2, 'src/csv.js writes a header and one row per record.', ['src/csv.js'])
    finish(w2, 2, 'src/csv.js writes a header and one row per record.')
  })
  await at(25, () => claim(w2, create(w2, 'Handle empty input gracefully', 'An empty file prints only the CSV header and exits 0.')))
  await at(26, () => call('apply', w3, { publication_id: pubs.csv }))
  await at(27, () => attempt('apply', w1, { publication_id: pubs.csv }))
  await at(28, () => {
    fs.rmSync(path.join(wt[w1.name], 'src/csv.js'))
    call('apply', w1, { publication_id: pubs.csv })
  })
  await at(30, () => finding(w3, 'Ruled out: writing each row with process.stdout.write. A 1M-line file takes 41 s per row vs 3 s buffered.'))
  await at(31, () => {
    call('request', parent, { text: 'Also measure the export on a 1M-line file and keep the bench script.' })
    ids.json = create(parent, 'Add JSON export', '--format json, one object per record.')
  })
  await at(32, () => call('task_close', parent, { task_id: ids.json, reason: 'JSON export is out of scope for this request.' }))
  await at(33, () => call('status', w3, { summary: 'wiring --format csv' }))
  await at(34, () => {
    put(wt[w1.name], 'src/csv.js', "const field = (v) => (/[\",\\r\\n]/.test(String(v)) ? `\"${String(v).replaceAll('\"', '\"\"')}\"` : String(v))\nexports.toCsv = (records) => ['ts,level,message', ...records.map((r) => [r.ts, r.level, r.message].map(field).join(','))].join('\\r\\n') + '\\r\\n'\n")
    pubs.escape = publish(w1, 'Fields with comma, quote or newline are quoted; quotes doubled.', ['src/csv.js'])
    finish(w1, 4, 'Fields with comma, quote or newline are quoted; quotes doubled.')
  })
  await at(35, () => {
    put(wt[w2.name], 'src/parser.js', "const LINE = /^(\\S+) (\\S+) (.*)$/\nexports.parse = (text = '') => text.split(/\\r?\\n/).filter((l) => l.trim()).map((line) => {\n  const [, ts, level, message] = LINE.exec(line) ?? [null, line, '', '']\n  return { ts, level, message }\n})\n")
    pubs.empty = publish(w2, 'Blank and empty input yields no records; header still printed.', ['src/parser.js'])
    finish(w2, 7, 'Blank and empty input yields no records; header still printed.')
  })
  await at(36, () => finding(w2, 'RFC 4180 rows end in CRLF; a quote inside a quoted field is doubled (section 2, rules 2 and 7).'))
  await at(38, () => {
    put(wt[w3.name], 'src/cli.js', "#!/usr/bin/env node\nconst minimist = require('minimist')\nconst { parse } = require('./parser')\nconst { toCsv } = require('./csv')\nconst args = minimist(process.argv.slice(2), { string: ['format'] })\nconst records = parse(require('fs').readFileSync(args._[0], 'utf8'))\nif (args.format === 'csv') process.stdout.write(toCsv(records))\nelse for (const r of records) console.log(r.ts, r.level, r.message)\n")
    pubs.cli = publish(w3, '--format csv writes the buffered CSV in one call.', ['src/cli.js'])
    finish(w3, 3, '--format csv writes the buffered CSV in one call.')
    ids.bench = create(w3, 'Benchmark CSV export on 1M lines', 'Record time and peak memory; keep the bench script.')
  })
  await at(39, () => claim(w3, ids.bench))
  await at(40, () => {
    claim(w2, 5)
    attempt('apply', w2, { publication_id: pubs.escape })
  })
  await at(41, () => {
    call('expand', w2, { publication_id: pubs.escape })
    put(wt[w2.name], 'src/csv.js', fs.readFileSync(path.join(wt[w1.name], 'src/csv.js'), 'utf8'))
    claim(w1, 6)
  })
  await at(42, () => call('apply', w2, { publication_id: pubs.cli }))
  await at(43, () => {
    const r = call('task_release', w1, { task_id: 6, expected_version: versions[6], summary: 'README section drafted; waiting on the final flag name from #3.' })
    versions[6] = r.version
  })
  await at(44, () => finding(w1, 'There is no docs site; README is the only user doc.'))
  await at(45, () => claim(w1, 6))
  await at(46, () => call('worker_stop', w3, { reason: 'context limit reached' }))
  await at(47, () => {
    put(wt[w1.name], 'README.md', `${BASE_FILES['README.md']}\n## CSV\n\n    logview --format csv app.log > app.csv\n\nOne row per record: ts, level, message (RFC 4180).\n`)
    pubs.readme = publish(w1, 'README documents --format csv.', ['README.md'])
    finish(w1, 6, 'README documents --format csv.')
  })
  await at(48, () => {
    claim(w1, ids.bench)
    claim(w2, ids.bench)
  })
  await at(52, () => {
    put(wt[w2.name], 'test/csv.test.js', "const test = require('node:test')\nconst assert = require('node:assert')\nconst { toCsv } = require('../src/csv')\ntest('quotes commas', () => assert.match(toCsv([{ ts: 't', level: 'INFO', message: 'a,b' }]), /\"a,b\"/))\ntest('empty input', () => assert.equal(toCsv([]), 'ts,level,message\\r\\n'))\n")
    put(wt[w2.name], 'test/parser.test.js', `${BASE_FILES['test/parser.test.js']}test('keeps spaces in message', () => assert.equal(parse('t INFO a  b')[0].message, 'a  b'))\n`)
    pubs.tests = publish(w2, 'CSV and parser tests pass (5 cases).', ['test/csv.test.js', 'test/parser.test.js'])
    finish(w2, 5, 'CSV and parser tests pass (5 cases).')
  })
  await at(53, () => call('status', w2, { state: 'waiting', dependency: `task:${ids.bench}`, summary: 'all my tasks are done' }))
  await at(58, () => {
    put(wt[w1.name], 'bench/results.txt', 'csv export, 1,000,000 lines\nrun1 3.2 s  run2 3.0 s  run3 3.1 s\npeak rss 210 MB\n')
    finding(w1, 'Buffered CSV export of 1M lines takes about 3.1 s with 210 MB peak memory (bench/csv.bench.js, three runs).')
  })
  await at(59, () => {
    put(wt[w1.name], 'bench/csv.bench.js', "const { toCsv } = require('../src/csv')\nconst rows = Array.from({ length: 1e6 }, (_, i) => ({ ts: String(i), level: 'INFO', message: `line ${i}` }))\nconsole.time('csv'); toCsv(rows); console.timeEnd('csv')\n")
    pubs.bench = publish(w1, '1M lines in 3.1 s; script and results in bench/.', ['bench/csv.bench.js', 'bench/results.txt'])
    finish(w1, ids.bench, '1M lines in 3.1 s; script in bench/.')
  })
  if (!running) {
    await at(60, () => {
      for (const w of [w1, w2]) call('complete', w, { outcome: 'complete', expected_revision: 2, summary: 'All tasks done; CSV export, tests, README and bench are published.' })
      call('end', parent, { outcome: 'complete', summary: 'CSV export shipped with tests, README usage and a 1M-line benchmark.' })
    })
    registry.state = 'ended'
    registry.endedAt = new Date(T0 + 60 * 60_000).toISOString()
    writeRegistry()
  }

  const d = db()
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  d.exec('PRAGMA journal_mode = DELETE')
  const count = d.prepare('SELECT COUNT(*) AS n FROM events').get().n
  d.close()
  fs.rmSync(work, { recursive: true, force: true })
  return { dir, count, lost, base }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await build({
    out: arg('out', path.join(here, LIST_ID)),
    store: arg('store', undefined),
    stepMs: Number(arg('step-ms', 0)),
    running: process.argv.includes('--running'),
  })
  console.log(`fixture: ${r.count} events in ${r.dir}, lost claims ${r.lost.join(' ') || 'none'}, base ${r.base.slice(0, 7)}`)
}

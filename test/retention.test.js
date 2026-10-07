const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createDispatchedStore,
  scanTranscripts,
  pruneSessionDirs,
  pruneContextStatus,
  pruneTaskMaps,
  retentionMs,
  GRACE_MS,
  MAX_DISPATCHED,
  DAY_MS,
} = require('../lib/retention');

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-retention-'));
  roots.push(root);
  return root;
}

function store({ saved = null, clock = { t: 1_000_000_000 } } = {}) {
  const writes = [];
  const s = createDispatchedStore({ load: () => saved, save: (d) => writes.push(d), now: () => clock.t });
  return { s, writes, clock };
}

const MONTH = 30 * DAY_MS;

describe('createDispatchedStore', () => {
  it('records a marker with its starter and saves it', () => {
    const { s, writes } = store();
    s.record('a', 'p');
    assert.deepEqual(s.get('a'), { parent: 'p', at: 1_000_000_000 });
    assert.equal(writes.length, 1);
  });

  it('loads valid entries and drops malformed ones', () => {
    const { s } = store({
      saved: {
        version: 1,
        sessions: { ok: { parent: 'p', status: 'failed', at: 5 }, bad: { status: 'x' }, worse: null },
      },
    });
    assert.deepEqual(s.get('ok'), { parent: 'p', at: 5 });
    assert.equal(s.get('bad'), null);
    assert.equal(s.get('worse'), null);
  });

  it('drops the oldest entry past the cap', () => {
    const { s, clock } = store();
    for (let i = 0; i <= MAX_DISPATCHED; i++) {
      clock.t++;
      s.record(`s${i}`);
    }
    assert.equal(s.get('s0'), null);
    assert.ok(s.get('s1'));
    assert.ok(s.get(`s${MAX_DISPATCHED}`));
  });

  it('drops a marker whose transcript is gone, after the grace period', () => {
    const { s, writes, clock } = store();
    s.record('gone');
    s.record('kept');
    assert.equal(s.prune({ known: new Set(['kept']), maxAgeMs: MONTH }), 0);
    clock.t += GRACE_MS;
    assert.equal(s.prune({ known: new Set(['kept']), maxAgeMs: MONTH }), 1);
    assert.equal(s.get('gone'), null);
    assert.ok(s.get('kept'));
    assert.equal(writes.length, 3);
  });

  it('drops a marker older than the retention age even with its transcript', () => {
    const { s, clock } = store();
    s.record('old');
    clock.t += MONTH + 1;
    assert.equal(s.prune({ known: new Set(['old']), maxAgeMs: MONTH }), 1);
  });

  it('keeps everything when the scan found no transcripts', () => {
    const { s, writes, clock } = store();
    s.record('a');
    clock.t += GRACE_MS;
    assert.equal(s.prune({ known: null, maxAgeMs: MONTH }), 0);
    assert.equal(writes.length, 1);
  });
});

describe('pruneSessionDirs', () => {
  function review(dir, session, name, ageMs, now) {
    fs.mkdirSync(path.join(dir, session), { recursive: true });
    const file = path.join(dir, session, name);
    fs.writeFileSync(file, '# review');
    const t = (now - ageMs) / 1000;
    fs.utimesSync(file, t, t);
    return file;
  }

  it('removes reviews of gone sessions and old reviews, keeps the rest', async () => {
    const dir = tempDir();
    const now = Date.now();
    const gone = review(dir, 'gone', '1.md', GRACE_MS + 1000, now);
    const fresh = review(dir, 'gone', '2.md', 1000, now);
    const old = review(dir, 'live', '1.md', MONTH + 1000, now);
    const kept = review(dir, 'live', '2.md', DAY_MS, now);
    const removed = await pruneSessionDirs(dir, { known: new Set(['live']), maxAgeMs: MONTH, now });
    assert.equal(removed, 2);
    assert.equal(fs.existsSync(gone), false);
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.existsSync(fresh));
    assert.ok(fs.existsSync(kept));
  });

  it('removes an emptied session folder once its mtime is past the grace period', async () => {
    const dir = tempDir();
    const now = Date.now();
    review(dir, 'gone', '1.md', GRACE_MS + 1000, now);
    await pruneSessionDirs(dir, { known: new Set(), maxAgeMs: MONTH, now });
    assert.ok(fs.existsSync(path.join(dir, 'gone')));
    await pruneSessionDirs(dir, { known: new Set(), maxAgeMs: MONTH, now: Date.now() + GRACE_MS + 1000 });
    assert.equal(fs.existsSync(path.join(dir, 'gone')), false);
  });

  it('returns 0 when the folder does not exist', async () => {
    assert.equal(await pruneSessionDirs(path.join(tempDir(), 'missing'), { known: null, maxAgeMs: MONTH }), 0);
  });
});

describe('pruneContextStatus', () => {
  function status(dir, sid, ageMs, now) {
    const file = path.join(dir, `${sid}.json`);
    fs.writeFileSync(file, '{}');
    const t = (now - ageMs) / 1000;
    fs.utimesSync(file, t, t);
    return file;
  }

  it('removes files of gone sessions past the grace period and old files, keeps the rest', async () => {
    const dir = tempDir();
    const now = Date.now();
    const gone = status(dir, 'gone', GRACE_MS + 1000, now);
    const young = status(dir, 'young', 1000, now);
    const old = status(dir, 'old', MONTH + 1000, now);
    const idle = status(dir, 'idle', 3 * DAY_MS, now);
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
    const removed = await pruneContextStatus(dir, { known: new Set(['old', 'idle']), maxAgeMs: MONTH, now });
    assert.equal(removed, 2);
    assert.equal(fs.existsSync(gone), false);
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.existsSync(young));
    assert.ok(fs.existsSync(idle));
    assert.ok(fs.existsSync(path.join(dir, 'notes.txt')));
  });

  it('prunes by age only when the scan found no transcripts', async () => {
    const dir = tempDir();
    const now = Date.now();
    const idle = status(dir, 'idle', 3 * DAY_MS, now);
    const old = status(dir, 'old', MONTH + 1000, now);
    assert.equal(await pruneContextStatus(dir, { known: null, maxAgeMs: MONTH, now }), 1);
    assert.ok(fs.existsSync(idle));
    assert.equal(fs.existsSync(old), false);
  });

  it('keeps only the newest files past the cap', async () => {
    const dir = tempDir();
    const now = Date.now();
    const files = [1, 2, 3, 4].map((h) => status(dir, `s${h}`, h * 60 * 60 * 1000, now));
    assert.equal(await pruneContextStatus(dir, { known: null, maxAgeMs: MONTH, now, max: 2 }), 2);
    assert.deepEqual(files.map((f) => fs.existsSync(f)), [true, true, false, false]);
  });

  it('returns 0 when the folder does not exist', async () => {
    assert.equal(await pruneContextStatus(path.join(tempDir(), 'missing'), { known: null, maxAgeMs: MONTH }), 0);
  });
});

describe('pruneTaskMaps', () => {
  const entry = (ageMs, now) => ({ project: '/p', updatedAt: new Date(now - ageMs).toISOString() });
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

  it('drops gone and old sessions, deletes a file left empty, keeps the rest', async () => {
    const dir = tempDir();
    const now = Date.now();
    const mixed = path.join(dir, 'list-a.json');
    const empty = path.join(dir, 'list-b.json');
    const untouched = path.join(dir, 'list-c.json');
    fs.writeFileSync(
      mixed,
      JSON.stringify({ gone: entry(GRACE_MS + 1000, now), young: entry(1000, now), live: entry(DAY_MS, now) }),
    );
    fs.writeFileSync(empty, JSON.stringify({ old: entry(MONTH + 1000, now) }));
    fs.writeFileSync(untouched, JSON.stringify({ live: entry(DAY_MS, now) }));
    const before = fs.statSync(untouched).mtimeMs;
    const removed = await pruneTaskMaps(dir, { known: new Set(['live', 'old']), maxAgeMs: MONTH, now });
    assert.equal(removed, 2);
    assert.deepEqual(Object.keys(read(mixed)), ['young', 'live']);
    assert.equal(fs.existsSync(empty), false);
    assert.equal(fs.statSync(untouched).mtimeMs, before);
  });

  it('skips a file it cannot parse and returns 0 when the folder does not exist', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    assert.equal(await pruneTaskMaps(dir, { known: new Set(), maxAgeMs: MONTH }), 0);
    assert.ok(fs.existsSync(path.join(dir, 'bad.json')));
    assert.equal(await pruneTaskMaps(path.join(dir, 'missing'), { known: null, maxAgeMs: MONTH }), 0);
  });
});

describe('scanTranscripts', () => {
  it('lists session ids and the project dirs that hold them', async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'proj-a'));
    fs.mkdirSync(path.join(dir, 'proj-b'));
    fs.mkdirSync(path.join(dir, 'proj-empty'));
    fs.writeFileSync(path.join(dir, 'proj-a', 'one.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'proj-a', 'sessions-index.json'), '{}');
    fs.writeFileSync(path.join(dir, 'proj-b', 'two.jsonl'), '');
    const { ids, dirs } = await scanTranscripts(dir);
    assert.deepEqual([...ids].sort(), ['one', 'two']);
    assert.deepEqual([...dirs].sort(), ['proj-a', 'proj-b']);
  });

  it('returns null for a missing or empty projects dir', async () => {
    const dir = tempDir();
    assert.equal(await scanTranscripts(path.join(dir, 'missing')), null);
    assert.equal(await scanTranscripts(dir), null);
  });
});

describe('retentionMs', () => {
  it('reads cleanupPeriodDays from the config dir settings', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 7 }));
    assert.equal(retentionMs(dir), 7 * DAY_MS);
  });

  it('falls back to 30 days for a missing or invalid value', () => {
    const dir = tempDir();
    assert.equal(retentionMs(dir), 30 * DAY_MS);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 0 }));
    assert.equal(retentionMs(dir), 30 * DAY_MS);
  });
});

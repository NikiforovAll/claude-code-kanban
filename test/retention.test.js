const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDispatchedStore, scanTranscripts, pruneSessionDirs, retentionMs, GRACE_MS, MAX_DISPATCHED, DAY_MS } = require('../lib/retention');

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
  it('records a running marker with its starter and saves it', () => {
    const { s, writes } = store();
    s.record('a', 'p');
    assert.deepEqual(s.get('a'), { parent: 'p', status: 'running', at: 1_000_000_000 });
    assert.equal(writes.length, 1);
  });

  it('settles a marker once and ignores unknown statuses', () => {
    const { s, writes } = store();
    s.record('a');
    s.settle('a', 'bogus');
    s.settle('a', 'succeeded');
    s.settle('a', 'failed');
    s.settle('missing', 'failed');
    assert.equal(s.get('a').status, 'succeeded');
    assert.equal(writes.length, 2);
  });

  it('loads valid entries, drops malformed ones, and reads a saved running marker as exited', () => {
    const { s } = store({
      saved: {
        version: 1,
        sessions: { ok: { parent: null, status: 'failed', at: 5 }, stuck: { status: 'running', at: 5 }, bad: { status: 'x' }, worse: null },
      },
    });
    assert.equal(s.get('ok').status, 'failed');
    assert.equal(s.get('stuck').status, 'exited');
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

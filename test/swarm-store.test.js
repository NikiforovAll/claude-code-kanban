const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const STORE = path.join(__dirname, '..', 'plugin', 'plugins', 'kanban-delm-swarm', 'scripts', 'store.mjs');
// node:sqlite ships from Node 22.5; CI also runs Node 20.
let hasSqlite = true;
try {
  require('node:sqlite');
} catch {
  hasSqlite = false;
}

// A git hook runs the tests with GIT_DIR and friends set, which would aim the temp repo's git calls at cck.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-swarm-'));
  return { root, dir: path.join(root, 'swarm'), tasksDir: path.join(root, 'tasks', 'swarm-g') };
}

const a = { id: 'sid-a', name: 'worker-a' };
const b = { id: 'sid-b', name: 'worker-b' };

describe('swarm store', { skip: !hasSqlite && 'node:sqlite needs Node 22.5 or later' }, () => {
  let main;
  before(async () => {
    ({ main } = await import(pathToFileURL(STORE).href));
  });

  const run = (w, command, actor, args = {}) => main(command, { dir: w.dir, tasksDir: w.tasksDir, actor, ...args });
  const task = (w, n) => JSON.parse(fs.readFileSync(path.join(w.tasksDir, `${n}.json`), 'utf8'));

  it('numbers items as task ids and mirrors each state into the task file', () => {
    const w = world();
    const added = run(w, 'add', a, { items: [{ subject: 'Parse logs', detail: 'd1' }, { subject: 'Plot', detail: 'd2' }] });
    assert.deepEqual(added.items.map((i) => i.id), [1, 2]);
    assert.equal(task(w, 1).status, 'pending');

    const claimed = run(w, 'claim', b, { item: 1 });
    assert.equal(claimed.won, true);
    assert.deepEqual([task(w, 1).status, task(w, 1).owner], ['in_progress', 'worker-b']);

    run(w, 'done', b, { item: 1, summary: 'parsed' });
    assert.equal(task(w, 1).status, 'completed');
    assert.match(task(w, 1).description, /\*\*Done:\*\* parsed/);
    assert.deepEqual(fs.readdirSync(w.tasksDir).sort(), ['1.json', '2.json']);
  });

  it('reuses an item for the same subject and skips ids already on disk', () => {
    const w = world();
    fs.mkdirSync(w.tasksDir, { recursive: true });
    fs.writeFileSync(path.join(w.tasksDir, '4.json'), '{}');
    run(w, 'add', a, { items: [{ subject: 'Fix  The bug', detail: 'x' }] });
    const again = run(w, 'add', b, { items: [{ subject: 'fix the BUG', detail: 'y' }] });
    assert.deepEqual(again.items, [{ id: 5, state: 'open', created: false }]);
    assert.equal(fs.readFileSync(path.join(w.tasksDir, '4.json'), 'utf8'), '{}');
  });

  it('gives a claimed item to one worker and one item to each worker', () => {
    const w = world();
    run(w, 'add', a, { items: [{ subject: 's1', detail: 'd' }, { subject: 's2', detail: 'd' }] });
    assert.equal(run(w, 'claim', a, { item: 1 }).won, true);
    assert.deepEqual(
      { won: run(w, 'claim', b, { item: 1 }).won, owner: run(w, 'claim', b, { item: 1 }).owner },
      { won: false, owner: 'worker-a' },
    );
    assert.match(run(w, 'claim', a, { item: 2 }).error, /already hold an unfinished item: 1/);
    assert.match(run(w, 'done', b, { item: 1, summary: 's' }).error, /only the agent holding/);
    assert.match(run(w, 'claim', a, { item: 9 }).error, /unknown item/);
  });

  it('reserve creates and claims, and a retry answers with the existing state', () => {
    const w = world();
    const first = run(w, 'reserve', a, { subject: 'Scope A', detail: 'd' });
    assert.deepEqual([first.won, first.created, first.item], [true, true, 1]);
    assert.equal(run(w, 'reserve', a, { subject: 'scope a', detail: 'd' }).won, true);
    assert.deepEqual(run(w, 'reserve', b, { subject: 'Scope A', detail: 'd' }).owner, 'worker-a');
  });

  it('serves only changes since the last read, compact for unchanged active items', () => {
    const w = world();
    run(w, 'add', a, { items: [{ subject: 's1', detail: 'long detail' }] });
    assert.equal(run(w, 'read', b).full, true);
    const quiet = run(w, 'read', b);
    assert.equal(quiet.full, false);
    assert.deepEqual(quiet.queue, [{ id: 1, subject: 's1', state: 'open' }]);

    const note = run(w, 'note', a, { type: 'FACT', text: 'API is v2', scope: 'api', basis: 'docs' });
    const after = run(w, 'claim', b, { item: 1 });
    assert.deepEqual(after.view.queue.map((i) => [i.id, i.state, i.owner]), [[1, 'claimed', 'worker-b']]);
    assert.deepEqual(after.view.notes.map((n) => [n.id, n.actor]), [[note.publicationId, 'worker-a']]);
    assert.deepEqual(run(w, 'read', b).notes, []);
  });

  it('makes done and note safe to resend with a requestId', () => {
    const w = world();
    run(w, 'reserve', a, { subject: 's', detail: 'd' });
    const once = run(w, 'done', a, { item: 1, summary: 'ok', requestId: 'r1' });
    const twice = run(w, 'done', a, { item: 1, summary: 'ok', requestId: 'r1' });
    assert.equal(twice.publicationId, once.publicationId);
    assert.match(run(w, 'done', a, { item: 1, summary: 'other', requestId: 'r1' }).error, /different content/);
    const events = main('export', { dir: w.dir }).events.filter((e) => e.kind === 'done');
    assert.equal(events.length, 1);
  });

  it('wakes a waiting read on a peer item and times out on its own writes', () => {
    const w = world();
    run(w, 'read', a);
    run(w, 'status', a, { text: 'busy' });
    const own = run(w, 'read', a, { wait: 0.3 });
    assert.deepEqual([own.updates, own.wokeBy], [false, 'timeout']);
    run(w, 'add', b, { items: [{ subject: 'new', detail: 'd' }] });
    const woke = run(w, 'read', a, { wait: 5 });
    assert.deepEqual([woke.updates, woke.wokeBy, woke.queue[0].subject], [true, 'update', 'new']);
    assert.ok(woke.waited < 1);
  });

  it('attaches files with their originals and applies them without overwriting own work', () => {
    const w = world();
    const repo = path.join(w.root, 'repo');
    fs.mkdirSync(repo);
    const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    const wa = path.join(w.root, 'wa');
    const wb = path.join(w.root, 'wb');
    for (const wt of [wa, wb]) fs.cpSync(repo, wt, { recursive: true });

    fs.writeFileSync(path.join(wa, 'f.txt'), 'two\n');
    const ctx = { base };
    run(w, 'reserve', a, { subject: 's', detail: 'd', ...ctx });
    const pub = run(w, 'done', a, { item: 1, summary: 'edited', files: ['f.txt'], cwd: wa, ...ctx });
    const [{ sha256, ...meta }, ...more] = pub.view.queue[0].files;
    assert.deepEqual([meta, more.length], [{ path: 'f.txt', bytes: 4, change: 'modified' }, 0]);
    assert.match(sha256, /^[0-9a-f]{64}$/);

    const expanded = run(w, 'expand', b, { id: 1, ...ctx });
    assert.match(expanded.files[0].text, /-one\n\+two/);

    const applied = run(w, 'apply', b, { id: 1, cwd: wb, ...ctx });
    assert.deepEqual([applied.applied, applied.decisions], [true, { 'f.txt': 'write' }]);
    assert.equal(fs.readFileSync(path.join(wb, 'f.txt'), 'utf8'), 'two\n');

    fs.writeFileSync(path.join(wb, 'f.txt'), 'mine\n');
    const refused = run(w, 'apply', b, { id: pub.publicationId, cwd: wb, ...ctx });
    assert.deepEqual([refused.applied, refused.decisions], [false, { 'f.txt': 'conflict' }]);
    assert.equal(fs.readFileSync(path.join(wb, 'f.txt'), 'utf8'), 'mine\n');
    assert.match(run(w, 'note', a, { type: 'FACT', text: 't', scope: 's', basis: 'b', files: ['../x'], cwd: wa }).error, /\.\./);
  });

  it('lets exactly one of many concurrent processes claim an item', async () => {
    const w = world();
    run(w, 'add', a, { items: [{ subject: 'contested', detail: 'd' }] });
    const claim = (i) =>
      new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [STORE, 'claim'], (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
        child.stdin.end(JSON.stringify({ dir: w.dir, tasksDir: w.tasksDir, actor: { id: `w${i}`, name: `w${i}` }, item: 1 }));
      });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(i)));
    const winners = results.filter((r) => r.won);
    assert.equal(winners.length, 1);
    assert.ok(results.every((r) => r.ok && (r.won || r.owner === winners[0].owner)));
    assert.equal(task(w, 1).owner, winners[0].owner);
  });
});

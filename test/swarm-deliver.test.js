const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { git, write, repoWithWorktrees } = require('./swarm-git-helpers');

const DELIVER = path.join(__dirname, '..', 'plugin', 'plugins', 'kanban-delm-swarm', 'scripts', 'deliver.mjs');

const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');

function project(seeds, { workers = ['w1', 'w2'], autocrlf } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cck-deliver-')));
  const repo = path.join(root, 'repo').replaceAll('\\', '/');
  fs.mkdirSync(repo);
  const dir = path.join(root, 'swarm');
  fs.mkdirSync(dir);
  return { repo, dir, ...repoWithWorktrees(repo, seeds, workers, { autocrlf }) };
}

// Marks a finished delivery as interrupted before its apply, as a crash would leave it.
function interrupt(p) {
  const journalFile = path.join(p.dir, 'delivery', 'journal.json');
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  fs.writeFileSync(journalFile, JSON.stringify({ ...journal, complete: false }));
}

const lines = (n, edit = {}) => `${Array.from({ length: n }, (_, i) => edit[i] ?? `line ${i}`).join('\n')}\n`;

describe('swarm delivery', () => {
  let d;
  before(async () => {
    d = await import(pathToFileURL(DELIVER).href);
  });

  it('delivery_preserves_index_dirty_inputs_and_applies_new_files_and_deletions', () => {
    const p = project({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'gone/c.txt': 'c\n', 'user.txt': 'u\n' });
    const wt = p.trees.w1.path;
    write(wt, 'a.txt', 'a2\n');
    write(wt, 'src/new.txt', 'new\n');
    fs.rmSync(path.join(wt, 'gone/c.txt'));
    git(wt, 'add', '-A');
    git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'w1');
    write(wt, 'b.txt', 'b2\n');
    write(p.repo, 'user.txt', 'u2\n');
    git(p.repo, 'add', 'user.txt');
    const index = git(p.repo, 'diff', '--cached', '--name-only');

    assert.deepEqual(d.worktrees(p.repo, ['w1', 'w2', 'w3']), p.trees);
    const out = d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt });
    assert.deepEqual([out.delivered, out.changed, out.merged, out.conflicts], [true, ['a.txt', 'b.txt', 'gone/c.txt', 'src/new.txt'], [], []]);
    assert.deepEqual([read(p.repo, 'a.txt'), read(p.repo, 'b.txt'), read(p.repo, 'src/new.txt'), read(p.repo, 'user.txt')], ['a2\n', 'b2\n', 'new\n', 'u2\n']);
    assert.equal(fs.existsSync(path.join(p.repo, 'gone')), false, 'an emptied folder goes too');
    assert.deepEqual([git(p.repo, 'rev-parse', 'HEAD'), git(p.repo, 'diff', '--cached', '--name-only')], [p.base, index]);
    assert.equal(out.recovery, path.join(p.dir, 'delivery'));
    assert.deepEqual(fs.readdirSync(out.recovery).sort(), ['journal.json', 'previous-0', 'previous-1', 'previous-2']);
    assert.deepEqual(d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt }).changed, out.changed, 'a rerun reports the same delivery');
  });

  it('delivery_merges_nonoverlapping_edits_against_saved_working_tree', () => {
    const p = project({ 'f.txt': lines(20), 'package.json': '{}\n' });
    write(p.trees.w1.path, 'f.txt', lines(20, { 15: 'worker' }));
    write(p.trees.w1.path, 'package.json', '{"name": "x"}\n');
    write(p.repo, 'f.txt', lines(20, { 2: 'user' }));
    const out = d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt: p.trees.w1.path });
    assert.deepEqual([out.merged, out.environment_files_changed], [['f.txt'], ['package.json']]);
    assert.equal(read(p.repo, 'f.txt'), lines(20, { 2: 'user', 15: 'worker' }));
  });

  it('conflicting_edits_save_both_workers_and_leave_original_unchanged', () => {
    const p = project({ 'f.txt': lines(5), 'g.txt': 'g\n' });
    write(p.trees.w1.path, 'f.txt', lines(5, { 2: 'worker' }));
    write(p.trees.w1.path, 'new.txt', 'new\n');
    write(p.trees.w2.path, 'g.txt', 'g from w2\n');
    write(p.repo, 'f.txt', lines(5, { 2: 'user' }));
    const out = d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt: p.trees.w1.path });
    assert.deepEqual([out.delivered, out.conflicts], [false, ['f.txt']]);
    assert.equal(read(p.repo, 'f.txt'), lines(5, { 2: 'user' }));
    assert.equal(fs.existsSync(path.join(p.repo, 'new.txt')), false, 'nothing is written on a conflict');

    const bundle = d.preserve({ dir: p.dir, project: p.repo, base: p.base, trees: p.trees });
    const manifest = JSON.parse(read(bundle, 'complete.json'));
    assert.deepEqual(manifest.workers.map((w) => [w.worker, Object.keys(w.changes)]), [['w1', ['f.txt', 'new.txt']], ['w2', ['g.txt']]]);
    const { base, result } = manifest.workers[0].changes['f.txt'];
    assert.deepEqual([read(bundle, base), read(bundle, result)], [lines(5), lines(5, { 2: 'worker' })]);
    assert.equal(manifest.workers[0].changes['new.txt'].base, null);

    d.cleanup(p.repo, p.trees);
    assert.deepEqual(d.worktrees(p.repo, ['w1', 'w2']), {});
    assert.equal(git(p.repo, 'branch', '--list', 'worktree-*'), '');
    d.cleanup(p.repo, p.trees);
  });

  it('a delete on one side and an edit on the other, or a binary edit on both, is a conflict', () => {
    const p = project({ 'del.txt': 'x\n', 'bin.dat': Buffer.from([0, 1, 2]) });
    fs.rmSync(path.join(p.trees.w1.path, 'del.txt'));
    write(p.trees.w1.path, 'bin.dat', Buffer.from([0, 1, 3]));
    write(p.repo, 'del.txt', 'y\n');
    write(p.repo, 'bin.dat', Buffer.from([0, 1, 4]));
    assert.deepEqual(d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt: p.trees.w1.path }).conflicts, ['bin.dat', 'del.txt']);
  });

  it('interrupted_apply_does_not_rollback_later_user_edits', () => {
    const p = project({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    write(p.trees.w1.path, 'a.txt', 'a2\n');
    write(p.trees.w1.path, 'b.txt', 'b2\n');
    assert.equal(d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt: p.trees.w1.path }).delivered, true);
    interrupt(p);
    write(p.repo, 'b.txt', 'user\n');
    assert.throws(() => d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt: p.trees.w1.path }), /b\.txt changed during delivery; it was not overwritten/);
    assert.equal(read(p.repo, 'b.txt'), 'user\n');
  });

  it('a rerun resumes an interrupted apply', () => {
    const p = project({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    write(p.trees.w1.path, 'a.txt', 'a2\n');
    write(p.trees.w1.path, 'b.txt', 'b2\n');
    d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt: p.trees.w1.path });
    interrupt(p);
    write(p.repo, 'b.txt', 'b\n');
    fs.writeFileSync(path.join(p.dir, 'delivery', 'next-1'), 'b2\n');
    assert.equal(d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt: p.trees.w1.path }).delivered, true);
    assert.equal(read(p.repo, 'b.txt'), 'b2\n');
  });

  it('declared ignored artifacts are delivered and credentials are not', () => {
    const p = project({ '.gitignore': 'dist/\n.claude/\n' });
    write(p.trees.w1.path, 'dist/app.js', 'built\n');
    write(p.trees.w1.path, 'dist/sub/map.js', 'map\n');
    write(p.trees.w1.path, 'build.log', 'noise\n');
    write(p.trees.w1.path, '.env', 'TOKEN=x\n');
    write(p.trees.w1.path, 'keys/deploy.pem', '-----BEGIN RSA PRIVATE KEY-----\n');
    const out = d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt: p.trees.w1.path, artifacts: ['dist'] });
    assert.deepEqual(out.changed, ['build.log', 'dist/app.js', 'dist/sub/map.js']);
    assert.deepEqual(Object.keys(out.excluded), ['.env', 'keys/deploy.pem']);
    assert.equal(fs.existsSync(path.join(p.repo, '.env')), false);
  });

  it('line ending conversion on checkout does not read as an edit', () => {
    const p = project({ 'f.txt': lines(6) }, { autocrlf: 'true', workers: ['w1'] });
    write(p.repo, 'f.txt', lines(6).replaceAll('\n', '\r\n'));
    const wt = p.trees.w1.path;
    write(wt, 'f.txt', lines(6, { 4: 'worker' }).replaceAll('\n', '\r\n'));
    const out = d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt });
    assert.deepEqual([out.changed, out.merged], [['f.txt'], []]);
  });

  it('a symlink on the way in the project is a conflict, not a redirect', { skip: process.platform === 'win32' && 'symlinks need admin rights on Windows' }, () => {
    const p = project({ 'sub/f.txt': 'f\n' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-outside-'));
    write(p.trees.w1.path, 'sub/f.txt', 'f2\n');
    fs.rmSync(path.join(p.repo, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(p.repo, 'sub'));
    assert.deepEqual(d.deliver({ dir: p.dir, project: p.repo, base: p.base, wt: p.trees.w1.path }).conflicts, ['sub/f.txt']);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync, renameSync, statSync } = require('fs');
const os = require('os');
const path = require('path');

const MODULE = require.resolve('../lib/task-counts');
const fresh = () => {
  delete require.cache[MODULE];
  return require(MODULE);
};

const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'cck-task-counts-')));
after(() => rmSync(root, { recursive: true, force: true }));

const OLD = new Date('2026-01-01T00:00:00Z');
let dir;
let n = 0;
const file = (name) => path.join(dir, name);
const write = (name, task, mtime = OLD) => {
  writeFileSync(file(name), typeof task === 'string' ? task : JSON.stringify(task));
  if (mtime) utimesSync(file(name), mtime, mtime);
};
const counts = (m, d = dir) => {
  const { completed, inProgress, pending } = m.countTaskDir(d);
  return { completed, inProgress, pending };
};

beforeEach(() => {
  dir = path.join(root, `d${n++}`);
  mkdirSync(dir);
});

describe('countTaskDir', () => {
  it('counts statuses and skips internal, invalid and non-task files', () => {
    const m = fresh();
    write('1.json', { status: 'completed' });
    write('2.json', { status: 'in_progress' });
    write('3.json', { status: 'pending' });
    write('4.json', { status: 'weird' });
    write('5.json', { status: 'completed', metadata: { _internal: true } });
    write('6.json', '{not json');
    write('7.json', 'null');
    write('notes.txt', 'x');
    assert.deepEqual(counts(m), { completed: 1, inProgress: 1, pending: 2 });
  });

  it('reports the newest mtime of the counted tasks only', () => {
    const m = fresh();
    write('1.json', { status: 'pending' }, OLD);
    write('2.json', { status: 'pending', metadata: { _internal: true } }, new Date('2026-02-01T00:00:00Z'));
    assert.equal(m.countTaskDir(dir).newestTaskMtime.getTime(), OLD.getTime());
  });

  it('reuses an entry while size, mtime and inode match', () => {
    const m = fresh();
    write('1.json', { status: 'pending', x: 'abcd' });
    counts(m);
    assert.equal(m.taskCountsDirty(), true);
    m.exportTaskCounts();
    write('1.json', { status: 'completed', x: 'ab' });
    assert.deepEqual(counts(m), { completed: 0, inProgress: 0, pending: 1 });
    assert.equal(m.taskCountsDirty(), false);
  });

  it('reads a file again when its status changes, even with the mtime kept', () => {
    const m = fresh();
    write('1.json', { status: 'pending' });
    assert.deepEqual(counts(m), { completed: 0, inProgress: 0, pending: 1 });
    write('1.json', { status: 'completed' });
    assert.deepEqual(counts(m), { completed: 1, inProgress: 0, pending: 0 });
  });

  it('reads a file again when the mtime changes and the size does not', () => {
    const m = fresh();
    write('1.json', { status: 'completed', x: 'abcd' });
    counts(m);
    write('1.json', { status: 'in_progress', x: 'ab' }, new Date('2026-01-02T00:00:00Z'));
    assert.equal(statSync(file('1.json')).size, JSON.stringify({ status: 'completed', x: 'abcd' }).length);
    assert.deepEqual(counts(m), { completed: 0, inProgress: 1, pending: 0 });
  });

  it('reads a file again when it is replaced by a rename', () => {
    const m = fresh();
    write('1.json', { status: 'completed', x: 'abcd' });
    counts(m);
    write('1.json.tmp', { status: 'in_progress', x: 'ab' });
    renameSync(file('1.json.tmp'), file('1.json'));
    utimesSync(file('1.json'), OLD, OLD);
    assert.equal(statSync(file('1.json')).size, JSON.stringify({ status: 'completed', x: 'abcd' }).length);
    assert.deepEqual(counts(m), { completed: 0, inProgress: 1, pending: 0 });
  });

  it('drops deleted files and counts added ones', () => {
    const m = fresh();
    write('1.json', { status: 'pending' });
    write('2.json', { status: 'pending' });
    counts(m);
    m.exportTaskCounts();
    rmSync(file('1.json'));
    write('3.json', { status: 'completed' });
    assert.deepEqual(counts(m), { completed: 1, inProgress: 0, pending: 1 });
    assert.equal(m.taskCountsDirty(), true);
    const [[, files]] = m.exportTaskCounts();
    assert.deepEqual(files.map(([f]) => f).sort(), ['2.json', '3.json']);
  });

  it('does not store a file written in the last seconds', () => {
    const m = fresh();
    write('1.json', { status: 'completed', x: 'abcd' }, null);
    counts(m);
    const { mtime } = statSync(file('1.json'));
    write('1.json', { status: 'in_progress', x: 'ab' }, mtime);
    assert.deepEqual(counts(m), { completed: 0, inProgress: 1, pending: 0 });
  });
});

describe('export and import', () => {
  it('keeps entries across a restart and sees changes made while stopped', () => {
    let m = fresh();
    write('1.json', { status: 'pending' });
    write('2.json', { status: 'pending' });
    counts(m);
    const saved = JSON.parse(JSON.stringify(m.exportTaskCounts()));

    write('2.json', { status: 'completed' });
    m = fresh();
    m.importTaskCounts(saved);
    assert.deepEqual(counts(m), { completed: 1, inProgress: 0, pending: 1 });
  });

  it('leaves out folders that no longer exist', () => {
    const m = fresh();
    write('1.json', { status: 'pending' });
    counts(m);
    rmSync(dir, { recursive: true });
    assert.deepEqual(m.exportTaskCounts(), []);
  });

  it('ignores malformed entries', () => {
    const m = fresh();
    write('1.json', { status: 'pending' });
    m.importTaskCounts([
      [dir, [['1.json', { size: 1, mtimeMs: 1, ino: 1, status: 'bogus' }], 'junk', null]],
      ['x', 'y'],
      null,
    ]);
    m.importTaskCounts({});
    assert.deepEqual(counts(m), { completed: 0, inProgress: 0, pending: 1 });
  });
});

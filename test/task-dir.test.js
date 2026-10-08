const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTaskDir } = require('../lib/task-dir');

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-task-dir-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

describe('readTaskDir', () => {
  it('reads every .json task with its file name', async () => {
    const dir = makeDir({ '1.json': '{"id":"1"}', '2.json': '{"id":"2"}', '.lock': '' });
    const got = (await readTaskDir(dir)).sort((a, b) => a.file.localeCompare(b.file));
    assert.deepEqual(got, [
      { file: '1.json', task: { id: '1' } },
      { file: '2.json', task: { id: '2' } },
    ]);
  });

  it('skips files that are not a task object', async (t) => {
    t.mock.method(console, 'error', () => {});
    const dir = makeDir({ '1.json': '{"id":"1"}', '2.json': '{"id":', '3.json': 'null' });
    assert.deepEqual(await readTaskDir(dir), [{ file: '1.json', task: { id: '1' } }]);
    assert.equal(console.error.mock.callCount(), 1);
  });

  it('gives no tasks for a missing dir', async () => {
    assert.deepEqual(await readTaskDir(path.join(os.tmpdir(), 'cck-no-such-task-dir')), []);
  });

  it('throws other read errors', async () => {
    const dir = makeDir({ 'file.json': '{}' });
    await assert.rejects(readTaskDir(path.join(dir, 'file.json')), { code: 'ENOTDIR' });
  });
});

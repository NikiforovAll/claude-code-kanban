const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } = require('fs');
const os = require('os');
const path = require('path');
const { resolveScratchSubdir, listScratchDir } = require('../lib/scratch-files');

let root;
before(() => {
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'cck-scratch-')));
  mkdirSync(path.join(root, 'clone', 'inner'), { recursive: true });
  writeFileSync(path.join(root, 'clone', 'inner', 'deep.txt'), 'y');
  writeFileSync(path.join(root, 'notes.md'), 'x');
  // The folder is the older entry, so a kind-blind sort puts the file first.
  utimesSync(path.join(root, 'clone'), new Date(), new Date(Date.now() - 60_000));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('resolveScratchSubdir', () => {
  it('returns the root for an empty path', () => {
    assert.equal(resolveScratchSubdir(root, undefined), root);
    assert.equal(resolveScratchSubdir(root, ''), root);
  });

  it('accepts a relative or an absolute path inside the root', () => {
    const inner = path.join(root, 'clone', 'inner');
    assert.equal(resolveScratchSubdir(root, 'clone/inner'), inner);
    assert.equal(resolveScratchSubdir(root, path.join('clone', 'inner')), inner);
    assert.equal(resolveScratchSubdir(root, inner), inner);
  });

  it('rejects paths that escape the root', () => {
    assert.equal(resolveScratchSubdir(root, '..'), null);
    assert.equal(resolveScratchSubdir(root, 'clone/../..'), null);
    assert.equal(resolveScratchSubdir(root, path.join(root, '..')), null);
    assert.equal(resolveScratchSubdir(root, os.tmpdir()), null);
    assert.equal(resolveScratchSubdir(root, ['clone']), null);
  });
});

describe('listScratchDir', () => {
  it('lists files and folders one level deep, newest first', async () => {
    const rows = await listScratchDir(root);
    assert.deepEqual(
      rows.map((r) => [r.name, r.kind]),
      [
        ['notes.md', 'file'],
        ['clone', 'dir'],
      ],
    );
    assert.equal(rows[1].path, path.join(root, 'clone'));
    assert.equal(rows[1].mtimeMs, undefined);
    assert.ok(!Number.isNaN(Date.parse(rows[0].modifiedAt)));
  });

  it('lists a missing dir as empty', async () => {
    assert.deepEqual(await listScratchDir(path.join(root, 'does-not-exist')), []);
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { pickFolder, candidates, startFolder } = require('../lib/folder-dialog');

describe('pickFolder', () => {
  it('looks up the Windows pickers by names whichSync can resolve, pwsh first', async () => {
    const asked = [];
    const which = (cmd) => {
      asked.push(cmd);
      return null;
    };
    await assert.rejects(pickFolder(which, {}, 'win32'), /no folder dialog/);
    assert.deepEqual(asked, ['pwsh', 'powershell']);
  });

  it('refuses on linux with no display', async () => {
    await assert.rejects(pickFolder(() => '/usr/bin/zenity', {}, 'linux', {}), /no display/);
  });
});

describe('startFolder', () => {
  it('keeps an existing absolute folder', () => {
    assert.equal(startFolder(os.tmpdir()), os.tmpdir());
  });

  it('drops relative, missing, file and non-string values', () => {
    assert.equal(startFolder('relative/dir'), null);
    assert.equal(startFolder(path.join(os.tmpdir(), 'cck-no-such-dir-xyz')), null);
    assert.equal(startFolder(__filename), null);
    assert.equal(startFolder(42), null);
  });
});

describe('candidates', () => {
  it('passes the start folder as an argument, never inside a script', () => {
    const start = '/home/me/it\'s "here"';
    const [[, mac]] = candidates('darwin', start);
    assert.equal(mac.at(-1), start);
    assert.ok(mac.slice(0, -1).every((a) => !a.includes(start)));
    const [[, zenity], [, kdialog]] = candidates('linux', start);
    assert.ok(zenity.some((a) => a.startsWith(`--filename=${start}`)));
    assert.equal(kdialog[1], start);
  });

  it('leaves the Windows script free of the path (it arrives in CCK_PICK_START)', () => {
    const [[, args]] = candidates('win32', 'C:\\x');
    assert.ok(args.every((a) => !a.includes('C:\\x')));
  });
});

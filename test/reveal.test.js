const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { revealCommand } = require('../lib/reveal');

describe('revealCommand', () => {
  it('opens a folder and selects a file in Explorer, with the quotes around the path only', () => {
    assert.deepEqual(revealCommand('C:\\a b\\dir', true, 'win32'), {
      cmd: 'explorer.exe',
      args: ['"C:\\a b\\dir"'],
      opts: { windowsVerbatimArguments: true },
    });
    assert.deepEqual(revealCommand('C:\\a b\\f.md', false, 'win32').args, ['/select,"C:\\a b\\f.md"']);
  });

  it('uses open on macOS and the parent folder with xdg-open elsewhere', () => {
    assert.deepEqual(revealCommand('/a/f.md', false, 'darwin'), { cmd: 'open', args: ['-R', '/a/f.md'], opts: {} });
    assert.deepEqual(revealCommand('/a/dir', true, 'darwin').args, ['/a/dir']);
    assert.deepEqual(revealCommand('/a/dir', true, 'linux'), { cmd: 'xdg-open', args: ['/a/dir'], opts: {} });
  });
});

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { raise, restore } = require('../lib/priority');

const { PRIORITY_NORMAL, PRIORITY_ABOVE_NORMAL, PRIORITY_BELOW_NORMAL } = os.constants.priority;

describe('priority', () => {
  let child = null;
  afterEach(() => child?.kill());

  function idle() {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    return child.pid;
  }

  it('does nothing off Windows', () => {
    const pid = idle();
    const before = os.getPriority(pid);
    assert.equal(raise(pid, 'linux'), null);
    assert.equal(raise(pid, 'darwin'), null);
    assert.equal(os.getPriority(pid), before);
  });

  it('does nothing when turned off', () => {
    const pid = idle();
    const before = os.getPriority(pid);
    assert.equal(raise(pid, 'win32', { CCK_PRIORITY_BOOST: '0' }), null);
    assert.equal(os.getPriority(pid), before);
  });

  it('returns null for a pid that is gone', () => {
    assert.equal(raise(2 ** 31 - 2, 'win32', {}), null);
  });

  it('raises and restores on Windows', { skip: process.platform !== 'win32' }, () => {
    const pid = idle();
    os.setPriority(pid, PRIORITY_BELOW_NORMAL);
    assert.equal(raise(pid, 'win32', {}), PRIORITY_BELOW_NORMAL);
    assert.equal(os.getPriority(pid), PRIORITY_ABOVE_NORMAL);
    assert.equal(raise(pid, 'win32', {}), null);
    restore(pid, PRIORITY_BELOW_NORMAL);
    assert.equal(os.getPriority(pid), PRIORITY_BELOW_NORMAL);
    restore(pid, PRIORITY_NORMAL);
  });

  it('restore ignores a pid that is gone', () => {
    assert.doesNotThrow(() => restore(2 ** 31 - 2, PRIORITY_NORMAL));
  });
});

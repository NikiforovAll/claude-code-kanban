const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createDispatchRegistry } = require('../lib/dispatch');
const { claudeArgsFor, parseNewSpec } = require('../lib/terminal');

describe('dispatch registry', () => {
  it('lists running dispatches, by parent when asked', () => {
    const reg = createDispatchRegistry({ now: () => 7 });
    reg.add({ session: 's-1', parent: 'p-1', cwd: '/a', name: 'one', group: 'g' });
    reg.add({ session: 's-2', parent: 'p-2', cwd: '/b' });
    assert.deepEqual(reg.list({ parent: 'p-1' }), [
      { session: 's-1', parent: 'p-1', cwd: '/a', name: 'one', group: 'g', worktree: null, startedAt: 7 },
    ]);
    assert.equal(reg.list().length, 2);
  });

  it('forgets a dispatch when its terminal ends', () => {
    const reg = createDispatchRegistry();
    reg.add({ session: 's-1', parent: 'p-1', cwd: '/a' });
    assert.equal(reg.has('s-1'), true);
    assert.equal(reg.remove('s-1'), true);
    assert.equal(reg.remove('s-1'), false);
    assert.deepEqual(reg.list(), []);
  });
});

describe('claude args pass-through', () => {
  const spec = (extraArgs) => parseNewSpec({ cwd: '/a', name: 'x', model: 'sonnet', extraArgs });

  it('puts the extra args after the session id and before the worktree', () => {
    const s = spec(['--permission-mode', 'auto', '--allowedTools', 'Bash(git log:*)']);
    assert.deepEqual(claudeArgsFor('new', 'id-1', { ...s, worktree: true }), [
      '--session-id', 'id-1', '--permission-mode', 'auto', '--allowedTools', 'Bash(git log:*)',
      '--name', 'x', '--model', 'sonnet', '-w',
    ]);
  });

  it('accepts no extra args', () => {
    assert.deepEqual(spec(undefined).extraArgs, []);
  });

  it('refuses flags cck sets, in both spellings', () => {
    for (const flag of ['--session-id', '-n', '--name=y', '--model', '-w', '--resume', '-c', '--fork-session', '-p', '--print']) {
      assert.match(spec([flag]), /cck sets/, flag);
    }
  });

  it('refuses values that could leave the quotes', () => {
    for (const bad of ["it's", 'a"b', '%PATH%', 'a\nb', '\x1b[2J']) assert.match(spec([bad]), /no quotes/, JSON.stringify(bad));
  });

  it('refuses a non-list or too many args', () => {
    assert.match(spec('--verbose'), /claude args/);
    assert.match(spec(Array(65).fill('-v')), /claude args/);
    assert.match(spec([7]), /no quotes/);
  });
});

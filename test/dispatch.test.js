const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { claudeArgsFor, parseNewSpec } = require('../lib/terminal');

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

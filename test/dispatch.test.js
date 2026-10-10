const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { claudeArgsFor, claudeCommand, parseNewSpec } = require('../lib/terminal');

describe('claude args pass-through', () => {
  const spec = (extraArgs) => parseNewSpec({ cwd: '/a', name: 'x', model: 'sonnet', extraArgs });

  it('puts the extra args after the session id and before the worktree', () => {
    const s = spec(['--permission-mode', 'auto', '--allowedTools', 'Bash(git log:*)']);
    assert.deepEqual(claudeArgsFor('new', 'id-1', { ...s, worktree: true }), [
      '--session-id', 'id-1', '--permission-mode', 'auto', '--allowedTools', 'Bash(git log:*)',
      '--name', 'x', '--model', 'sonnet', '-w',
    ]);
  });

  it('resumes in place of a new session id', () => {
    const id = '0b6a3c3e-2f9e-4c55-9a3e-6c1f0d2b7a11';
    const s = parseNewSpec({ cwd: '/a', resume: id, extraArgs: ['--agent', 'x:y'] });
    assert.deepEqual(claudeArgsFor('new', 'pty-1', s), ['--resume', id, '--agent', 'x:y']);
    assert.equal(parseNewSpec({ cwd: '/a', resume: 'nope' }), 'session to resume');
    assert.equal(parseNewSpec({ resume: id, forkOf: id }), 'session to resume');
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
    for (const bad of ['a"b', '%PATH%', 'a\nb', '\x1b[2J']) assert.match(spec([bad]), /no double quotes/, JSON.stringify(bad));
  });

  it("keeps a ' inside its argument in every shell", () => {
    const arg = "C:\\Users\\O'Brien\\.claude";
    assert.deepEqual(spec([arg]).extraArgs, [arg]);
    assert.equal(claudeCommand('bash', [arg]), "claude 'C:\\Users\\O'\\''Brien\\.claude'");
    assert.equal(claudeCommand('pwsh', [arg]), "claude 'C:\\Users\\O''Brien\\.claude'");
    assert.equal(claudeCommand('cmd.exe', [arg]), `claude "${arg}"`);
  });

  it('refuses a non-list or too many args', () => {
    assert.match(spec('--verbose'), /claude args/);
    assert.match(spec(Array(65).fill('-v')), /claude args/);
    assert.match(spec([7]), /no double quotes/);
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COMMANDS, FLAG_KEY, flagSpec, splitClaudeArgs } = require('../cli');

const SERVER = path.join(__dirname, '..', 'server.js');

function leaves() {
  return Object.values(COMMANDS).flatMap(c => (c.verbs ? Object.values(c.verbs) : [c]));
}

function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-flags-'));
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
    delete env.PORT;
    delete env.CLAUDE_DIR;
    delete env.CCK_URL;
    execFile(process.execPath, [SERVER, ...args], { env },
      (err, stdout, stderr) => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve({ code: err ? err.code : 0, out: stdout + stderr });
      });
  });
}

describe('CLI flag keys', () => {
  it('every help key is a flag, a positional or the -- separator', () => {
    for (const entry of leaves()) {
      for (const key of Object.keys(entry.flags || {})) {
        const ok = FLAG_KEY.test(key) || /^[<[]/.test(key) || /^-- </.test(key);
        assert.ok(ok, `${entry.name}: help key "${key}" does not fit FLAG_KEY`);
      }
    }
  });

  it('flagSpec reads names and value flags from the help keys', () => {
    assert.deepEqual(flagSpec(COMMANDS.new), { names: ['--cwd', '--name', '--model', '--json'], valueFlags: ['--cwd', '--name', '--model'] });
    assert.ok(!flagSpec(COMMANDS.dispatch.verbs.start).valueFlags.includes('--worktree'));
  });

  it('splitClaudeArgs keeps the words after -- for claude', () => {
    assert.deepEqual(splitClaudeArgs(['a', '--', '--help']), { args: ['a'], claudeArgs: ['--help'] });
    assert.deepEqual(splitClaudeArgs(['a']), { args: ['a'], claudeArgs: [] });
  });
});

describe('--help and --version after --', () => {
  it('go to claude, not to cck', async () => {
    for (const flag of ['--help', '-h', '-v', '--version']) {
      const { code, out } = await run(['new', '--', flag]);
      assert.equal(code, 1, `${flag}: ${out}`);
      assert.match(out, /No terminal token/, `${flag}: ${out}`);
      assert.doesNotMatch(out, /Usage:/, flag);
    }
  });

  it('before -- still print help', async () => {
    const { code, out } = await run(['new', '--help']);
    assert.equal(code, 0);
    assert.match(out, /Usage: claude-code-kanban new/);
  });
});

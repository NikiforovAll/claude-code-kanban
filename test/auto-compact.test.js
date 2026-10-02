const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getAutoCompact } = require('../lib/auto-compact');

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function world({ user, project, local } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-compact-'));
  roots.push(root);
  const claudeDir = path.join(root, '.claude-config');
  const projectDir = path.join(root, 'repo');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  if (user) fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(user));
  if (project) fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify(project));
  if (local) fs.writeFileSync(path.join(projectDir, '.claude', 'settings.local.json'), JSON.stringify(local));
  return { claudeDir, projectDir };
}

describe('getAutoCompact', () => {
  it('returns null when nothing is configured', () => {
    const { claudeDir, projectDir } = world();
    assert.equal(getAutoCompact(claudeDir, projectDir), null);
  });

  it('reads the env var from the config dir settings', () => {
    const { claudeDir, projectDir } = world({ user: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } } });
    assert.deepEqual(getAutoCompact(claudeDir, projectDir), { window: 250000, pct: null });
  });

  it('lets project local beat project beat user', () => {
    const { claudeDir, projectDir } = world({
      user: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } },
      project: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } },
      local: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' } },
    });
    assert.equal(getAutoCompact(claudeDir, projectDir).window, 400000);
  });

  it('prefers the env var over the autoCompactWindow key', () => {
    const { claudeDir, projectDir } = world({
      user: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } },
      local: { autoCompactWindow: 500000 },
    });
    assert.equal(getAutoCompact(claudeDir, projectDir).window, 250000);
  });

  it('uses the autoCompactWindow key alone', () => {
    const { claudeDir, projectDir } = world({ project: { autoCompactWindow: 500000 } });
    assert.equal(getAutoCompact(claudeDir, projectDir).window, 500000);
  });

  it('clamps the window to the documented range', () => {
    const { claudeDir, projectDir } = world({ user: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '5000' } } });
    assert.equal(getAutoCompact(claudeDir, projectDir).window, 100000);
  });

  it('ignores a non-integer value', () => {
    const { claudeDir, projectDir } = world({ user: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k' } } });
    assert.equal(getAutoCompact(claudeDir, projectDir), null);
  });

  it('returns the percent override with no window', () => {
    const { claudeDir, projectDir } = world({ user: { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' } } });
    assert.deepEqual(getAutoCompact(claudeDir, projectDir), { window: null, pct: 70 });
  });

  it('returns null when auto-compact is off', () => {
    const { claudeDir, projectDir } = world({
      user: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } },
      project: { autoCompactEnabled: false },
    });
    assert.equal(getAutoCompact(claudeDir, projectDir), null);
  });

  it('works without a project path', () => {
    const { claudeDir } = world({ user: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } } });
    assert.equal(getAutoCompact(claudeDir, null).window, 250000);
  });
});

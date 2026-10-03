const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginStatus, installCommand, PLUGIN_ID, BUNDLED_MANIFEST } = require('../lib/plugin-status');

function world({ bundled = '2.14.0', installs, enabled } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-plugin-'));
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'plugins'), { recursive: true });
  const manifest = path.join(root, 'plugin.json');
  if (bundled) fs.writeFileSync(manifest, JSON.stringify({ name: 'claude-code-kanban', version: bundled }));
  if (installs) {
    fs.writeFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: installs } }));
  }
  if (enabled !== undefined) {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: enabled } }));
  }
  return { claudeDir, manifest };
}

describe('pluginStatus', () => {
  it('is ok when the installed version matches the bundled one', () => {
    const { claudeDir, manifest } = world({ installs: [{ scope: 'user', version: '2.14.0' }], enabled: true });
    const { bundled, installed, state } = pluginStatus(claudeDir, manifest);
    assert.deepEqual({ bundled, installed, state }, { bundled: '2.14.0', installed: '2.14.0', state: 'ok' });
  });

  it('reports a mismatch for an older and for a newer install', () => {
    for (const version of ['2.13.0', '2.15.0']) {
      const { claudeDir, manifest } = world({ installs: [{ scope: 'user', version }], enabled: true });
      assert.equal(pluginStatus(claudeDir, manifest).state, 'mismatch');
    }
  });

  it('reports missing with no install record or no entry for the plugin', () => {
    assert.equal(pluginStatus(world().claudeDir, world().manifest).state, 'missing');
    const { claudeDir, manifest } = world({ installs: [] });
    assert.equal(pluginStatus(claudeDir, manifest).state, 'missing');
  });

  it('reports disabled only on an explicit false', () => {
    const off = world({ installs: [{ scope: 'user', version: '2.14.0' }], enabled: false });
    assert.equal(pluginStatus(off.claudeDir, off.manifest).state, 'disabled');
    const unset = world({ installs: [{ scope: 'user', version: '2.14.0' }] });
    assert.equal(pluginStatus(unset.claudeDir, unset.manifest).state, 'ok');
  });

  it('prefers the user-scope entry', () => {
    const { claudeDir, manifest } = world({
      installs: [{ scope: 'project', version: '2.10.0' }, { scope: 'user', version: '2.14.0' }],
      enabled: true,
    });
    assert.equal(pluginStatus(claudeDir, manifest).installed, '2.14.0');
  });

  it('ignores malformed files', () => {
    const { claudeDir, manifest } = world({ enabled: true });
    fs.writeFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), '{not json');
    assert.equal(pluginStatus(claudeDir, manifest).state, 'missing');
  });

  it('names the config dir in the install command only when it is not the default', () => {
    assert.equal(installCommand(path.join(os.homedir(), '.claude')), 'claude-code-kanban --install --yes');
    assert.equal(installCommand('C:/demo/.claude'), 'claude-code-kanban --install --yes --dir "C:/demo/.claude"');
  });

  it('reads the manifest shipped in the package', () => {
    const shipped = JSON.parse(fs.readFileSync(BUNDLED_MANIFEST, 'utf8'));
    assert.equal(pluginStatus(world().claudeDir).bundled, shipped.version);
  });
});

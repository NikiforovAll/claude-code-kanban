const fs = require('node:fs');
const path = require('node:path');
const { isDefaultClaudeDir, displayPath } = require('./claude-dir');

const PLUGIN_ID = 'claude-code-kanban@claude-code-kanban';
const BUNDLED_MANIFEST = path.join(__dirname, '..', 'plugin', 'plugins', 'claude-code-kanban', '.claude-plugin', 'plugin.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The claude CLI records installs in <config dir>/plugins/installed_plugins.json, one entry per scope.
// A user-scope entry wins, because install.js installs at user scope.
function pluginStatus(claudeDir, bundledManifest = BUNDLED_MANIFEST) {
  const bundled = readJson(bundledManifest)?.version ?? null;
  const installs = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'))?.plugins?.[PLUGIN_ID];
  const entries = Array.isArray(installs) ? installs : [];
  const entry = entries.find((e) => e?.scope === 'user') ?? entries[0];
  const installed = typeof entry?.version === 'string' ? entry.version : null;
  const enabled = readJson(path.join(claudeDir, 'settings.json'))?.enabledPlugins?.[PLUGIN_ID] !== false;
  let state = 'ok';
  if (!installed) state = 'missing';
  else if (!enabled) state = 'disabled';
  else if (bundled && installed !== bundled) state = 'mismatch';
  return { bundled, installed, state, configDir: displayPath(claudeDir), installCommand: installCommand(claudeDir) };
}

// --dir rather than CLAUDE_CONFIG_DIR=…, so the same line runs in bash, PowerShell and cmd.
function installCommand(claudeDir) {
  const base = 'claude-code-kanban --install --yes';
  return isDefaultClaudeDir(claudeDir) ? base : `${base} --dir "${claudeDir}"`;
}

module.exports = { pluginStatus, installCommand, PLUGIN_ID, BUNDLED_MANIFEST };

const path = require('node:path');
const { readSettings } = require('./claude-settings');

const MIN_WINDOW = 100000;
const MAX_WINDOW = 1000000;

function toInt(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Claude Code merges settings as project local > project > user, and an env var beats the
// `autoCompactWindow` key. Shell env and managed settings are not visible from here.
// https://code.claude.com/docs/en/env-vars.md, https://code.claude.com/docs/en/settings-reference.md
function getAutoCompact(claudeDir, projectPath) {
  const files = [path.join(claudeDir, 'settings.json')];
  if (projectPath) {
    files.push(path.join(projectPath, '.claude', 'settings.json'), path.join(projectPath, '.claude', 'settings.local.json'));
  }
  let enabled = true;
  let envWindow = null;
  let keyWindow = null;
  let pct = null;
  for (const file of files) {
    const s = readSettings(file);
    if (!s || typeof s !== 'object') continue;
    if (typeof s.autoCompactEnabled === 'boolean') enabled = s.autoCompactEnabled;
    keyWindow = toInt(s.autoCompactWindow) ?? keyWindow;
    envWindow = toInt(s.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW) ?? envWindow;
    pct = toInt(s.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) ?? pct;
  }
  if (!enabled) return null;
  const window = envWindow ?? keyWindow;
  const validPct = pct != null && pct >= 1 && pct <= 100 ? pct : null;
  if (window == null && validPct == null) return null;
  return {
    window: window == null ? null : Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, window)),
    pct: validPct,
  };
}

module.exports = { getAutoCompact };

#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync } = require('node:child_process');
const { getClaudeDir, claudeCliEnv, displayPath } = require('./lib/claude-dir');
const { PLUGIN_ID } = require('./lib/plugin-status');

const CLAUDE_DIR = getClaudeDir();
const CLI_ENV = claudeCliEnv(CLAUDE_DIR);
const CCK_DIR = path.join(CLAUDE_DIR, '.cck');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const PLUGIN_SRC = path.join(__dirname, 'plugin');
const PLUGIN_DEST = path.join(CCK_DIR, 'plugin');
// Earlier versions piped the statusLine through this script to capture context use; the plugin's mod does it now.
const CTX_SCRIPT_NAME = 'context-status.sh';
const CTX_SCRIPT_DEST = path.join(CLAUDE_DIR, 'hooks', CTX_SCRIPT_NAME);
const MIN_CLAUDE_VERSION = [2, 1, 287];

// ANSI helpers
const green = s => `\x1b[32m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const bold = s => `\x1b[1m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(!answer || answer.trim().toLowerCase() !== 'n');
    });
  });
}

function runCLI(cmd, okPatterns = []) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: CLI_ENV }).trim();
    return { ok: true, output: out };
  } catch (e) {
    const stderr = e.stderr?.trim() || e.message;
    if (okPatterns.some(p => stderr.includes(p))) return { ok: true, idempotent: true };
    return { ok: false, error: stderr };
  }
}

function isBelowMinVersion(versionOutput) {
  const parts = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput)?.slice(1).map(Number);
  if (!parts) return false;
  const i = parts.findIndex((n, k) => n !== MIN_CLAUDE_VERSION[k]);
  return i !== -1 && parts[i] < MIN_CLAUDE_VERSION[i];
}

function removeContextSpy() {
  if (fs.existsSync(CTX_SCRIPT_DEST)) {
    fs.unlinkSync(CTX_SCRIPT_DEST);
    console.log(`  Old context spy: ${green('✓')} Removed ${dim(displayPath(CTX_SCRIPT_DEST))}`);
  }
  if (!fs.existsSync(SETTINGS_PATH)) return;
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    console.log(`  Settings: ${red('✗')} Could not parse settings.json`);
    return;
  }
  const cmd = settings.statusLine?.command;
  if (!cmd?.includes(CTX_SCRIPT_NAME)) return;
  const stripped = cmd.replace(/\S*context-status\.sh\s*\|?\s*/, '').trim();
  if (stripped) {
    settings.statusLine.command = stripped;
    console.log(`  StatusLine: ${green('✓')} Restored to "${stripped}"`);
  } else {
    delete settings.statusLine;
    console.log(`  StatusLine: ${green('✓')} Removed`);
  }
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

// Deletes files but never directories: on Windows the running Claude Code process holds
// handles on the registered marketplace dirs, so removing one fails EPERM mid-clean and
// leaves the install gutted. Clearing files alone still drops anything stale, and the
// leftover empty dirs are harmless — copyDirSync writes straight back into them.
function clearFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) clearFilesRecursive(target);
    else fs.rmSync(target, { force: true });
  }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      try { fs.chmodSync(destPath, 0o755); } catch {}
    }
  }
}

async function runInstall({ yes = false } = {}) {
  console.log(`\n  ${bold('claude-code-kanban')} — Plugin installer\n`);
  console.log(`  Claude config dir: ${dim(displayPath(CLAUDE_DIR))}\n`);
  let failed = false;

  // 1. Check prerequisites
  process.stdout.write('  Checking claude CLI... ');
  const claude = runCLI('claude --version');
  if (claude.ok) {
    console.log(green(`✓ found (${claude.output})`));
    if (isBelowMinVersion(claude.output)) {
      console.log(`    ${yellow(`⚠ context use and cost tracking needs Claude Code ${MIN_CLAUDE_VERSION.join('.')} or later — run \`claude update\``)}`);
    }
  } else {
    console.log(red('✗ claude CLI not found'));
    console.log(`    ${dim('Install Claude Code CLI first: https://docs.anthropic.com/en/docs/claude-code')}`);
    return;
  }

  // 2. Copy plugin to stable location & register marketplace
  console.log(`\n  Plugin: ${dim(PLUGIN_DEST)}`);
  if (yes || await prompt(`    Install claude-code-kanban plugin? [Y/n] `)) {
    process.stdout.write(`    Copying plugin to ${displayPath(PLUGIN_DEST)}... `);
    try {
      clearFilesRecursive(PLUGIN_DEST);
      copyDirSync(PLUGIN_SRC, PLUGIN_DEST);
      console.log(green('✓'));
    } catch (e) {
      console.log(red(`✗ ${e.message}`));
      failed = true;
    }

    process.stdout.write('    Registering marketplace... ');
    const mkt = runCLI(`claude plugin marketplace add "${PLUGIN_DEST}"`, ['already', 'exists']);
    if (mkt.ok) {
      console.log(green(mkt.idempotent ? '✓ already registered' : '✓'));
    } else {
      console.log(yellow(`⚠ ${mkt.error}`));
    }

    // Claude caches the marketplace manifest, so a re-copied plugin stays invisible until refreshed
    const upd = runCLI('claude plugin marketplace update claude-code-kanban');
    if (!upd.ok) console.log(`    ${yellow('⚠')} Marketplace refresh failed: ${upd.error}`);

    const inst = runCLI(`claude plugin install ${PLUGIN_ID}`,['already installed', 'already exists']);
    const alreadyInstalled = inst.idempotent || /already installed/i.test(inst.output || '');
    if (inst.ok) {
      console.log(`    ${green('✓')} ${alreadyInstalled ? 'Already installed' : 'Plugin installed'}`);
    } else {
      console.log(`    ${red('✗')} Plugin install failed: ${inst.error}`);
      failed = true;
    }

    // `install` is a no-op once the plugin is present — it exits 0 and only says so
    // on stdout — so a re-copied plugin keeps running from the old cached version
    // until `update` pulls the new one in. That is how a config dir ends up serving
    // a plugin older than the board it talks to.
    if (alreadyInstalled) {
      const upgrade = runCLI('claude plugin update claude-code-kanban', ['already at the latest']);
      if (upgrade.ok) {
        const line = (upgrade.output || '').split('\n').find(l => l.includes('updated from'));
        console.log(`    ${green('✓')} ${line ? line.replace(/^[^A-Za-z]*/, '') : 'Already at the latest version'}`);
      } else {
        console.log(`    ${yellow('⚠')} Plugin update failed: ${upgrade.error}`);
      }
    }
  } else {
    console.log(`    ${dim('Skipped')}`);
  }

  console.log('');
  removeContextSpy();
  printSummary(failed);
}

function printSummary(failed = false) {
  if (failed) {
    console.log(`\n  ${red('Setup incomplete — see the errors above.')}\n`);
    return;
  }
  console.log(`\n  ${green('Setup complete. Agent activity will appear in the Kanban dashboard.')}\n`);
}

async function runUninstall() {
  console.log(`\n  ${bold('claude-code-kanban')} — Uninstaller\n`);
  console.log(`  Claude config dir: ${dim(displayPath(CLAUDE_DIR))}\n`);

  // 1. Uninstall plugin via Claude CLI
  process.stdout.write('  Removing plugin... ');
  const uninst = runCLI('claude plugin uninstall claude-code-kanban', ['not found', 'not installed']);
  if (uninst.ok) {
    console.log(uninst.idempotent ? dim('Not installed') : green('✓ Removed'));
  } else {
    console.log(yellow(`⚠ ${uninst.error}`));
  }

  // 2. Remove marketplace
  process.stdout.write('  Removing marketplace... ');
  const rmMkt = runCLI('claude plugin marketplace remove claude-code-kanban', ['not found', 'not configured']);
  if (rmMkt.ok) {
    console.log(rmMkt.idempotent ? dim('Not configured') : green('✓ Removed'));
  } else {
    console.log(yellow(`⚠ ${rmMkt.error}`));
  }

  // 3. Remove plugin copy
  if (fs.existsSync(PLUGIN_DEST)) {
    fs.rmSync(PLUGIN_DEST, { recursive: true, force: true });
    console.log(`  Plugin copy: ${green('✓')} Removed`);
  } else {
    console.log(`  Plugin copy: ${dim('Not found')}`);
  }

  removeContextSpy();

  console.log(`\n  ${green('Uninstall complete.')}\n`);
}

module.exports = { runInstall, runUninstall };

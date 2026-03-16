#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_SCRIPT_DEST = path.join(HOOKS_DIR, 'agent-spy.sh');
const HOOK_SCRIPT_SRC = path.join(__dirname, 'hooks', 'agent-spy.sh');
const CTX_SCRIPT_DEST = path.join(HOOKS_DIR, 'context-status.sh');
const CTX_SCRIPT_SRC = path.join(__dirname, 'hooks', 'context-status.sh');
const AGENT_ACTIVITY_DIR = path.join(CLAUDE_DIR, 'agent-activity');

const HOOK_COMMAND = '~/.claude/hooks/agent-spy.sh';
const HOOK_EVENTS = [
  { event: 'SubagentStart' },
  { event: 'SubagentStop' },
  { event: 'TeammateIdle' },
  { event: 'PermissionRequest' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion' },
  { event: 'PostToolUse' },
];

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

async function runInstall() {
  console.log(`\n  ${bold('claude-code-kanban')} — Agent Log hook installer\n`);

  // 1. Check bash
  process.stdout.write('  Checking bash... ');
  try {
    const bashPath = execSync('which bash', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    console.log(green(`✓ found (${bashPath})`));
  } catch {
    const shell = process.env.SHELL || process.env.BASH || '';
    if (shell.includes('bash')) {
      console.log(green(`✓ found via $SHELL (${shell})`));
    } else {
      const currentShell = shell || process.env.ComSpec || 'unknown';
      console.log(yellow(`⚠ bash not found (current shell: ${currentShell})`));
      console.log(`    ${dim('Hook scripts use #!/bin/bash and require a bash environment')}`);
      if (!(await prompt(`    Continue anyway? [Y/n] `))) {
        console.log(`\n  ${dim('Install cancelled.')}\n`);
        return;
      }
    }
  }

  // 2. Check jq
  process.stdout.write('  Checking jq... ');
  try {
    const ver = execSync('jq --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    console.log(green(`✓ found (${ver})`));
  } catch {
    console.log(yellow('⚠ not found — hook script requires jq for JSON parsing'));
  }

  async function installScript(label, src, dest) {
    console.log(`\n  ${label}: ${dim(dest)}`);
    if (fs.existsSync(dest)) {
      const existing = fs.readFileSync(dest, 'utf8');
      const bundled = fs.readFileSync(src, 'utf8');
      if (existing === bundled) {
        console.log(`    ${green('✓')} Up to date`);
        return true;
      }
      if (await prompt(`    Different version found. Update? [Y/n] `)) {
        fs.mkdirSync(HOOKS_DIR, { recursive: true });
        fs.copyFileSync(src, dest);
        try { fs.chmodSync(dest, 0o755); } catch {}
        console.log(`    ${green('✓')} Updated`);
        return true;
      }
      console.log(`    ${dim('Skipped')}`);
      return false;
    }
    if (await prompt(`    Not found. Install? [Y/n] `)) {
      fs.mkdirSync(HOOKS_DIR, { recursive: true });
      fs.copyFileSync(src, dest);
      try { fs.chmodSync(dest, 0o755); } catch {}
      console.log(`    ${green('✓')} Installed and set executable`);
      return true;
    }
    console.log(`    ${dim('Skipped')}`);
    return false;
  }

  // 3. Hook scripts
  const hookInstalled = await installScript('Hook script', HOOK_SCRIPT_SRC, HOOK_SCRIPT_DEST);
  const ctxInstalled = await installScript('Context spy', CTX_SCRIPT_SRC, CTX_SCRIPT_DEST);

  // 4. Settings.json
  console.log(`\n  Settings: ${dim(SETTINGS_PATH)}`);
  let settings;
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } else {
      settings = {};
    }
  } catch (e) {
    console.log(`    ${red('✗')} Malformed JSON in settings.json — aborting settings update`);
    printSummary(hookInstalled, false);
    return;
  }

  if (!settings.hooks) settings.hooks = {};

  const needed = [];
  for (const { event, matcher } of HOOK_EVENTS) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const matcherStr = matcher || '';
    const exists = settings.hooks[event].some(g =>
      g.matcher === matcherStr && g.hooks?.some(h => h.command === HOOK_COMMAND)
    );
    if (!exists) needed.push({ event, matcher: matcherStr });
  }

  let settingsUpdated = false;
  if (needed.length === 0) {
    console.log(`    ${green('✓')} Already configured`);
    settingsUpdated = true;
  } else {
    console.log(`    Adding hooks for: ${needed.map(n => n.matcher ? `${n.event}:${n.matcher}` : n.event).join(', ')}`);
    if (await prompt(`    Update settings? [Y/n] `)) {
      for (const { event, matcher } of needed) {
        settings.hooks[event].push({
          matcher,
          hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }]
        });
      }
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
      console.log(`    ${green('✓')} ${needed.length} hook entries added`);
      settingsUpdated = true;
    } else {
      console.log(`    ${dim('Skipped')}`);
    }
  }

  // 5. StatusLine setup (separate approval)
  const CTX_COMMAND = '~/.claude/hooks/context-status.sh';
  let statusLineUpdated = false;
  if (ctxInstalled) {
    const hasCtx = settings.statusLine?.command?.includes('context-status.sh');
    if (hasCtx) {
      console.log(`\n  StatusLine: ${green('✓')} Already configured`);
      statusLineUpdated = true;
    } else if (!settings.statusLine) {
      console.log(`\n  StatusLine: ${dim('not configured')}`);
      if (await prompt(`    Set up context tracking statusline? [Y/n] `)) {
        settings.statusLine = { command: CTX_COMMAND };
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
        console.log(`    ${green('✓')} StatusLine configured`);
        statusLineUpdated = true;
      } else {
        console.log(`    ${dim('Skipped')}`);
      }
    } else {
      const existing = settings.statusLine.command;
      console.log(`\n  StatusLine: ${dim(`current: ${existing}`)}`);
      if (await prompt(`    Prepend context spy to existing statusline? [Y/n] `)) {
        settings.statusLine.command = `${CTX_COMMAND} | ${existing}`;
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
        console.log(`    ${green('✓')} StatusLine updated`);
        statusLineUpdated = true;
      } else {
        console.log(`    ${dim('Skipped')}`);
      }
    }
  }

  printSummary(hookInstalled, settingsUpdated);
}

function printSummary(hookOk, settingsOk) {
  console.log('');
  if (hookOk && settingsOk) {
    console.log(`  ${green('Agent Log will appear in the Kanban footer when subagents are active.')}`);
  } else {
    console.log(`  ${yellow('Partial install — re-run --install to complete setup.')}`);
  }
  console.log('');
}

async function runUninstall() {
  console.log(`\n  ${bold('claude-code-kanban')} — Agent Log hook uninstaller\n`);

  // 1. Remove hook entries from settings.json
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      let removed = 0;
      if (settings.hooks) {
        const eventNames = [...new Set(HOOK_EVENTS.map(e => e.event))];
        for (const event of eventNames) {
          if (!Array.isArray(settings.hooks[event])) continue;
          const before = settings.hooks[event].length;
          settings.hooks[event] = settings.hooks[event].map(g => {
            if (!g.hooks?.some(h => h.command === HOOK_COMMAND)) return g;
            const filtered = g.hooks.filter(h => h.command !== HOOK_COMMAND);
            return filtered.length > 0 ? { ...g, hooks: filtered } : null;
          }).filter(Boolean);
          removed += before - settings.hooks[event].length;
          if (settings.hooks[event].length === 0) delete settings.hooks[event];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }

      // Strip context-status.sh from statusLine, restore downstream command if any
      if (settings.statusLine?.command?.includes('context-status.sh')) {
        const cmd = settings.statusLine.command;
        const stripped = cmd.replace(/~\/\.claude\/hooks\/context-status\.sh\s*\|\s*/, '').trim();
        if (stripped && stripped !== cmd) {
          settings.statusLine.command = stripped;
          console.log(`  StatusLine: ${green('✓')} Restored to "${stripped}"`);
        } else {
          delete settings.statusLine;
          console.log(`  StatusLine: ${green('✓')} Removed`);
        }
      }

      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
      if (removed > 0) {
        console.log(`  Settings: ${green('✓')} Removed ${removed} hook entries`);
      } else {
        console.log(`  Settings: ${dim('No hook entries found')}`);
      }
    } catch {
      console.log(`  Settings: ${red('✗')} Could not parse settings.json`);
    }
  } else {
    console.log(`  Settings: ${dim('No settings.json found')}`);
  }

  // 2. Remove hook scripts
  if (fs.existsSync(HOOK_SCRIPT_DEST)) {
    fs.unlinkSync(HOOK_SCRIPT_DEST);
    console.log(`  Hook script: ${green('✓')} Removed`);
  } else {
    console.log(`  Hook script: ${dim('Not found')}`);
  }
  if (fs.existsSync(CTX_SCRIPT_DEST)) {
    fs.unlinkSync(CTX_SCRIPT_DEST);
    console.log(`  Context spy: ${green('✓')} Removed`);
  } else {
    console.log(`  Context spy: ${dim('Not found')}`);
  }

  // 3. Optionally remove agent-activity data
  if (fs.existsSync(AGENT_ACTIVITY_DIR)) {
    if (await prompt(`\n  Remove agent activity data (${AGENT_ACTIVITY_DIR})? [y/N] `)) {
      fs.rmSync(AGENT_ACTIVITY_DIR, { recursive: true, force: true });
      console.log(`  ${green('✓')} Agent activity data removed`);
    } else {
      console.log(`  ${dim('Kept agent activity data')}`);
    }
  }

  console.log(`\n  ${green('Uninstall complete.')}\n`);
}

module.exports = { runInstall, runUninstall };

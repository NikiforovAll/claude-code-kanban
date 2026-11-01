#!/usr/bin/env node
'use strict';

// Starts a real claude through the terminal service for each startup dialog case, answers
// the dialogs itself and checks that cck held the first prompt until they were gone and then
// sent it. Records each run as a fixture that test/terminal.test.js replays.
// Run by hand after a Claude Code update: npm run test:live-dialogs [-- case ...]
// It needs a logged-in claude and spends one small haiku turn per case.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const realPty = require('@lydell/node-pty');
const { Terminal } = require('@xterm/headless');
const { createTerminalService, readTerminalConfig, DIALOG_SCREEN, screenText: screen } = require('../lib/terminal');
const { readLiveSessions } = require('../lib/live-sessions');
const { whichSync } = require('../lib/open-editor');
const { encodeProjectDirName } = require('../lib/claude-dir');

const CASES = {
  trust: { trusted: false, mcp: false, expect: ['trust'] },
  mcp: { trusted: true, mcp: true, expect: ['mcp'] },
  'trust-mcp': { trusted: false, mcp: true, expect: ['trust', 'mcp'] },
};
const PROMPT = 'Reply with the single word OK and nothing else.';
const FIXTURES = path.join(__dirname, 'fixtures', 'startup-dialogs');
const SOURCE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTLE_MS = 3000;
const STEP_TIMEOUT_MS = 90_000;
// Ctrl+P and Ctrl+N, not the arrows: on Windows the trust dialog read the Esc of an arrow on its
// own as "cancel" and exited.
const UP = '\x10';
const DOWN = '\x0e';
// The choice each case picks, so the run never approves the dummy MCP server.
const ANSWERS = { trust: /Yes, I trust this folder/, mcp: /Continue without/i };
// A refresh in the scratch copy could rotate the refresh token and log out the source dir.
const MIN_TOKEN_MS = 30 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const longPath = (p) => fs.realpathSync.native(p);

function dialogKind(text) {
  if (!DIALOG_SCREEN.test(text)) return null;
  if (/MCP server/i.test(text)) return 'mcp';
  if (/trust/i.test(text)) return 'trust';
  return 'unknown';
}

// The arrow presses that move the pointer from the selected choice to the one matching `want`.
function keysTo(text, want) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^\s*❯\s/.test(l));
  const to = lines.findIndex((l) => want.test(l));
  if (at < 0 || to < 0) return null;
  return (to > at ? DOWN : UP).repeat(Math.abs(to - at));
}

function seedConfigDir(dir) {
  const creds = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, '.credentials.json'), 'utf8')).claudeAiOauth;
  if (!creds?.accessToken) throw new Error(`no claude.ai login in ${SOURCE_DIR}`);
  if (creds.expiresAt - Date.now() < MIN_TOKEN_MS) {
    throw new Error('the access token expires within 30 min; run any claude session first so it refreshes, then rerun');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: creds }));
  const state = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, '.claude.json'), 'utf8'));
  delete state.mcpServers;
  delete state.githubRepoPaths;
  state.projects = {};
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(state));
}

function trustFolder(configDir, cwd) {
  const file = path.join(configDir, '.claude.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.projects[cwd.replace(/\\/g, '/')] = { hasTrustDialogAccepted: true };
  fs.writeFileSync(file, JSON.stringify(state));
}

function firstUserText(file) {
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'user' || e.isMeta) continue;
    const c = e.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
    if (text && !text.startsWith('<')) return text;
  }
  return null;
}

function scrub(s, cwd) {
  let out = s;
  for (const [p, tag] of [[cwd, 'WORKDIR'], [os.homedir(), 'HOME']]) {
    for (const form of [p, p.replace(/\\/g, '/')]) out = out.split(form).join(tag);
  }
  return out;
}

async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// node-pty with the service's writes logged, and an unlogged `send` for the script's own keys.
function recordingPty(term) {
  const rec = { out: '', writes: [], send: null };
  const pty = {
    spawn(...args) {
      const proc = realPty.spawn(...args);
      const write = proc.write.bind(proc);
      rec.send = write;
      proc.write = (d) => { rec.writes.push(d); write(d); };
      proc.onData((d) => { rec.out += d; term.write(d); });
      return proc;
    },
  };
  return { pty, rec };
}

async function runCase(name, c, configDir, base, version) {
  // claude prints the folder on its main screen, and a "trust" in it would hold the replayed prompt.
  const cwd = longPath(fs.mkdtempSync(path.join(base, 'work-')));
  if (c.trusted) trustFolder(configDir, cwd);
  if (c.mcp) {
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({
      mcpServers: { 'live-check': { command: 'node', args: ['-e', 'setInterval(() => {}, 1e9)'] } },
    }));
  }

  const term = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
  const { pty, rec } = recordingPty(term);
  const svc = createTerminalService({
    config: { ...readTerminalConfig({ argv: [], env: {} }), enabled: true, restore: false, shell: process.env.CCK_TERMINAL_SHELL || null },
    net: { EXPOSED: false, upgradeVerdict: () => null },
    pty,
    claudeDir: configDir,
    isDefaultDir: false,
    which: whichSync,
    liveSessions: () => readLiveSessions(path.join(configDir, 'sessions')),
    isLiveElsewhere: () => false,
    resolveCwd: () => null,
    isAllowedFolder: () => true,
  });

  const id = crypto.randomUUID();
  const transcript = path.join(configDir, 'projects', encodeProjectDirName(cwd), `${id}.jsonl`);
  const fixture = { case: name, claudeVersion: version, steps: [], ready: '' };
  const seen = () => fixture.steps.map((s) => s.dialog);
  const problems = [];
  try {
    const r = await svc.startNew({ id, cwd, prompt: PROMPT, model: 'haiku' });
    if (r.error) throw new Error(r.error);
    let mark = 0;
    for (;;) {
      const kind = await waitFor(() => {
        if (rec.writes.length) return 'sent';
        return dialogKind(screen(term));
      }, STEP_TIMEOUT_MS, `a dialog or the prompt (${name})`);
      if (kind === 'sent') break;
      await sleep(SETTLE_MS);
      const now = screen(term);
      if (rec.writes.length) problems.push(`cck wrote ${JSON.stringify(rec.writes)} while the ${kind} dialog was up`);
      if (kind === 'unknown') {
        problems.push(`unknown dialog:\n${now}`);
        break;
      }
      if (dialogKind(now) !== kind) continue;
      fixture.steps.push({ dialog: kind, awaitingTrust: svc.list()[0].awaitingTrust, output: scrub(rec.out.slice(mark), cwd) });
      mark = rec.out.length;
      const keys = keysTo(now, ANSWERS[kind]);
      if (keys === null) {
        problems.push(`no choice matching ${ANSWERS[kind]} in the ${kind} dialog:\n${now}`);
        break;
      }
      for (const k of keys) {
        rec.send(k);
        await sleep(200);
      }
      rec.send('\r');
      await waitFor(() => dialogKind(screen(term)) !== kind || rec.writes.length, STEP_TIMEOUT_MS, `the ${kind} dialog to close`);
    }
    fixture.ready = scrub(rec.out.slice(mark), cwd);
    const pasted = rec.writes[0];
    if (pasted !== `\x1b[200~${PROMPT}\x1b[201~`) problems.push(`first write was ${JSON.stringify(pasted)}, not the prompt`);
    const got = await waitFor(() => firstUserText(transcript), STEP_TIMEOUT_MS, 'the prompt in the transcript');
    if (got.trim() !== PROMPT) problems.push(`transcript's first prompt is ${JSON.stringify(got)}`);
    if (JSON.stringify(seen().sort()) !== JSON.stringify([...c.expect].sort())) {
      problems.push(`saw dialogs [${seen()}], expected [${c.expect}]`);
    }
  } catch (e) {
    problems.push(`${e.message}\n--- screen ---\n${screen(term)}`);
  } finally {
    svc.shutdown();
    term.dispose();
  }
  return { fixture, seen: seen(), problems };
}

async function main() {
  const picked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = picked.length ? picked : Object.keys(CASES);
  for (const n of names) if (!CASES[n]) throw new Error(`unknown case ${n}; cases: ${Object.keys(CASES).join(', ')}`);
  const version = execSync('claude --version', { encoding: 'utf8' }).trim();
  const base = longPath(fs.mkdtempSync(path.join(os.tmpdir(), 'cck-live-dialogs-')));
  const configDir = path.join(base, 'config');
  seedConfigDir(configDir);
  console.log(`claude ${version}, scratch dir ${base}\n`);
  let failed = 0;
  try {
    fs.mkdirSync(FIXTURES, { recursive: true });
    for (const name of names) {
      const { fixture, seen, problems } = await runCase(name, CASES[name], configDir, base, version);
      if (problems.length) {
        failed++;
        console.log(`✖ ${name} (dialogs: ${seen.join(', ') || 'none'})`);
        for (const p of problems) console.log(`  ${p.replace(/\n/g, '\n  ')}`);
      } else {
        fs.writeFileSync(path.join(FIXTURES, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
        console.log(`✔ ${name} (dialogs: ${seen.join(', ')}); fixture written`);
      }
    }
  } finally {
    await sleep(1000);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

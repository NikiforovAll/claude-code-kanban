const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createTerminalClient } = require('../lib/terminal-client');

let ptyAvailable = false;
try {
  require('ws');
  require('@lydell/node-pty');
  ptyAvailable = true;
} catch { /* backend not installed on this platform */ }

const TOKEN = 'b'.repeat(64);
const SHELL = process.platform === 'win32' ? 'cmd.exe' : 'sh';
const SHELL_ID = '22222222-3333-4444-5555-666666666666';
const KNOWN = '22222222-3333-4444-5555-777777777777';
const BLOCK_MS = 2000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await wait(25);
  }
}

// The restore test resumes a session, which would start the real claude, so a stub goes
// first on PATH. Like claude, it outlives a closed console and Ctrl+C, so only a tree kill ends it.
function stubClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-fake-claude-'));
  const js = path.join(dir, 'claude.js');
  fs.writeFileSync(js, [
    "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran'), String(process.pid));",
    "for (const s of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(s, () => {});",
    'setTimeout(() => {}, 600000);',
  ].join('\n'));
  if (process.platform === 'win32') fs.writeFileSync(path.join(dir, 'claude.cmd'), `@"${process.execPath}" "${js}" %*\r\n`);
  else fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  return dir;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('terminal host process', { skip: !ptyAvailable }, () => {
  const events = { changes: 0, exits: [], saved: null, asks: [] };
  let terminal;
  let server;
  let port;
  let stubDir;

  before(async () => {
    stubDir = stubClaude();
    terminal = createTerminalClient({
      config: { enabled: true, restore: true, shell: SHELL, maxSessions: 30, scrollback: 100, noFlicker: true },
      net: { EXPOSED: false, upgradeVerdict: () => null },
      claudeDir: os.tmpdir(),
      isDefaultDir: false,
      sessionsDir: os.tmpdir(),
      token: TOKEN,
      load: () => events.saved,
      save: (data) => { events.saved = data; },
      resolveCwd: async (id) => { events.asks.push(id); return id === KNOWN ? os.tmpdir() : null; },
      isAllowedFolder: () => false,
      onChange: () => { events.changes++; },
      onExit: (id) => events.exits.push(id),
    });
    server = http.createServer();
    server.on('upgrade', (req, socket, head) => terminal.handleUpgrade(req, socket, head));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    terminal.setServerUrl(`http://127.0.0.1:${port}`);
    assert.equal(await terminal.started, null);
  });

  after(async () => {
    terminal.shutdown();
    server.close();
    const stubPid = Number(fs.readFileSync(path.join(stubDir, 'ran'), 'utf8'));
    await until(() => !alive(stubPid), 'the restored claude to be gone', 10000);
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it('asks cck for the folder and refuses what cck refuses', async () => {
    const started = await terminal.startNew({ cwd: os.tmpdir(), prompt: 'hi' });
    assert.equal(started.status, 403);
    assert.equal(events.asks.length, 1);
    assert.equal(await terminal.end('00000000-0000-4000-8000-000000000000', TOKEN), 'not-found');
    assert.equal(await terminal.end(SHELL_ID, 'nope'), 'auth');
  });

  it('keeps typing live while cck\'s main thread is blocked', async () => {
    const viewer = fork(path.join(__dirname, 'fixtures', 'terminal-viewer.js'), [String(port), TOKEN, SHELL_ID]);
    const next = (t) => new Promise((resolve) => viewer.on('message', (m) => { if (m.t === t) resolve(m); }));
    await next('ready');
    await until(() => terminal.isRunning(SHELL_ID), 'state copy');
    assert.deepEqual((await terminal.sessions()).map((s) => s.id), [SHELL_ID]);

    const result = next('result');
    viewer.send({ t: 'go', ms: BLOCK_MS });
    const blockedUntil = Date.now() + BLOCK_MS;
    while (Date.now() < blockedUntil) { /* cck busy */ }
    const { latencies } = await result;
    assert.ok(latencies.length >= 3, `keys answered while blocked: ${latencies.length}`);
    assert.ok(Math.max(...latencies) < BLOCK_MS / 2, `slowest echo ${Math.max(...latencies)} ms`);
  });

  it('restarts a crashed host and resumes from the saved list', async () => {
    const { hostPid } = await terminal.stats();
    await until(() => events.saved?.sessions, 'first save');
    events.saved = { sessions: [KNOWN] };
    events.exits.length = 0;
    process.kill(hostPid);
    await until(() => events.exits.includes(SHELL_ID), 'exit for the lost terminal');
    assert.equal(terminal.isRunning(SHELL_ID), false);
    await until(async () => terminal.unavailableReason() === null && (await terminal.stats()).hostPid !== hostPid, 'new host');
    terminal.restore();
    await until(() => terminal.isRunning(KNOWN), 'restored terminal');
    assert.ok(events.asks.includes(KNOWN));
    await until(() => fs.existsSync(path.join(stubDir, 'ran')), 'the stub, not the real claude, to start');
  });
});

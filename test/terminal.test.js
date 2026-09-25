const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shellArgs, readTerminalConfig } = require('../lib/terminal');

let WebSocket = null;
let ptyAvailable = false;
try {
  WebSocket = require('ws');
  require('@lydell/node-pty');
  ptyAvailable = true;
} catch { /* backend not installed on this platform */ }

const TOKEN = 'a'.repeat(64);
const SESSION = '11111111-2222-3333-4444-555555555555';
const SHELL = process.platform === 'win32' ? 'cmd.exe' : 'sh';

function startServer(extraArgs) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cck-term-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), ...extraArgs], {
    env: { ...process.env, PORT: '0', CLAUDE_CONFIG_DIR: dir, CCK_TERMINAL_TOKEN: TOKEN, CLAUDE_HUB: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/running at http:\/\/localhost:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { child, dir, port };
}

function stopServer(s) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(s.child.pid), '/f', '/t'], { stdio: 'ignore' });
  else s.child.kill();
  try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* locked by the dying child */ }
}

function handshakeStatus(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, { headers });
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', () => resolve(-1));
  });
}

// Collects JSON control messages and decoded output until `until` returns true.
function session(port, hello, until) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, { headers: { origin: `http://localhost:${port}` } });
    const got = { control: [], out: '', closeCode: null, ws };
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`timeout: ${JSON.stringify(got.control)} ${got.out}`)); }, 15000);
    const check = () => { if (until(got)) { clearTimeout(timer); resolve(got); } };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: TOKEN, cols: 80, rows: 24, ...hello })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) got.out += data.toString('utf8');
      else got.control.push(JSON.parse(data.toString()));
      check();
    });
    ws.on('close', (code) => { got.closeCode = code; check(); });
  });
}

describe('shellArgs', () => {
  it('keeps pwsh open after claude exits', () => {
    assert.deepEqual(shellArgs('C:/x/pwsh.exe', ['--resume', SESSION]), ['-NoLogo', '-NoExit', '-Command', `claude --resume ${SESSION}`]);
  });
  it('execs the same POSIX shell after claude exits', () => {
    assert.deepEqual(shellArgs('/bin/zsh', ['--resume', SESSION]), ['-c', `claude --resume ${SESSION}; exec "$0"`, '/bin/zsh']);
  });
  it('starts a bare shell in shell mode', () => {
    assert.deepEqual(shellArgs('cmd.exe', null), []);
  });
});

describe('readTerminalConfig', () => {
  it('is off by default and turns on from the flag or the hub block', () => {
    assert.equal(readTerminalConfig({ argv: [], env: {} }).enabled, false);
    assert.equal(readTerminalConfig({ argv: ['--enable-terminal'], env: {} }).enabled, true);
    const c = readTerminalConfig({ argv: [], env: { CCK_TERMINAL: '{"enabled":true,"maxSessions":2,"noFlicker":false}' } });
    assert.equal(c.enabled, true);
    assert.equal(c.maxSessions, 2);
    assert.equal(c.noFlicker, false);
  });
  it('ignores a malformed block', () => {
    assert.equal(readTerminalConfig({ argv: [], env: { CCK_TERMINAL: '{' } }).enabled, false);
  });
});

describe('terminal endpoint', { skip: !ptyAvailable }, () => {
  let srv;
  let port;
  before(async () => {
    srv = startServer(['--enable-terminal', '--terminal-shell', SHELL]);
    port = await srv.port;
  });
  after(() => stopServer(srv));

  it('refuses a cross-origin handshake', async () => {
    assert.equal(await handshakeStatus(port, { origin: 'http://evil.com' }), 403);
  });
  it('refuses a handshake with no Origin', async () => {
    assert.equal(await handshakeStatus(port, {}), 403);
  });
  it('refuses a rebinding Host', async () => {
    assert.equal(await handshakeStatus(port, { host: `evil.com:${port}`, origin: `http://evil.com:${port}` }), 403);
  });
  it('closes on a wrong token', async () => {
    const got = await session(port, { token: 'nope', id: SESSION, mode: 'shell' }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4001);
  });
  it('closes on a non-UUID id', async () => {
    const got = await session(port, { id: '../../x', mode: 'shell' }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4002);
  });
  it('refuses to resume an unknown session', async () => {
    const got = await session(port, { id: SESSION, mode: 'resume' }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4004);
  });

  it('round-trips input, survives a reconnect, and ends on kill', async () => {
    const first = await session(port, { id: SESSION, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    assert.equal(first.control[0].attached, false);
    first.ws.send(JSON.stringify({ t: 'in', d: 'echo cck-round-trip\r' }));
    await new Promise((resolve) => {
      first.ws.on('message', (d, bin) => { if (bin && (first.out += d.toString()).includes('cck-round-trip')) resolve(); });
    });
    first.ws.close();

    const list = await (await fetch(`http://127.0.0.1:${port}/api/terminals`)).json();
    assert.equal(list.sessions.length, 1);

    const second = await session(port, { id: SESSION, mode: 'auto' }, (g) => g.out.includes('cck-round-trip'));
    assert.equal(second.control[0].t, 'ready');
    assert.equal(second.control[0].attached, true);

    second.ws.send(JSON.stringify({ t: 'kill' }));
    await new Promise((resolve) => {
      second.ws.on('message', (d, bin) => { if (!bin && JSON.parse(d.toString()).t === 'exit') resolve(); });
    });
    const after = await (await fetch(`http://127.0.0.1:${port}/api/terminals`)).json();
    assert.equal(after.sessions.length, 0);
  });

  it('ends a terminal over HTTP only with the token', async () => {
    const got = await session(port, { id: SESSION, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    const exited = new Promise((resolve) => {
      got.ws.on('message', (d, bin) => { if (!bin && JSON.parse(d.toString()).t === 'exit') resolve(); });
    });
    const del = (id, token) => fetch(`http://127.0.0.1:${port}/api/terminals/${id}`, {
      method: 'DELETE',
      headers: { origin: `http://localhost:${port}`, 'x-terminal-token': token },
    });
    assert.equal((await del(SESSION, 'nope')).status, 401);
    assert.equal((await del('00000000-0000-4000-8000-000000000000', TOKEN)).status, 404);
    assert.equal((await del(SESSION, TOKEN)).status, 204);
    await exited;
    const after = await (await fetch(`http://127.0.0.1:${port}/api/terminals`)).json();
    assert.equal(after.sessions.length, 0);
  });
});

describe('terminal endpoint when disabled', { skip: !ptyAvailable }, () => {
  let srv;
  let port;
  before(async () => {
    srv = startServer([]);
    port = await srv.port;
  });
  after(() => stopServer(srv));

  it('refuses the handshake', async () => {
    assert.equal(await handshakeStatus(port, { origin: `http://localhost:${port}` }), 403);
  });
});

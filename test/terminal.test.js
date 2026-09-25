const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { shellArgs, readTerminalConfig, resolveShell, claudeArgsFor, parseNewSpec, findPickProcess } = require('../lib/terminal');

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
  // A child that outlives the kill must not keep the test process alive through its pipes.
  s.child.stdout.destroy();
  s.child.stderr.destroy();
  s.child.unref();
  try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* locked by the dying child */ }
}

// A fresh connection per call: a pooled keep-alive socket can be closed by the server just as it is reused.
function api(port, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
    });
    req.setTimeout(15000, () => req.destroy(new Error(`timeout: ${method} ${pathname}`)));
    req.on('error', reject);
    req.end();
  });
}

// Resolves with the first truthy result of `test(data, isBinary)` for a message on `ws`.
function waitFor(ws, test, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), 15000);
    ws.on('message', (d, bin) => {
      const hit = test(d, bin);
      if (hit) { clearTimeout(timer); resolve(hit); }
    });
  });
}

function handshakeStatus(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, { headers, handshakeTimeout: 15000 });
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', (e) => resolve(`${e.code || ''} ${e.message}`));
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
  it('starts Git Bash as a login shell, before and after claude', () => {
    const bash = 'C:/Program Files/Git/bin/bash.exe';
    assert.deepEqual(shellArgs(bash, null), ['--login', '-i']);
    assert.deepEqual(shellArgs(bash, ['--resume', SESSION]), ['--login', '-i', '-c', `claude --resume ${SESSION}; exec bash --login -i`]);
  });
  it('quotes an argument with a space for each shell family', () => {
    const args = ['--name', 'Fix login'];
    assert.equal(shellArgs('pwsh.exe', args)[3], "claude --name 'Fix login'");
    assert.equal(shellArgs('cmd.exe', args)[1], 'claude --name "Fix login"');
  });
});

describe('new session options', () => {
  it('builds the claude flags, with the optional worktree value last', () => {
    const spec = parseNewSpec({ cwd: '/p', name: ' Fix login ', worktree: 'fix-login', model: 'haiku' });
    assert.deepEqual(claudeArgsFor('new', SESSION, spec),
      ['--session-id', SESSION, '--name', 'Fix login', '--model', 'haiku', '-w', 'fix-login']);
    assert.deepEqual(claudeArgsFor('new', SESSION, parseNewSpec({ cwd: '/p', worktree: true })), ['--session-id', SESSION, '-w']);
    assert.deepEqual(claudeArgsFor('new', SESSION, parseNewSpec({ cwd: '/p' })), ['--session-id', SESSION]);
  });
  it('names the field that fails its charset', () => {
    assert.equal(parseNewSpec({}), 'folder');
    assert.equal(parseNewSpec({ cwd: '/p', name: "x'; rm -rf ~" }), 'name');
    assert.equal(parseNewSpec({ cwd: '/p', name: '-x' }), 'name');
    assert.equal(parseNewSpec({ cwd: '/p', worktree: '../up' }), 'worktree name');
    assert.equal(parseNewSpec({ cwd: '/p', worktree: 1 }), 'worktree name');
    assert.equal(parseNewSpec({ cwd: '/p', model: 'opus; x' }), 'model');
  });
});

describe('resume picker', () => {
  it('opens claude\'s own picker', () => {
    assert.deepEqual(claudeArgsFor('pick', SESSION), ['--resume']);
  });
  it('finds the claude the PTY started by folder and start time, skipping claimed ones', () => {
    const cwd = __dirname;
    const pty = { cwd, startedAt: 10_000 };
    const live = [
      { pid: 1, cwd, startedAt: 1_000 },
      { pid: 2, cwd: os.tmpdir(), startedAt: 11_000 },
      { pid: 3, cwd: `${cwd}${path.sep}.`, startedAt: 11_000 },
      { pid: 4, cwd, startedAt: 12_000 },
    ];
    assert.equal(findPickProcess(live, pty, new Set()), 3);
    assert.equal(findPickProcess(live, pty, new Set([3])), 4);
    assert.equal(findPickProcess(live, pty, new Set([3, 4])), undefined);
  });
});

describe('resolveShell', () => {
  const which = (tools) => (cmd) => tools[cmd] || null;
  it('infers pwsh on Windows and $SHELL elsewhere', () => {
    assert.equal(resolveShell(null, which({ pwsh: 'C:/pwsh.exe' }), 'win32', {}), 'C:/pwsh.exe');
    assert.equal(resolveShell(null, which({ powershell: 'C:/ps.exe' }), 'win32', {}), 'C:/ps.exe');
    assert.equal(resolveShell(null, which({}), 'linux', { SHELL: '/bin/zsh' }), '/bin/zsh');
  });
  it('finds Git Bash beside git on PATH', () => {
    const git = path.join(__dirname, 'no-such-git', 'cmd', 'git.exe');
    assert.throws(() => resolveShell('gitbash', which({ git }), 'win32', {}), /"gitbash" not found/);
  });
  it('looks a name up on PATH and fails loudly when it is missing', () => {
    assert.equal(resolveShell('zsh', which({ zsh: '/usr/bin/zsh' }), 'linux', {}), '/usr/bin/zsh');
    assert.throws(() => resolveShell('fish', which({}), 'linux', {}), /"fish" not found/);
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
  it('takes the shell from the flag, then the env var, then the hub block', () => {
    const env = { CCK_TERMINAL: '{"shell":"pwsh"}', CCK_TERMINAL_SHELL: 'gitbash' };
    assert.equal(readTerminalConfig({ argv: [], env }).shell, 'gitbash');
    assert.equal(readTerminalConfig({ argv: [], env, getArgValue: () => 'cmd' }).shell, 'cmd');
    assert.equal(readTerminalConfig({ argv: [], env: { CCK_TERMINAL: '{"shell":"pwsh"}' } }).shell, 'pwsh');
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
  it('refuses a new session in a folder it does not know', async () => {
    const got = await session(port, { id: SESSION, mode: 'new', cwd: os.tmpdir() }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4004);
  });
  it('refuses a resume picker in a folder it does not know', async () => {
    const got = await session(port, { id: SESSION, mode: 'pick', cwd: os.tmpdir() }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4004);
  });
  it('refuses a new session with a bad name', async () => {
    const got = await session(port, { id: SESSION, mode: 'new', cwd: os.tmpdir(), name: 'a"b' }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4002);
  });
  it('opens the folder dialog only with the token', async () => {
    const res = await api(port, 'POST', '/api/terminal/pick-folder', { origin: `http://localhost:${port}`, 'x-terminal-token': 'nope' });
    assert.equal(res.status, 401);
  });

  it('round-trips input, survives a reconnect, and ends on kill', async () => {
    const first = await session(port, { id: SESSION, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    assert.equal(first.control[0].attached, false);
    first.ws.send(JSON.stringify({ t: 'in', d: 'echo cck-round-trip\r' }));
    await waitFor(first.ws, (d, bin) => bin && (first.out += d.toString()).includes('cck-round-trip'), 'echo');
    first.ws.close();

    const list = (await api(port, 'GET', '/api/terminals')).json;
    assert.equal(list.sessions.length, 1);

    const second = await session(port, { id: SESSION, mode: 'auto' }, (g) => g.out.includes('cck-round-trip'));
    assert.equal(second.control[0].t, 'ready');
    assert.equal(second.control[0].attached, true);

    const exited = waitFor(second.ws, (d, bin) => !bin && JSON.parse(d.toString()).t === 'exit', 'exit');
    second.ws.send(JSON.stringify({ t: 'kill' }));
    await exited;
    const after = (await api(port, 'GET', '/api/terminals')).json;
    assert.equal(after.sessions.length, 0);
  });

  it('ends a terminal over HTTP only with the token', async () => {
    const got = await session(port, { id: SESSION, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    const exited = waitFor(got.ws, (d, bin) => { const m = !bin && JSON.parse(d.toString()); return m.t === 'exit' && m; }, 'exit');
    const del = (id, token) =>
      api(port, 'DELETE', `/api/terminals/${id}`, { origin: `http://localhost:${port}`, 'x-terminal-token': token });
    assert.equal((await del(SESSION, 'nope')).status, 401);
    assert.equal((await del('00000000-0000-4000-8000-000000000000', TOKEN)).status, 404);
    assert.equal((await del(SESSION, TOKEN)).status, 204);
    const after = (await api(port, 'GET', '/api/terminals')).json;
    assert.equal(after.sessions.length, 0);
    assert.equal((await exited).ended, true);
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

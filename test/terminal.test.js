const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, realpathSync, rmSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createTerminalService, shellArgs, claudeCommand, readTerminalConfig, resolveShell, claudeArgsFor, parseNewSpec, findPickProcess, ptyEnv } = require('../lib/terminal');

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
  // os.tmpdir() can be an 8.3 short path, and libuv's Windows watcher asserts on an event
  // under one (fs-event.c), which kills the server the first time it writes to .cck.
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'cck-term-')));
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

// Windows loopback sometimes fails a connect with ETIMEDOUT under load, before any byte reaches the server.
const CONNECT_ERRORS = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']);

// The failures come in bursts that can last seconds, so the waits grow.
const CONNECT_RETRY_MS = [250, 500, 1000, 2000];

async function retryConnect(attempt) {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i === CONNECT_RETRY_MS.length || !CONNECT_ERRORS.has(e.code)) throw e;
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS[i]));
    }
  }
}

// A fresh connection per call: a pooled keep-alive socket can be closed by the server just as it is reused.
function api(port, method, pathname, headers = {}) {
  return retryConnect(() => apiOnce(port, method, pathname, headers));
}

function apiOnce(port, method, pathname, headers) {
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
  const once = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, { headers, handshakeTimeout: 15000 });
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', reject);
  });
  return retryConnect(once).catch((e) => `${e.code || ''} ${e.message}`);
}

// Collects JSON control messages and decoded output until `until` returns true.
function session(port, hello, until) {
  return retryConnect(() => sessionOnce(port, hello, until));
}

function sessionOnce(port, hello, until) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, { headers: { origin: `http://localhost:${port}` } });
    const got = { control: [], out: '', closeCode: null, ws };
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`timeout: ${JSON.stringify(got.control)} ${got.out}`)); }, 15000);
    const check = () => { if (until(got)) { clearTimeout(timer); resolve(got); } };
    let opened = false;
    ws.on('error', (e) => {
      clearTimeout(timer);
      // Only a failure before the handshake may be retried; after it the hello has reached the server.
      reject(opened ? new Error(e.message) : e);
    });
    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ t: 'hello', token: TOKEN, cols: 80, rows: 24, ...hello }));
    });
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
    assert.equal(parseNewSpec({ cwd: '/p', taskList: '../up' }), 'task list id');
    assert.equal(parseNewSpec({ cwd: '/p', taskList: 'a/b' }), 'task list id');
  });
  it('keeps a task list id off the command line', () => {
    const spec = parseNewSpec({ cwd: '/p', taskList: SESSION });
    assert.equal(spec.taskList, SESSION);
    assert.deepEqual(claudeArgsFor('new', SESSION, spec), ['--session-id', SESSION]);
    assert.equal(parseNewSpec({ cwd: '/p' }).taskList, null);
  });
  it('takes edit only as true, and strips control characters from its prompt', () => {
    assert.equal(parseNewSpec({ cwd: '/p', edit: true }).edit, true);
    assert.equal(parseNewSpec({ cwd: '/p', edit: 'yes' }).edit, false);
    assert.equal(parseNewSpec({ cwd: '/p', edit: true, prompt: 'a\x03b\x15c\n\td' }).prompt, 'abc\n\td');
    assert.equal(parseNewSpec({ cwd: '/p', prompt: 'a\x03b' }).prompt, 'a\x03b');
  });
  it('builds the command line an edit terminal types', () => {
    const args = claudeArgsFor('new', SESSION, parseNewSpec({ cwd: '/p', name: 'Fix login', model: 'opus' }));
    assert.equal(claudeCommand('pwsh.exe', args), `claude --session-id ${SESSION} --name 'Fix login' --model opus`);
    assert.equal(claudeCommand('cmd.exe', args), `claude --session-id ${SESSION} --name "Fix login" --model opus`);
  });
  it('puts the prompt first and quotes it for each shell family', () => {
    const args = ['--session-id', SESSION, '-w'];
    const text = "it's $HOME `x` ’q’ \"d\"\nnext";
    assert.equal(claudeCommand('pwsh.exe', args, text), `claude 'it''s $HOME \`x\` ’’q’’ "d"\nnext' --session-id ${SESSION} -w`);
    assert.equal(claudeCommand('/bin/zsh', args, text), `claude 'it'\\''s $HOME \`x\` ’q’ "d"\nnext' --session-id ${SESSION} -w`);
  });
});

describe('edit before run', () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';

  function service(live = [], shell = 'bash') {
    const pty = fakePty();
    const t = createTerminalService({
      config: { enabled: true, restore: false, shell, maxSessions: 30, scrollback: 100 },
      net: { EXPOSED: false },
      pty,
      token: TOKEN,
      claudeDir: os.tmpdir(),
      which: (n) => n,
      isLiveElsewhere: () => false,
      resolveCwd: () => null,
      isAllowedFolder: () => true,
      liveSessions: () => live,
      isPidAlive: () => true,
      exitPollMs: 20,
    });
    return { t, pty };
  }

  it('starts a plain shell and types the command without Enter once the shell settles', async () => {
    const { t, pty } = service();
    const r = await t.startNew({ id: A, cwd: os.tmpdir(), name: 'Fix login', prompt: 'line one\nline two', edit: true });
    assert.equal(r.id, A);
    const [p] = pty.spawned;
    assert.deepEqual(p.args, shellArgs('bash', null));
    p.emit('prompt> ');
    await until(() => p.written.length > 0);
    await wait(150);
    assert.deepEqual(p.written, [`\x1b[200~claude 'line one\rline two' --session-id ${A} --name 'Fix login'\x1b[201~`]);
    assert.equal(t.list()[0].edit, true);
    t.shutdown();
  });

  it('refuses a prompt when the shell is cmd, and takes the same session without one', async () => {
    const { t, pty } = service([], 'cmd.exe');
    const r = await t.startNew({ id: A, cwd: os.tmpdir(), prompt: 'hi', edit: true });
    assert.equal(r.status, 400);
    assert.match(r.error, /cmd/);
    assert.equal(pty.spawned.length, 0);
    assert.equal((await t.startNew({ id: A, cwd: os.tmpdir(), edit: true })).id, A);
    t.shutdown();
  });

  it('refuses a paste until the typed command runs claude', async () => {
    const live = [];
    const { t, pty } = service(live);
    await t.startNew({ id: A, cwd: os.tmpdir(), edit: true });
    pty.spawned[0].emit('prompt> ');
    await until(() => pty.spawned[0].written.length > 0);
    assert.equal(t.paste(A, 'hi'), false);
    live.push({ sessionId: A, pid: 4242, startedAt: Date.now() });
    let pasted = false;
    await until(() => (pasted = t.paste(A, 'hi')));
    assert.equal(pasted, true);
    t.shutdown();
  });

  it('leaves a normal new session as it was', async () => {
    const { t, pty } = service();
    await t.startNew({ id: A, cwd: os.tmpdir(), name: 'Fix login' });
    assert.ok(pty.spawned[0].args.join(' ').includes(`--session-id ${A}`));
    assert.equal(t.list()[0].edit, false);
    t.shutdown();
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

describe('ptyEnv', () => {
  it('pins the session to this board with CCK_URL', () => {
    const env = ptyEnv({ claudeDir: '/c', isDefaultDir: false, cckUrl: 'http://127.0.0.1:4795' });
    assert.equal(env.CCK_URL, 'http://127.0.0.1:4795');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/c');
    assert.equal(env.PORT, undefined);
  });

  it('drops an inherited CCK_URL when the port is not known yet', () => {
    const saved = process.env.CCK_URL;
    process.env.CCK_URL = 'http://127.0.0.1:1';
    try {
      assert.equal(ptyEnv({ claudeDir: '/c', isDefaultDir: true }).CCK_URL, undefined);
    } finally {
      if (saved === undefined) delete process.env.CCK_URL;
      else process.env.CCK_URL = saved;
    }
  });

  it('drops an inherited task list, so sharing one stays opt-in', () => {
    const saved = process.env.CLAUDE_CODE_TASK_LIST_ID;
    process.env.CLAUDE_CODE_TASK_LIST_ID = 'inherited';
    try {
      assert.equal(ptyEnv({ claudeDir: '/c', isDefaultDir: true }).CLAUDE_CODE_TASK_LIST_ID, undefined);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID;
      else process.env.CLAUDE_CODE_TASK_LIST_ID = saved;
    }
  });
});

describe('readTerminalConfig', () => {
  it('is off by default and turns on from the flag or the hub block', () => {
    assert.equal(readTerminalConfig({ argv: [], env: {} }).enabled, false);
    assert.equal(readTerminalConfig({ argv: [], env: {} }).maxSessions, 30);
    assert.equal(readTerminalConfig({ argv: ['--enable-terminal'], env: {} }).enabled, true);
    const c = readTerminalConfig({ argv: [], env: { CCK_TERMINAL: '{"enabled":true,"maxSessions":2,"noFlicker":false}' } });
    assert.equal(c.enabled, true);
    assert.equal(c.maxSessions, 2);
    assert.equal(c.noFlicker, false);
  });
  it('restores terminals unless the block turns it off', () => {
    assert.equal(readTerminalConfig({ argv: [], env: {} }).restore, true);
    assert.equal(readTerminalConfig({ argv: [], env: { CCK_TERMINAL: '{"restore":false}' } }).restore, false);
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

  it('writes its token in a file named by its port', () => {
    const file = path.join(srv.dir, '.cck', 'terminal-tokens', `${port}.json`);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, TOKEN);
  });

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

  it('hands the shell this board as CCK_URL', async () => {
    const got = await session(port, { id: SESSION, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    const ref = process.platform === 'win32' ? '%CCK_URL%' : '$CCK_URL';
    const want = `cck-url=http://127.0.0.1:${port}`;
    got.ws.send(JSON.stringify({ t: 'in', d: `echo cck-url=${ref}\r` }));
    await waitFor(got.ws, (d, bin) => bin && (got.out += d.toString()).includes(want), 'CCK_URL');
    const del = await api(port, 'DELETE', `/api/terminals/${SESSION}`, { origin: `http://localhost:${port}`, 'x-terminal-token': TOKEN });
    assert.equal(del.status, 204);
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

  it('raises the terminal host, its console host and an attached shell, and restores the shell on detach', { skip: process.platform !== 'win32' }, async () => {
    const { PRIORITY_NORMAL, PRIORITY_ABOVE_NORMAL } = os.constants.priority;
    const until = async (test, what) => {
      for (let i = 0; i < 100; i++) {
        if (test()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail(`timeout: ${what}`);
    };
    const children = (parent, name) => {
      const q = `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent} AND Name='${name}'").ProcessId`;
      return require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', q]).toString().split(/\s+/).filter(Boolean).map(Number);
    };
    const [host] = children(srv.child.pid, 'node.exe');
    assert.ok(host, 'terminal host');
    const hosts = () => children(host, 'conhost.exe');
    assert.equal(os.getPriority(host), PRIORITY_ABOVE_NORMAL);
    assert.equal(os.getPriority(srv.child.pid), PRIORITY_NORMAL);

    const got = await session(port, { id: SESSION, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    let pid = 0;
    // ConPTY reports the shell's pid only once its output pipe connects.
    for (let i = 0; i < 100 && !pid; i++) {
      [{ pid }] = (await api(port, 'GET', '/api/terminals')).json.sessions;
      if (!pid) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(pid, 'shell pid');
    await until(() => os.getPriority(pid) === PRIORITY_ABOVE_NORMAL, 'shell raised');
    await until(() => { const h = hosts(); return h.length > 0 && h.every((p) => os.getPriority(p) === PRIORITY_ABOVE_NORMAL); }, 'console host raised');

    got.ws.close();
    await until(() => os.getPriority(pid) === PRIORITY_NORMAL, 'shell restored');
    const del = await api(port, 'DELETE', `/api/terminals/${SESSION}`, { origin: `http://localhost:${port}`, 'x-terminal-token': TOKEN });
    assert.equal(del.status, 204);
  });
});

function fakePty({ holdExit = false } = {}) {
  const spawned = [];
  return {
    spawned,
    spawn(_file, args, opts) {
      let onExit = () => {};
      const p = {
        pid: 100000 + spawned.length, args, env: opts?.env, written: [], emit: () => {},
        onData(cb) { p.emit = cb; }, onExit(cb) { onExit = cb; }, write(d) { p.written.push(d); }, resize() {}, pause() {}, resume() {},
        exit() { onExit({ exitCode: 0 }); },
        kill() { if (!holdExit) setImmediate(() => onExit({ exitCode: 0 })); },
      };
      spawned.push(p);
      return p;
    },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!check() && Date.now() < end) await wait(10);
}

describe('terminal restore', () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const B = 'aaaaaaaa-0000-0000-0000-000000000002';
  const ELSEWHERE = 'aaaaaaaa-0000-0000-0000-000000000003';
  const UNKNOWN = 'aaaaaaaa-0000-0000-0000-000000000004';
  const GAP_MS = 60;
  const SAVE_MS = 20;

  function service(restore, initial, { live = [], dead = new Set() } = {}) {
    const store = { data: initial, loads: 0, saves: 0 };
    const pty = fakePty();
    const t = createTerminalService({
      config: { enabled: true, restore, shell: SHELL, maxSessions: 30, scrollback: 100 },
      net: { EXPOSED: false },
      pty,
      token: TOKEN,
      load: () => { store.loads++; return store.data; },
      save: (data) => { store.saves++; store.data = data; },
      restoreGapMs: GAP_MS,
      saveDelayMs: SAVE_MS,
      claudeDir: os.tmpdir(),
      which: (n) => n,
      isLiveElsewhere: (id) => id === ELSEWHERE,
      resolveCwd: (id) => ([A, B, ELSEWHERE].includes(id) ? os.tmpdir() : null),
      liveSessions: () => live,
      isPidAlive: (pid) => !dead.has(pid),
      exitPollMs: SAVE_MS,
    });
    return { t, pty, store };
  }

  it('resumes the saved terminals one at a time and keeps the list in step', async () => {
    const { t, pty, store } = service(true, { sessions: [A, ELSEWHERE, UNKNOWN, 'not-a-uuid', B] });
    t.restore();
    await until(() => t.list().length === 1);
    assert.deepEqual(t.list().map((s) => s.id), [A]);
    await until(() => t.list().length === 2 && store.data.sessions.length === 2);
    assert.deepEqual(t.list().map((s) => s.id).sort(), [A, B]);
    assert.ok(pty.spawned.every((p) => p.args.join(' ').includes('--resume')));
    assert.deepEqual(store.data.sessions.sort(), [A, B]);

    const saves = store.saves;
    assert.equal(t.end(A, TOKEN), null);
    await until(() => store.saves > saves);
    assert.deepEqual(store.data.sessions, [B]);
    assert.equal(store.saves, saves + 1);

    t.shutdown();
    await wait(SAVE_MS * 3);
    assert.deepEqual(store.data.sessions, [B]);
  });

  it('resumes a terminal with the task list it was saved with, and saves only valid ones', async () => {
    const { t, pty, store } = service(true, { sessions: [A, B], taskLists: { [A]: 'shared-list', [B]: '../up', [UNKNOWN]: 'x' } });
    t.restore();
    await until(() => t.list().length === 2 && store.saves > 0);
    const envOf = (id) => pty.spawned.find((p) => p.args.join(' ').includes(id)).env;
    assert.equal(envOf(A).CLAUDE_CODE_TASK_LIST_ID, 'shared-list');
    assert.equal(envOf(B).CLAUDE_CODE_TASK_LIST_ID, undefined);
    assert.deepEqual(store.data.taskLists, { [A]: 'shared-list' });
    t.shutdown();
  });

  it('stops restoring a terminal whose claude exited to its shell, and resumes when claude is back', async () => {
    const live = [];
    const { t, store } = service(true, { sessions: [A] }, { live });
    t.restore();
    await until(() => t.list().length === 1);
    live.push({ sessionId: A, pid: 4242, startedAt: Date.now() });
    await until(() => t.claudePids()[A] === 4242);
    assert.equal(t.paste(A, 'hi'), true);

    live.length = 0;
    await until(() => store.data.sessions.length === 0);
    assert.deepEqual(t.claudePids(), {});
    assert.equal(t.paste(A, 'hi'), false);
    assert.deepEqual(t.list().map((s) => s.id), [A]);

    live.push({ sessionId: A, pid: 4343, startedAt: Date.now() });
    await until(() => store.data.sessions.length === 1);
    assert.deepEqual(store.data.sessions, [A]);
    assert.equal(t.claudePids()[A], 4343);
    t.shutdown();
  });

  it('counts a crashed claude as gone, and a claude with no entry yet as starting', async () => {
    const live = [];
    const dead = new Set();
    const { t, store } = service(true, { sessions: [A, B] }, { live, dead });
    t.restore();
    await until(() => t.list().length === 2);
    live.push({ sessionId: B, pid: 5000, startedAt: Date.now() });
    await until(() => t.claudePids()[B] === 5000);

    dead.add(5000);
    await until(() => store.data.sessions.length === 1);
    assert.deepEqual(store.data.sessions, [A]);
    t.shutdown();
  });

  it('keeps a /clear, which moves the entry to a new session id under the same pid', async () => {
    const live = [{ sessionId: A, pid: 6000, startedAt: Date.now() }];
    const { t, store } = service(true, { sessions: [A] }, { live });
    t.restore();
    await until(() => t.claudePids()[A] === 6000);
    live[0] = { ...live[0], sessionId: B };
    await wait(SAVE_MS * 4);
    assert.deepEqual(store.data.sessions, [A]);
    assert.equal(t.claudePids()[A], 6000);
    t.shutdown();
  });

  it('neither reads the list nor starts anything when restore is off', async () => {
    const { t, pty, store } = service(false, { sessions: [A] });
    t.restore();
    await wait(SAVE_MS * 3);
    assert.equal(store.loads, 0);
    assert.equal(pty.spawned.length, 0);
    assert.deepEqual(store.data.sessions, [A]);
    t.shutdown();
  });
});

describe('terminal reopen', { skip: !WebSocket }, () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';

  it('starts a new PTY for an id whose ended PTY has not exited yet', async () => {
    const pty = fakePty({ holdExit: true });
    const t = createTerminalService({
      config: { enabled: true, restore: false, shell: SHELL, maxSessions: 30, scrollback: 100 },
      net: { EXPOSED: false, upgradeVerdict: () => null },
      pty,
      token: TOKEN,
      claudeDir: os.tmpdir(),
      which: (n) => n,
      isLiveElsewhere: () => false,
      resolveCwd: () => null,
      liveSessions: () => [],
    });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => t.handleUpgrade(req, socket, head));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const sockets = [];
    const ready = async () => {
      const got = await session(port, { id: A, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
      sockets.push(got.ws);
      return got;
    };
    try {
      const first = await ready();
      assert.equal(first.control[0].attached, false);
      assert.equal(t.end(A, TOKEN), null);

      const second = await ready();
      assert.equal(second.control[0].attached, false);
      assert.equal(pty.spawned.length, 2);

      pty.spawned[0].exit();
      assert.deepEqual(t.list().map((s) => s.id), [A]);
    } finally {
      for (const ws of sockets) ws.terminate();
      t.shutdown();
      server.close();
    }
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

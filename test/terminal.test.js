const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { QUERY_REPLY } = require('../lib/program-status');
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
function api(port, method, pathname, headers = {}, body) {
  return retryConnect(() => apiOnce(port, method, pathname, headers, body));
}

function apiOnce(port, method, pathname, headers, body) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  if (data !== undefined) headers = { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
    });
    req.setTimeout(15000, () => req.destroy(new Error(`timeout: ${method} ${pathname}`)));
    req.on('error', reject);
    req.end(data);
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
    const spec = parseNewSpec({ cwd: '/p', name: ' Fix login ', worktree: 'fix-login', model: 'haiku', effort: 'xhigh' });
    assert.deepEqual(claudeArgsFor('new', SESSION, spec),
      ['--session-id', SESSION, '--name', 'Fix login', '--model', 'haiku', '--effort', 'xhigh', '-w', 'fix-login']);
    assert.deepEqual(claudeArgsFor('new', SESSION, parseNewSpec({ cwd: '/p', worktree: true })), ['--session-id', SESSION, '-w']);
    assert.deepEqual(claudeArgsFor('new', SESSION, parseNewSpec({ cwd: '/p' })), ['--session-id', SESSION]);
  });
  it('forks under its own id, which claude takes only with --fork-session', () => {
    const PARENT = 'bbbbbbbb-0000-0000-0000-000000000002';
    const spec = parseNewSpec({ forkOf: PARENT });
    assert.equal(spec.cwd, null);
    assert.deepEqual(claudeArgsFor('new', SESSION, spec), ['--resume', PARENT, '--fork-session', '--session-id', SESSION]);
    assert.equal(parseNewSpec({ forkOf: 'x; rm -rf ~' }), 'session to fork');
    assert.match(parseNewSpec({ forkOf: PARENT, worktree: true }), /^worktree/);
  });
  it('names the field that fails its charset', () => {
    assert.equal(parseNewSpec({}), 'folder');
    assert.equal(parseNewSpec({ cwd: '/p', name: "x'; rm -rf ~" }), 'name');
    assert.equal(parseNewSpec({ cwd: '/p', name: '-x' }), 'name');
    assert.equal(parseNewSpec({ cwd: '/p', worktree: '../up' }), 'worktree name');
    assert.equal(parseNewSpec({ cwd: '/p', worktree: 1 }), 'worktree name');
    assert.equal(parseNewSpec({ cwd: '/p', model: 'opus; x' }), 'model');
    assert.equal(parseNewSpec({ cwd: '/p', effort: 'ultra' }), 'effort');
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

describe('edit before run', { concurrency: true }, () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';

  function service(live = [], shell = 'bash', resolveCwd = () => null, onFork) {
    const pty = fakePty();
    const t = createTerminalService({
      onFork,
      config: { enabled: true, restore: false, shell, maxSessions: 30, scrollback: 100 },
      net: { EXPOSED: false },
      pty,
      token: TOKEN,
      claudeDir: os.tmpdir(),
      which: (n) => n,
      isLiveElsewhere: () => false,
      resolveCwd,
      isAllowedFolder: () => true,
      liveSessions: () => live,
      isPidAlive: () => true,
      exitPollMs: 20,
      promptQuietMs: QUIET_MS,
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
    await wait(PAST_QUIET_MS);
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

  it('presses Enter after a paste only when asked to submit', async () => {
    const live = [];
    const { t, pty } = service(live);
    await t.startNew({ id: A, cwd: os.tmpdir(), edit: true });
    const p = pty.spawned[0];
    p.emit('prompt> ');
    live.push({ sessionId: A, pid: 4242, startedAt: Date.now() });
    await until(() => t.paste(A, 'one'));
    const before = p.written.length;
    assert.equal(t.paste(A, 'two', true), true);
    await until(() => p.written.length === before + 2);
    assert.deepEqual(p.written.slice(before), ['\x1b[200~two\x1b[201~', '\r']);
    t.shutdown();
  });

  it('takes a paste when the conversation on screen says trust', async () => {
    const live = [];
    const { t, pty } = service(live);
    await t.startNew({ id: A, cwd: os.tmpdir(), edit: true });
    const p = pty.spawned[0];
    p.emit('prompt> ');
    live.push({ sessionId: A, pid: 4242, startedAt: Date.now() });
    await until(() => t.paste(A, 'one'));
    p.emit('\r\nThe Features section sits before Trust.\r\n> ');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.paste(A, 'two'), true);
    p.emit('\r\nDo you trust the files in this folder?\r\n');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.paste(A, 'three'), false);
    t.shutdown();
  });

  it('types live dictation by backspacing only what changed', async () => {
    const live = [];
    const { t, pty } = service(live);
    await t.startNew({ id: A, cwd: os.tmpdir(), edit: true });
    const p = pty.spawned[0];
    p.emit('prompt> ');
    live.push({ sessionId: A, pid: 4242, startedAt: Date.now() });
    await until(() => t.type(A, '', 'Fix the'));
    const from = p.written.length - 1;
    assert.equal(p.written[from], 'Fix the');
    assert.equal(t.type(A, 'Fix the', 'Fix this\ntest'), true);
    assert.equal(p.written.at(-1), '\x7fis test');
    assert.equal(t.type(A, 'Fix this test', 'Fix this test', true), true);
    await until(() => p.written.at(-1) === '\r');
    assert.equal(p.written.at(-1), '\r');
    t.shutdown();
  });

  it('starts a fork in its parent session folder, not the folder the caller names', async () => {
    const PARENT = 'bbbbbbbb-0000-0000-0000-000000000002';
    const forks = [];
    const { t, pty } = service([], 'bash', (id) => (id === PARENT ? os.tmpdir() : null), (id, parent) => forks.push([id, parent]));
    const r = await t.startNew({ id: A, forkOf: PARENT, cwd: '/elsewhere' });
    assert.equal(r.cwd, os.tmpdir());
    assert.ok(pty.spawned[0].args.join(' ').includes(`--resume ${PARENT} --fork-session --session-id ${A}`));
    assert.equal(t.list()[0].forkOf, PARENT);
    assert.deepEqual(forks, [[A, PARENT]]);
    const missing = await t.startNew({ id: SESSION, forkOf: 'cccccccc-0000-0000-0000-000000000003' });
    assert.equal(missing.status, 404);
    assert.equal(forks.length, 1);
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

const QUIET_MS = 20;
const PAST_QUIET_MS = 5 * QUIET_MS;

async function startWithPrompt(id, overrides, spec) {
  const pty = fakePty();
  const t = createTerminalService({
    config: { enabled: true, restore: false, shell: 'bash', maxSessions: 30, scrollback: 100 },
    net: { EXPOSED: false },
    pty,
    token: TOKEN,
    claudeDir: os.tmpdir(),
    which: (n) => n,
    isLiveElsewhere: () => false,
    resolveCwd: () => null,
    isAllowedFolder: () => true,
    liveSessions: () => [],
    isPidAlive: () => true,
    exitPollMs: 20,
    promptQuietMs: QUIET_MS,
    ...overrides,
  });
  await t.startNew({ id, cwd: os.tmpdir(), prompt: 'do the task', ...spec });
  return { t, p: pty.spawned[0] };
}

describe('folder trust dialog', { concurrency: true }, () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const DIALOG = '\x1b[?2004hDo you trust the files in this folder?\r\n❯ 1. Yes, I trust this folder\r\n  2. No, exit\r\n';
  const INPUT_BOX = '\x1b[2J\x1b[H\x1b[?2004h> ';

  async function started() {
    let changes = 0;
    const { t, p } = await startWithPrompt(A, { onChange: () => { changes++; } });
    return { t, p, changes: () => changes };
  }

  const awaiting = (t) => t.list()[0].awaitingTrust;

  it('flags the dialog, holds the prompt, then sends it and clears the flag once the dialog is answered', async () => {
    const { t, p } = await started();
    p.emit(DIALOG);
    await until(() => awaiting(t));
    assert.equal(awaiting(t), true);
    assert.deepEqual(p.written, []);
    p.emit(INPUT_BOX);
    await until(() => p.written.length > 0);
    assert.equal(awaiting(t), false);
    assert.equal(p.written[0], '\x1b[200~do the task\x1b[201~');
    t.shutdown();
  });

  it('holds the prompt while claude restarts its screen with paste mode off after the answer', async () => {
    const { t, p } = await started();
    p.emit(DIALOG);
    await until(() => awaiting(t));
    p.emit('\x1b[2J\x1b[H\x1b[?2031l\x1b[?2004l\x1b[?1016l\r\n');
    await wait(PAST_QUIET_MS);
    assert.deepEqual(p.written, []);
    p.emit(INPUT_BOX);
    await until(() => p.written.length > 0);
    assert.equal(p.written[0], '\x1b[200~do the task\x1b[201~');
    t.shutdown();
  });

  // Recorded from a real claude by test/live-startup-dialogs.js; rerun it after a Claude Code update.
  const FIXTURES = path.join(__dirname, 'fixtures', 'startup-dialogs');
  // claude probes for OSC 7501 at start, and the terminal answers it.
  const typed = (p) => p.written.filter((w) => w !== QUERY_REPLY);
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8'));
    it(`holds the prompt through each dialog of the recorded ${fx.case} start (${fx.claudeVersion})`, async () => {
      const { t, p } = await started();
      for (const step of fx.steps) {
        p.emit(step.output);
        await wait(PAST_QUIET_MS);
        assert.deepEqual(typed(p), [], `prompt sent over the ${step.dialog} dialog`);
        assert.equal(awaiting(t), step.awaitingTrust);
        assert.equal(t.paste(A, 'x'), false);
      }
      p.emit(fx.ready);
      await until(() => typed(p).length > 0);
      assert.equal(typed(p)[0], '\x1b[200~do the task\x1b[201~');
      assert.equal(awaiting(t), false);
      t.shutdown();
    });
  }

  it('sends the prompt when only the folder or session name says trust', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'trust-'));
    const { t, p } = await startWithPrompt(A, {}, { cwd, name: 'trust-check' });
    p.emit(`\x1b[?2004h~\\${path.basename(cwd)}\r\ntrust-check\r\n> `);
    await until(() => p.written.length > 0);
    assert.equal(p.written[0], '\x1b[200~do the task\x1b[201~');
    t.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('does not flag a screen that only says trust', async () => {
    const { t, p } = await started();
    p.emit('\x1b[?2004hI trust the plan\r\n');
    await wait(PAST_QUIET_MS);
    assert.equal(awaiting(t), false);
    t.shutdown();
  });

  it('never flags the dialog text after the prompt is sent', async () => {
    const { t, p, changes } = await started();
    p.emit(INPUT_BOX);
    await until(() => p.written.length > 0);
    const before = changes();
    p.emit(DIALOG);
    await wait(PAST_QUIET_MS);
    assert.equal(awaiting(t), false);
    assert.equal(changes(), before);
    t.shutdown();
  });
});

describe('prompt submit', { concurrency: true }, () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000002';

  async function started(reg) {
    const { t, p } = await startWithPrompt(A, {
      liveSessions: () => [{ sessionId: A, pid: 7, startedAt: Date.now(), ...reg }],
      submitPollMs: 10,
    });
    p.emit('\x1b[?2004h> ');
    return { t, enters: () => p.written.filter((d) => d === '\r').length };
  }

  async function entersAfter(reg, change) {
    const { t, enters } = await started(reg);
    await until(() => enters() === 1);
    change?.();
    await wait(200);
    t.shutdown();
    return enters();
  }

  it('presses Enter again while the entry stays idle and older than the Enter, then gives up', async () => {
    assert.equal(await entersAfter({ status: 'idle', statusUpdatedAt: 1 }), 3);
  });

  it('presses Enter once when the turn starts', async () => {
    const reg = { status: 'idle', statusUpdatedAt: 1 };
    assert.equal(await entersAfter(reg, () => Object.assign(reg, { status: 'busy', statusUpdatedAt: Date.now() })), 1);
  });

  it('presses Enter once when the entry is not idle, as with a dialog in a running turn', async () => {
    assert.equal(await entersAfter({ status: 'busy', statusUpdatedAt: 1 }), 1);
  });

  it('presses Enter once when the registry has no status time', async () => {
    assert.equal(await entersAfter({ status: 'idle' }), 1);
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

  it('forces OSC 8 hyperlinks', () => {
    assert.equal(ptyEnv({ claudeDir: '/c', isDefaultDir: true }).FORCE_HYPERLINK, '1');
  });

  it('sets TERM_PROGRAM to the hub or the board, replacing an inherited one', () => {
    const saved = { hub: process.env.CLAUDE_HUB, tp: process.env.TERM_PROGRAM };
    process.env.TERM_PROGRAM = 'vscode';
    try {
      delete process.env.CLAUDE_HUB;
      assert.equal(ptyEnv({ claudeDir: '/c', isDefaultDir: true }).TERM_PROGRAM, 'claude-code-kanban');
      process.env.CLAUDE_HUB = '1';
      assert.equal(ptyEnv({ claudeDir: '/c', isDefaultDir: true }).TERM_PROGRAM, 'claude-code-hub');
    } finally {
      for (const [k, v] of [['CLAUDE_HUB', saved.hub], ['TERM_PROGRAM', saved.tp]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('names the terminal with CCK_TERMINAL_ID and drops an inherited one', () => {
    const TID = 'dddddddd-0000-0000-0000-000000000001';
    assert.equal(ptyEnv({ claudeDir: '/c', isDefaultDir: true, cckUrl: 'http://127.0.0.1:1', terminalId: TID }).CCK_TERMINAL_ID, TID);
    const saved = process.env.CCK_TERMINAL_ID;
    process.env.CCK_TERMINAL_ID = TID;
    try {
      assert.equal(ptyEnv({ claudeDir: '/c', isDefaultDir: true }).CCK_TERMINAL_ID, undefined);
    } finally {
      if (saved === undefined) delete process.env.CCK_TERMINAL_ID;
      else process.env.CCK_TERMINAL_ID = saved;
    }
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

  it("drops the parent session's effort level", () => {
    const saved = process.env.CLAUDE_EFFORT;
    process.env.CLAUDE_EFFORT = 'max';
    try {
      assert.equal(ptyEnv({ claudeDir: '/c', isDefaultDir: true }).CLAUDE_EFFORT, undefined);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_EFFORT;
      else process.env.CLAUDE_EFFORT = saved;
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
  it('keeps the system ConPTY unless the block asks for the bundled one', () => {
    assert.equal(readTerminalConfig({ argv: [], env: {} }).conptyDll, false);
    assert.equal(readTerminalConfig({ argv: [], env: { CCK_TERMINAL: '{"conptyDll":true}' } }).conptyDll, true);
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
  const missingDir = path.join(os.tmpdir(), 'cck-no-such-folder');
  it('refuses a new session in a folder that does not exist', async () => {
    const got = await session(port, { id: SESSION, mode: 'new', cwd: missingDir }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4004);
  });
  it('refuses a resume picker in a folder that does not exist', async () => {
    const got = await session(port, { id: SESSION, mode: 'pick', cwd: missingDir }, (g) => g.closeCode !== null);
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

  it('runs a shell pane in its folder and ends it with the pane', async () => {
    const origin = `http://localhost:${port}`;
    const folder = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'cck-shell-pane-')));
    const added = await api(port, 'POST', `/api/panes/${SESSION}`, { origin }, { kind: 'shell', target: folder });
    assert.equal(added.status, 200);
    const { pane } = added.json;
    assert.equal(pane.kind, 'shell');
    assert.equal(pane.cwd, folder);
    assert.notEqual(pane.target, folder);

    const got = await session(port, { id: pane.target, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    got.ws.send(JSON.stringify({ t: 'in', d: `${process.platform === 'win32' ? 'cd' : 'pwd'}\r` }));
    await waitFor(got.ws, (d, bin) => bin && (got.out += d.toString()).includes(path.basename(folder)), 'cwd');
    const [row] = (await api(port, 'GET', '/api/terminals')).json.sessions;
    assert.equal(row.pane, true);
    assert.equal(row.cwd, folder);

    const exited = waitFor(got.ws, (d, bin) => !bin && JSON.parse(d.toString()).t === 'exit', 'exit');
    const del = await api(port, 'DELETE', `/api/panes/${SESSION}/${pane.id}`, { origin });
    assert.equal(del.status, 200);
    await exited;
    assert.equal((await api(port, 'GET', '/api/terminals')).json.sessions.length, 0);
    rmSync(folder, { recursive: true, force: true });
  });

  it('runs the shell pane\'s command when the shell starts', async () => {
    const origin = `http://localhost:${port}`;
    const added = await api(port, 'POST', `/api/panes/${SESSION}`, { origin }, { kind: 'shell', target: os.tmpdir(), run: 'echo cck-run-ok' });
    assert.equal(added.status, 200);
    const { pane } = added.json;
    assert.equal(pane.run, 'echo cck-run-ok');
    const got = await session(port, { id: pane.target, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    // The typed line echoes the command too; only its output has the marker without `echo ` before it.
    await waitFor(got.ws, (d, bin) => bin && /(?<!echo )cck-run-ok/.test((got.out += d.toString())), 'run output');
    const del = await api(port, 'DELETE', `/api/panes/${SESSION}/${pane.id}`, { origin });
    assert.equal(del.status, 200);
  });

  it('refuses a shell pane command of more than one line', async () => {
    const res = await api(port, 'POST', `/api/panes/${SESSION}`, { origin: `http://localhost:${port}` }, { kind: 'shell', target: os.tmpdir(), run: 'echo a\necho b' });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'bad_run');
  });

  it('refuses a shell pane in a folder that does not exist', async () => {
    const res = await api(port, 'POST', `/api/panes/${SESSION}`, { origin: `http://localhost:${port}` }, { kind: 'shell', target: missingDir });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'bad_target');
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
        pid: 100000 + spawned.length, args, opts, env: opts?.env, written: [], emit: () => {},
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

describe('terminal restore', { concurrency: true }, () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const B = 'aaaaaaaa-0000-0000-0000-000000000002';
  const ELSEWHERE = 'aaaaaaaa-0000-0000-0000-000000000003';
  const UNKNOWN = 'aaaaaaaa-0000-0000-0000-000000000004';
  const GAP_MS = 60;
  const SAVE_MS = 20;

  function service(restore, initial, { live = [], dead = new Set(), rekeys = [] } = {}) {
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
      isAllowedFolder: () => true,
      liveSessions: () => live,
      isPidAlive: (pid) => !dead.has(pid),
      exitPollMs: SAVE_MS,
      onRekey: (from, to) => rekeys.push([from, to]),
    });
    return { t, pty, store };
  }

  it('spawns on the bundled ConPTY when asked, and falls back when it fails', { skip: process.platform !== 'win32' }, async () => {
    const pty = fakePty();
    const plain = pty.spawn;
    let fail = false;
    pty.spawn = (file, args, opts) => {
      if (fail && opts.useConptyDll) throw new Error('no conpty.dll');
      return plain(file, args, opts);
    };
    const config = { enabled: true, restore: true, shell: SHELL, maxSessions: 30, scrollback: 100, conptyDll: true };
    const t = createTerminalService({
      config, net: { EXPOSED: false }, pty, token: TOKEN, load: () => ({ sessions: [A, B] }), save: () => {},
      restoreGapMs: GAP_MS, saveDelayMs: SAVE_MS, claudeDir: os.tmpdir(), which: (n) => n, isLiveElsewhere: () => false,
      resolveCwd: () => os.tmpdir(), isAllowedFolder: () => true, liveSessions: () => [], exitPollMs: SAVE_MS,
    });
    t.restore();
    await until(() => t.list().length === 1);
    assert.equal(pty.spawned[0].opts.useConptyDll, true);
    fail = true;
    await until(() => t.list().length === 2);
    assert.equal(pty.spawned[1].opts.useConptyDll, undefined);
    t.shutdown();
  });

  it('answers the OSC 7501 query and lists what the program reports until a prompt drops it', async () => {
    const { t, pty } = service(false, null);
    const FRESH = 'aaaaaaaa-0000-0000-0000-000000000009';
    assert.equal((await t.startNew({ id: FRESH, cwd: os.tmpdir() })).id, FRESH);
    const p = pty.spawned[0];
    p.emit('\x1b]7501;?\x1b\\');
    await until(() => p.written.includes('\x1b]7501;?\x1b\\'));
    assert.equal(t.list()[0].programStatus, null);
    p.emit('\x1b]7501;state=blocked:kind=permi');
    p.emit('ssion:app=claude-code\x07');
    await until(() => t.list()[0].programStatus);
    assert.deepEqual(t.list()[0].programStatus, { state: 'blocked', kind: 'permission', app: 'claude-code' });
    p.emit('\x1b]133;A\x07');
    await until(() => !t.list()[0].programStatus);
    assert.equal(t.list()[0].programStatus, null);
    t.shutdown();
  });

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

  it('does not save a terminal started with restore off', async () => {
    const { t, store } = service(true, null);
    const FRESH = 'aaaaaaaa-0000-0000-0000-000000000005';
    assert.equal((await t.startNew({ id: UNKNOWN, cwd: os.tmpdir(), restore: false })).id, UNKNOWN);
    assert.equal((await t.startNew({ id: FRESH, cwd: os.tmpdir() })).id, FRESH);
    await until(() => store.data?.sessions?.length === 1);
    assert.deepEqual(store.data.sessions, [FRESH]);
    t.shutdown();
  });

  it('finds a resumed claude by the transcript id and marks the terminal when claude exits', async () => {
    const FRESH = 'aaaaaaaa-0000-0000-0000-000000000006';
    const live = [{ pid: 4242, sessionId: B, startedAt: Date.now() + 1000 }];
    const { t } = service(false, null, { live });
    assert.equal((await t.startNew({ id: FRESH, cwd: os.tmpdir(), resume: B })).id, FRESH);
    await until(() => t.claudePids()[FRESH] === 4242, 'claude pid');
    assert.equal(t.list()[0].claudeExited, false);
    live.length = 0;
    await until(() => t.list()[0].claudeExited, 'claude exit');
    t.shutdown();
  });

  it('follows /clear to the new session id and keeps the terminal id', async () => {
    const FRESH = 'aaaaaaaa-0000-0000-0000-000000000007';
    const live = [{ pid: 4242, sessionId: FRESH, startedAt: Date.now() + 1000 }];
    const rekeys = [];
    const { t, store } = service(true, null, { live, rekeys });
    assert.equal((await t.startNew({ id: FRESH, cwd: os.tmpdir() })).id, FRESH);
    await until(() => t.claudePids()[FRESH] === 4242);
    assert.equal(t.claudePids()[FRESH], 4242);
    const tid = t.list()[0].terminalId;
    live[0] = { ...live[0], sessionId: UNKNOWN };
    await wait(SAVE_MS * 4);
    assert.deepEqual(t.list().map((s) => s.id), [FRESH], 'no transcript yet, so the terminal waits');
    live[0] = { ...live[0], sessionId: B };
    await until(() => t.list()[0].id === B);
    assert.equal(t.list()[0].id, B);
    assert.equal(t.list()[0].terminalId, tid);
    assert.equal(t.list()[0].claudeExited, false);
    assert.deepEqual(rekeys, [[FRESH, B]]);
    await until(() => store.data?.sessions?.[0] === B);
    assert.deepEqual(store.data.sessions, [B]);
    t.shutdown();
  });

  it('refuses to resume a session running in another terminal', async () => {
    const { t, pty } = service(false, null);
    const r = await t.startNew({ cwd: os.tmpdir(), resume: ELSEWHERE });
    assert.equal(r.status, 409);
    assert.equal(pty.spawned.length, 0);
    t.shutdown();
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

  it('gives each terminal an id in its env and its list entry, and keeps it across a restore', async () => {
    const TID = 'dddddddd-0000-0000-0000-000000000001';
    const { t, pty, store } = service(true, { sessions: [A], terminalIds: { [A]: TID, [UNKNOWN]: TID } });
    t.restore();
    await until(() => t.list().length === 1);
    assert.equal(t.list()[0].terminalId, TID);
    assert.equal(pty.spawned[0].env.CCK_TERMINAL_ID, TID);

    const r = await t.startNew({ id: UNKNOWN, cwd: os.tmpdir() });
    assert.equal(r.id, UNKNOWN);
    const fresh = t.list().find((s) => s.id === UNKNOWN).terminalId;
    assert.match(fresh, /^[0-9a-f-]{36}$/);
    assert.notEqual(fresh, TID);
    assert.equal(pty.spawned[1].env.CCK_TERMINAL_ID, fresh);
    await until(() => store.data.sessions.length === 2);
    assert.deepEqual(store.data.terminalIds, { [A]: TID, [UNKNOWN]: fresh });
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
    assert.deepEqual(store.data.sessions, [B]);
    assert.equal(t.claudePids()[B], 6000);
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

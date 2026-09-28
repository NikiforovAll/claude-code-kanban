const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');

function tempConfigDir(beacon) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-cli-'));
  if (beacon) {
    fs.mkdirSync(path.join(dir, '.cck'));
    fs.writeFileSync(path.join(dir, '.cck', 'server.json'), JSON.stringify(beacon));
  }
  return dir;
}

function runCli(args, env) {
  const clean = { ...process.env };
  delete clean.PORT;
  delete clean.CLAUDE_DIR;
  delete clean.CCK_URL;
  return new Promise((resolve) => {
    execFile(process.execPath, [SERVER, ...args], { env: { ...clean, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

describe('CLI server resolution', () => {
  it('reaches the server named by the config dir beacon', async () => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      hits.push(req.url);
      res.setHeader('Content-Type', 'application/json');
      res.end('{"sticky":[],"pinned":[]}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const dir = tempConfigDir({ port: srv.address().port, pid: process.pid });
      await runCli(['session', 'pins', '--json'], { CLAUDE_CONFIG_DIR: dir });
      assert.deepEqual(hits, ['/api/session/pins']);
    } finally {
      srv.close();
    }
  });

  it('refuses a beacon whose server is dead instead of falling back to 3541', async () => {
    const hits = [];
    const srv = http.createServer((req, res) => { hits.push(req.url); res.end('[]'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const child = spawn(process.execPath, ['-e', '']);
      await new Promise((r) => child.on('exit', r));
      const dir = tempConfigDir({ port: srv.address().port, pid: child.pid });
      const { code, stderr } = await runCli(['session', 'list'], { CLAUDE_CONFIG_DIR: dir });
      assert.equal(code, 1);
      assert.match(stderr, /Cannot reach cck server for .+cck-cli-.+: its server\.json names a server that is no longer running/);
      assert.deepEqual(hits, []);
    } finally {
      srv.close();
    }
  });

  it('lets PORT win over a dead beacon', async () => {
    const dir = tempConfigDir({ port: 9, pid: 999999999 });
    const { stderr } = await runCli(['session', 'list'], { CLAUDE_CONFIG_DIR: dir, PORT: '1' });
    assert.match(stderr, /on port 1\b/);
  });

  it('uses CCK_URL before the beacon', async () => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      hits.push(req.url);
      res.setHeader('Content-Type', 'application/json');
      res.end('[]');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const dir = tempConfigDir({ port: 9, pid: 999999999 });
      const { code } = await runCli(['project', 'list', '--json'], {
        CLAUDE_CONFIG_DIR: dir,
        CCK_URL: `http://127.0.0.1:${srv.address().port}/`,
      });
      assert.equal(code, 0);
      assert.deepEqual(hits, ['/api/projects']);
    } finally {
      srv.close();
    }
  });

  it('sends dispatch start the token of the board it reaches', async () => {
    const seen = [];
    const board = () => http.createServer((req, res) => {
      seen.push({ port: req.socket.localPort, token: req.headers['x-terminal-token'] });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"dispatch":"d1","session":"s1","cwd":"."}');
    });
    const boards = [board(), board()];
    await Promise.all(boards.map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
    try {
      const [ownerPort, pinnedPort] = boards.map((s) => s.address().port);
      const dir = tempConfigDir({ port: ownerPort, pid: process.pid });
      const tokens = path.join(dir, '.cck', 'terminal-tokens');
      fs.mkdirSync(tokens);
      for (const [port, token] of [[ownerPort, 'owner-token'], [pinnedPort, 'pinned-token']]) {
        fs.writeFileSync(path.join(tokens, `${port}.json`), JSON.stringify({ pid: process.pid, token }));
      }
      const start = ['dispatch', 'start', '--spec', 'x', '--cwd', dir];
      assert.equal((await runCli(start, { CLAUDE_CONFIG_DIR: dir })).code, 0);
      assert.equal((await runCli(start, { CLAUDE_CONFIG_DIR: dir, CCK_URL: `http://127.0.0.1:${pinnedPort}` })).code, 0);
      assert.deepEqual(seen, [{ port: ownerPort, token: 'owner-token' }, { port: pinnedPort, token: 'pinned-token' }]);
    } finally {
      for (const s of boards) s.close();
    }
  });

  it('names the config dir when the server is unreachable', async () => {
    const dir = tempConfigDir();
    const { code, stderr } = await runCli(['session', 'list'], { CLAUDE_CONFIG_DIR: dir, PORT: '1' });
    assert.notEqual(code, 0);
    assert.match(stderr, /Cannot reach cck server for .+cck-cli-.+ on port 1\b/);
  });
});

describe('CLI help', () => {
  const env = () => ({ CLAUDE_CONFIG_DIR: tempConfigDir(), PORT: '1' });

  it('lists commands at the top, verbs one level down, flags at the leaf', async () => {
    const top = await runCli(['--help'], env());
    assert.equal(top.code, 0);
    assert.match(top.stdout, /session\s+.+\(list, search, open/);
    assert.doesNotMatch(top.stdout, /--project <name>/);
    assert.match(top.stdout, /help <command> <subcommand>/);
    const noun = await runCli(['help', 'task'], env());
    assert.match(noun.stdout, /Subcommands:\n\s+list/);
    const leaf = await runCli(['help', 'session', 'search'], env());
    assert.equal(leaf.code, 0);
    assert.match(leaf.stdout, /Usage: claude-code-kanban session search <text>/);
    assert.match(leaf.stdout, /Examples:\n\s+claude-code-kanban session search/);
    const flag = await runCli(['task', 'list', '--help'], env());
    assert.match(flag.stdout, /--status <s>/);
  });

  it('exits non-zero on a noun without a verb, but not with --help', async () => {
    assert.equal((await runCli(['session'], env())).code, 1);
    assert.equal((await runCli(['session', '--help'], env())).code, 0);
  });
});

describe('CLI argument parsing', () => {
  const env = () => ({ CLAUDE_CONFIG_DIR: tempConfigDir(), PORT: '1' });
  const usage = (cmd) => new RegExp(`Usage: claude-code-kanban ${cmd}`);

  for (const [args, cmd] of [
    [['session', 'search'], 'session search'],
    [['session', 'plan'], 'session plan'],
    [['session', 'agents'], 'session agents'],
    [['task', 'list'], 'task list'],
  ]) {
    it(`prints leaf help for ${args.join(' ')} without arguments`, async () => {
      const { code, stdout } = await runCli(args, env());
      assert.equal(code, 1);
      assert.match(stdout, usage(cmd));
    });
  }

  it('rejects search text shorter than 3 characters', async () => {
    const { code, stderr } = await runCli(['session', 'search', 'ab'], env());
    assert.equal(code, 1);
    assert.match(stderr, /at least 3 characters[\s\S]*help session search/);
  });

  it('rejects a bad search --limit', async () => {
    const { code, stderr } = await runCli(['session', 'search', 'login', '--limit', '0'], env());
    assert.equal(code, 1);
    assert.match(stderr, /Invalid --limit value: 0/);
  });

  it('takes one task source only', async () => {
    const { code, stderr } = await runCli(['task', 'list', 'abc', '--all'], env());
    assert.equal(code, 1);
    assert.match(stderr, /one of <session>, --project or --all[\s\S]*help task list/);
  });

  it('wants a value for --status', async () => {
    const { code, stderr } = await runCli(['task', 'list', '--all', '--status'], env());
    assert.equal(code, 1);
    assert.match(stderr, /--status needs a value/);
  });

  it('reaches the server for task list --all and project list', async () => {
    for (const args of [['task', 'list', '--all'], ['project', 'list']]) {
      const { code, stderr } = await runCli(args, env());
      assert.equal(code, 1);
      assert.match(stderr, /Cannot reach cck server/);
    }
  });

  it('link-doc needs a session for --list', async () => {
    const { code, stderr } = await runCli(['link-doc', '--list'], { ...env(), PREVIEW_SESSION: '' });
    assert.equal(code, 1);
    assert.match(stderr, /--session is required[\s\S]*help link-doc/);
  });
});

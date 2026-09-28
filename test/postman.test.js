const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const POSTMAN = path.join(__dirname, '..', 'plugin', 'plugins', 'claude-code-kanban', 'scripts', 'postman.js');
const SESSION = '11111111-2222-3333-4444-555555555555';

function board(line) {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ events: req.url.startsWith(`/api/sessions/${SESSION}/events`) ? [line] : [] }));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

function firstLine(env) {
  const child = spawn(process.execPath, [POSTMAN], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('no line from postman')); }, 5000);
    child.stdout.on('data', (d) => {
      out += d;
      const nl = out.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      child.kill();
      resolve(out.slice(0, nl).trim());
    });
  });
}

describe('postman board lookup', () => {
  let dir;
  let owner;
  let pinned;
  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cck-postman-'));
    owner = await board('from-server-json');
    pinned = await board('from-cck-url');
    mkdirSync(path.join(dir, '.cck'));
    writeFileSync(path.join(dir, '.cck', 'server.json'), JSON.stringify({ port: owner.port, pid: process.pid }));
  });
  after(() => {
    owner.srv.close();
    pinned.srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = () => ({ CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CONFIG_DIR: dir, CCK_URL: '' });

  it('polls the board named by server.json without CCK_URL', async () => {
    assert.equal(await firstLine(base()), 'from-server-json');
  });

  it('polls the CCK_URL board when another board owns server.json', async () => {
    assert.equal(await firstLine({ ...base(), CCK_URL: `http://127.0.0.1:${pinned.port}/` }), 'from-cck-url');
  });
});

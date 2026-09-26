const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
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

  it('names the config dir when the server is unreachable', async () => {
    const dir = tempConfigDir();
    const { code, stderr } = await runCli(['session', 'list'], { CLAUDE_CONFIG_DIR: dir, PORT: '1' });
    assert.notEqual(code, 0);
    assert.match(stderr, /Cannot reach cck server for .+cck-cli-.+ on port 1\b/);
  });
});

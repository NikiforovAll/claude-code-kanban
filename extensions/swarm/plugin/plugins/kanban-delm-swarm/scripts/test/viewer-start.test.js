const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const VIEWER = path.join(__dirname, '..', 'viewer.mjs');

const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name)).replaceAll('\\', '/');

describe('swarm viewer start', () => {
  let m;
  let config;
  let hubDir;
  let hub;
  let reply;
  before(async () => {
    m = await import(pathToFileURL(VIEWER).href);
    config = tempDir('cck-swarm-viewer-');
    hubDir = tempDir('cck-swarm-hub-');
    fs.writeFileSync(`${hubDir}/token`, 'test-token\n');
    hub = http.createServer((req, res) => {
      const ok = req.url === '/api/config' && req.headers.cookie === 'hub_token=test-token';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? reply : {}));
    });
    await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
  });
  after(() => {
    hub.close();
    const record = `${config}/.cck/swarm-viewer.json`;
    if (fs.existsSync(record)) {
      try {
        process.kill(JSON.parse(fs.readFileSync(record, 'utf8')).pid);
      } catch {}
    }
  });

  const env = () => ({ ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_HUB_DIR: hubDir });

  it('starts one viewer for parallel callers and reuses it', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => m.viewer({ swarm: 'swarm-a-abc', env: env() })));
    assert.equal(new Set(results.map((r) => r.url)).size, 1);
    assert.match(results[0].url, /^http:\/\/localhost:\d+\/\?swarm=swarm-a-abc$/);
    const record = JSON.parse(fs.readFileSync(`${config}/.cck/swarm-viewer.json`, 'utf8'));
    assert.equal(results[0].url, `http://localhost:${record.port}/?swarm=swarm-a-abc`);
    assert.equal((await m.viewer({ env: env() })).source, 'running');
  });

  it('reuses the hub swarm app when the hub lists one', async () => {
    fs.writeFileSync(`${hubDir}/hub.json`, JSON.stringify({ pid: process.pid, port: hub.address().port }));
    reply = { apps: { swarm: { url: 'http://localhost:4999' } } };
    assert.deepEqual(await m.viewer({ swarm: 'swarm-a-abc', env: env() }), {
      url: 'http://localhost:4999/?swarm=swarm-a-abc',
      source: 'hub',
    });
    reply = { apps: {} };
    assert.equal((await m.viewer({ env: env() })).source, 'running');
  });
});

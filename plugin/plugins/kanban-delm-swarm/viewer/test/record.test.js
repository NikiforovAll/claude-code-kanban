'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { configDir } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');
const recordOf = (config) => path.join(config, '.cck', 'swarm-viewer.json');
const readRecord = (config) => JSON.parse(fs.readFileSync(recordOf(config), 'utf8'));

const children = [];
const configs = [];

function newConfig() {
  const c = configDir();
  configs.push(c);
  return c;
}

function run(config, args = [], env = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HUB_|CLAUDE_HUB|PORT$|HOST$|ALLOWED_HOSTS$)/.test(k)));
  const child = spawn(process.execPath, [SERVER, ...args], { env: { ...inherited, CLAUDE_CONFIG_DIR: config, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  const exited = once(child, 'exit').then(([code]) => code);
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      const m = /Swarm running at http:\/\/localhost:(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    exited.then((code) => reject(new Error(`server exited with ${code}: ${out}`)));
  });
  return { child, ready, exited, output: () => out };
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { host: `localhost:${port}` }, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

const deadline = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms));

afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode == null && c.signalCode == null) {
      c.kill();
      await once(c, 'exit');
    }
  }
  for (const c of configs.splice(0)) fs.rmSync(c, { recursive: true, force: true });
});

describe('the shared viewer record', () => {
  it('writes {pid, port, configDir} on listen and names the config dir on /api/health', async () => {
    const config = newConfig();
    const a = run(config);
    const port = await a.ready;
    assert.deepEqual(readRecord(config), { pid: a.child.pid, port, configDir: config });
    const health = await get(port, '/api/health');
    assert.deepEqual(health, { ok: true, pid: a.child.pid, port, configDir: config, pinned: false });
  });

  it('prints the live viewer and exits 0 without listening when one already runs for the config dir', async () => {
    const config = newConfig();
    const port = await run(config).ready;
    const b = run(config);
    assert.equal(await b.ready, port);
    assert.equal(await b.exited, 0);
    assert.doesNotMatch(b.output(), /swarms under/);
    assert.equal(readRecord(config).port, port);
  });

  it('leaves one viewer when two start together for the same config dir', async () => {
    const config = newConfig();
    const runs = [run(config), run(config), run(config)];
    const ports = await Promise.all(runs.map((r) => r.ready));
    assert.equal(new Set(ports).size, 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(runs.filter((r) => r.child.exitCode == null).length, 1);
    assert.equal(readRecord(config).port, ports[0]);
  });

  it('replaces a record whose viewer is gone', async () => {
    const config = newConfig();
    fs.mkdirSync(path.dirname(recordOf(config)), { recursive: true });
    fs.writeFileSync(recordOf(config), JSON.stringify({ pid: 2 ** 22 + 7, port: 1, configDir: config }));
    const a = run(config);
    const port = await a.ready;
    assert.deepEqual(readRecord(config), { pid: a.child.pid, port, configDir: config });
  });

  it('does not reuse a live viewer of another config dir', async () => {
    const other = newConfig();
    const config = newConfig();
    const a = run(other);
    const otherPort = await a.ready;
    fs.mkdirSync(path.dirname(recordOf(config)), { recursive: true });
    fs.writeFileSync(recordOf(config), JSON.stringify({ pid: a.child.pid, port: otherPort, configDir: other }));
    const b = run(config);
    const port = await b.ready;
    assert.notEqual(port, otherPort);
    assert.equal(readRecord(config).pid, b.child.pid);
  });

  it('writes no record under the hub or for a pinned folder', async () => {
    const config = newConfig();
    await run(config, [], { CLAUDE_HUB: '1' }).ready;
    const pinned = path.join(config, 'one');
    fs.mkdirSync(pinned);
    const p = run(config, ['--swarm', pinned]);
    assert.equal((await get(await p.ready, '/api/health')).pinned, true);
    assert.equal(fs.existsSync(recordOf(config)), false);
  });
});

describe('--idle-exit', () => {
  it('exits 0 after the idle time with no request, and removes its own record', async () => {
    const config = newConfig();
    const a = run(config, ['--idle-exit', '0.01']);
    await a.ready;
    assert.equal(fs.existsSync(recordOf(config)), true);
    assert.equal(await Promise.race([a.exited, deadline(5000)]), 0);
    assert.match(a.output(), /Swarm exits: no request/);
    assert.equal(fs.existsSync(recordOf(config)), false);
  });

  it('stays up while a stream is open, and exits once it closes', async () => {
    const config = newConfig();
    const a = run(config, ['--idle-exit', '0.01']);
    const port = await a.ready;
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { host: `localhost:${port}` }, agent: false });
    req.on('error', () => {});
    await once(req, 'response');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(a.child.exitCode, null);
    req.destroy();
    assert.equal(await Promise.race([a.exited, deadline(5000)]), 0);
  });

  it('is off by default', async () => {
    const config = newConfig();
    const a = run(config);
    await a.ready;
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(a.child.exitCode, null);
  });
});

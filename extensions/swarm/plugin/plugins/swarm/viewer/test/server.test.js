'use strict';

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { configDir, buildSwarm, store, registry } = require('./helpers');
const { CLIENT } = require('./fixture/hub-sdk-server');

const ROOT = path.join(__dirname, '..');
const STUB = fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'claude-hub-sdk.js'), 'utf8');
const FAKE_SDK = path.join(__dirname, 'fixture', 'hub-sdk-server.js');
// The hub's own server SDK, when the viewer sits in the claude-code-hub repo.
const HUB_SDK = path.resolve(ROOT, '..', '..', '..', '..', '..', 'packages', 'claude-hub-sdk', 'src', 'server.js');
const ENDED = 'swarm-add-csv-export-to-the-a3f9c2';
const RUNNING = 'swarm-running-a3f9c2';

// The test may itself run under the hub or cck, so their variables are dropped.
function start(config, env = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HUB_|CLAUDE_HUB|PORT$|HOST$|ALLOWED_HOSTS$)/.test(k)));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...inherited, CLAUDE_CONFIG_DIR: config, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /Swarm running at http:\/\/localhost:(\d+)/.exec(out);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('exit', (code) => reject(new Error(`server exited with ${code}: ${out}`)));
  });
}

async function stop(server) {
  if (!server || server.child.exitCode != null) return;
  server.child.kill();
  await once(server.child, 'exit');
}

function request(port, p, { method = 'GET', host = `localhost:${port}`, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = origin ? { host, origin } : { host };
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function json(port, p) {
  const r = await request(port, p);
  return { status: r.status, body: JSON.parse(r.body) };
}

function stream(port, p) {
  const frames = [];
  let waiters = [];
  const req = http.get({ host: '127.0.0.1', port, path: p, headers: { host: `localhost:${port}` } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        frames.push({ event: /^event: (.*)$/m.exec(raw)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(raw)[1]) });
        for (const w of waiters) w();
      }
    });
  });
  req.on('error', () => {});
  const next = (match, ms = 8000) =>
    new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        waiters = waiters.filter((w) => w !== check);
      };
      const check = () => {
        const f = frames.find(match);
        if (!f) return;
        done();
        resolve(f);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`no matching frame in ${ms} ms; got ${frames.map((f) => f.event).join(', ')}`));
      }, ms);
      waiters.push(check);
      check();
    });
  return { next, close: () => req.destroy() };
}

describe('viewer server, run alone', () => {
  let config;
  let server;
  let port;

  before(async () => {
    config = configDir();
    await buildSwarm(config, ENDED);
    await buildSwarm(config, RUNNING, { running: true });
    server = await start(config);
    port = server.port;
  });

  after(async () => {
    await stop(server);
    fs.rmSync(config, { recursive: true, force: true });
  });

  it('listens on a free port when PORT is 0 and prints the ready line with it', () => {
    assert.ok(port > 0);
  });

  it('lists the swarms under the config dir, running first, and selects the newest running one', async () => {
    const { body } = await json(port, '/api/swarms');
    assert.equal(body.pinned, false);
    assert.equal(path.resolve(body.root), path.resolve(config, '.cck', 'swarm'));
    assert.deepEqual(body.swarms.map((s) => [s.id, s.state]), [
      [RUNNING, 'running'],
      [ENDED, 'ended'],
    ]);
    assert.equal(body.selected, RUNNING);
  });

  it('serves the selected swarm with no id, and any swarm by id', async () => {
    const running = (await json(port, '/api/swarm')).body;
    assert.equal(running.swarm.listId, RUNNING);
    assert.equal(running.swarm.delivery, null);
    const { body } = await json(port, `/api/swarm?swarm=${ENDED}`);
    assert.equal(body.swarm.listId, ENDED);
    assert.equal(body.swarm.outcome.outcome, 'complete');
    assert.deepEqual([body.swarm.delivery.delivered, body.swarm.delivery.changed.length, body.swarm.delivery.worker], [true, 3, 'w1-a3f9c2']);
    assert.equal(body.progress.total, 9);
  });

  it('answers 404 for a swarm that does not exist or is not a plain folder name', async () => {
    for (const id of ['nope', '..', '.', '..%2F..', 'a%2Fb']) {
      for (const route of ['/api/swarm', '/api/log', '/api/diff', '/api/request']) {
        const r = await json(port, `${route}?swarm=${id}`);
        assert.equal(r.status, 404, `${route} ${id}`);
        assert.equal(r.body.error, 'no such swarm');
      }
    }
  });

  it('serves the log as rows, all or after a sequence', async () => {
    const all = (await json(port, `/api/log?swarm=${ENDED}`)).body;
    assert.equal(all.length, 73);
    assert.deepEqual(Object.keys(all[0]).sort(), ['group', 'kind', 'payload', 'revision', 'seq', 't', 'text', 'who']);
    assert.deepEqual([all[0].kind, all[0].who, all[0].payload.revision], ['request', 'supervisor', 1]);
    const tail = (await json(port, `/api/log?swarm=${ENDED}&since=70`)).body;
    assert.deepEqual(tail.map((r) => [r.seq, r.kind]), [
      [71, 'task_finish'],
      [72, 'outcome'],
      [73, 'end'],
    ]);
  });

  it('serves the spec and every revision in full, which the model leaves out', async () => {
    const { status, body } = await json(port, `/api/request?swarm=${ENDED}`);
    assert.equal(status, 200);
    assert.deepEqual(body.revisions.map((r) => Object.keys(r)), [['revision', 'text'], ['revision', 'text']]);
    assert.deepEqual(body.revisions.map((r) => r.revision), [1, 2]);
    assert.match(body.revisions[0].text, /^Add CSV export to the logview CLI/);
    assert.equal(body.revisions[1].text, 'Also measure the export on a 1M-line file and keep the bench script.');
    const model = (await json(port, `/api/swarm?swarm=${ENDED}`)).body;
    assert.deepEqual(model.revisions.map((r) => r.seq), [1, 33]);
    assert.doesNotMatch(JSON.stringify(model.revisions), /1M-line file/);
  });

  it('serves a published file as a diff against its base', async () => {
    const m = (await json(port, `/api/swarm?swarm=${ENDED}`)).body;
    const pub = m.publications.find((p) => p.files.some((f) => f.path === 'src/csv.js'));
    const r = await json(port, `/api/diff?swarm=${ENDED}&publication=${pub.id}&path=src/csv.js`);
    assert.equal(r.status, 200);
    assert.equal(r.body.change, 'added');
    assert.match(r.body.diff, /^\+\+\+ b\/src\/csv\.js$/m);
    assert.equal((await json(port, `/api/diff?swarm=${ENDED}&publication=9999&path=x`)).status, 400);
  });

  it('serves the page and the SDK stub, and nothing outside public', async () => {
    const page = await request(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.equal((await request(port, '/vendor/claude-hub-sdk.js')).body, STUB);
    assert.equal((await request(port, '/hub-config')).status, 404);
    assert.equal((await request(port, '/..%2Fserver.js')).status, 404);
    assert.equal((await request(port, '/%E0%A4%A')).status, 400);
  });

  it('refuses a foreign Host header and any method but GET and HEAD', async () => {
    const foreign = await request(port, '/api/swarms', { host: 'evil.example' });
    assert.equal(foreign.status, 403);
    assert.equal((await request(port, '/api/swarms', { method: 'POST' })).status, 405);
    assert.equal((await request(port, '/api/swarms', { host: `127.0.0.1:${port}` })).status, 200);
  });

  it('streams a new event in a running swarm without a reload', async () => {
    const s = stream(port, `/api/stream?swarm=${RUNNING}`);
    try {
      const first = await s.next((f) => f.event === 'swarm');
      const seq = first.data.swarm.seq;
      const dir = path.join(config, '.cck', 'swarm', RUNNING);
      const reg = registry(dir);
      const w2 = { id: reg.workers[1].sessionId, name: reg.workers[1].name };
      const { main } = await store();
      const r = main('status', { dir, parent: reg.parent, roster: reg.workers, actor: w2, idempotency_key: 'stream-test', summary: 'probe from the test' });
      assert.equal(r.ok, true, r.error);
      const pushed = await s.next((f) => f.event === 'swarm' && f.data.swarm.seq > seq);
      assert.equal(pushed.data.swarm.seq, seq + 1);
      const rows = (await json(port, `/api/log?swarm=${RUNNING}&since=${seq}`)).body;
      assert.deepEqual(rows.map((x) => x.text), ['working: probe from the test']);
    } finally {
      s.close();
    }
  });

  it('ends the stream with a missing frame for a swarm that does not exist', async () => {
    const s = stream(port, '/api/stream?swarm=nope');
    try {
      const f = await s.next(() => true);
      assert.deepEqual(f, { event: 'missing', data: 'No swarm named nope.' });
    } finally {
      s.close();
    }
  });
});

describe('viewer server, deleting a swarm run', () => {
  let config;
  let server;
  let port;
  let log;
  let live;
  // The hub forwards Host with its public port and rewrites Origin to the viewer's own port.
  const del = (id, origin = `http://localhost:${port}`, host = 'localhost:3540') => request(port, `/api/swarms/delete?swarm=${id}`, { method: 'POST', origin, host });

  before(async () => {
    config = configDir();
    log = path.join(config, 'cck-calls.log');
    await buildSwarm(config, ENDED);
    await buildSwarm(config, RUNNING, { running: true });
    live = registry(path.join(config, '.cck', 'swarm', RUNNING)).workers[0];
    server = await start(config, { CCK_CLI: path.join(__dirname, 'fixture', 'cck-stub.js'), CCK_STUB_LOG: log, CCK_STUB_LIVE: live.sessionId });
    port = server.port;
  });

  after(async () => {
    await stop(server);
    fs.rmSync(config, { recursive: true, force: true });
  });

  it('describes each run for the run list: outcome, end time and worker names', async () => {
    const { body } = await json(port, '/api/swarms');
    const ended = body.swarms.find((s) => s.id === ENDED);
    const running = body.swarms.find((s) => s.id === RUNNING);
    assert.equal(ended.outcome, 'complete');
    assert.ok(Date.parse(ended.endedAt) >= Date.parse(ended.startedAt));
    assert.deepEqual(ended.workers, ['w1-a3f9c2', 'w2-a3f9c2', 'w3-a3f9c2']);
    assert.deepEqual([running.outcome, running.endedAt], [null, null]);
  });

  it('refuses a delete with no Origin, a foreign one or a loopback page on another port', async () => {
    assert.equal((await del(ENDED, null)).status, 403);
    assert.equal((await del(ENDED, 'http://evil.example')).status, 403);
    assert.equal((await del(ENDED, `http://localhost:${port + 1}`, `localhost:${port + 1}`)).status, 403);
    assert.ok(fs.existsSync(path.join(config, '.cck', 'swarm', ENDED)));
  });

  it('answers 404 for a swarm that does not exist', async () => {
    assert.equal((await del('swarm-nope')).status, 404);
    assert.equal((await del('..')).status, 404);
  });

  it('refuses a run with a worker that still runs', async () => {
    const r = await del(RUNNING);
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.body).error, new RegExp(`^${live.name} still running`));
    assert.ok(fs.existsSync(path.join(config, '.cck', 'swarm', RUNNING)));
  });

  it('deletes an ended run, drops it from the list and ends its stream with a missing frame', async () => {
    const s = stream(port, `/api/stream?swarm=${ENDED}`);
    try {
      await s.next((f) => f.event === 'swarm');
      const r = await del(ENDED);
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(JSON.parse(r.body), { listId: ENDED, removed: [`the group logview/${ENDED}`, 'the swarm folder'] });
      assert.deepEqual((await s.next((f) => f.event === 'missing')).data, `Swarm ${ENDED} was deleted.`);
    } finally {
      s.close();
    }
    assert.equal(fs.existsSync(path.join(config, '.cck', 'swarm', ENDED)), false);
    assert.deepEqual((await json(port, '/api/swarms')).body.swarms.map((x) => x.id), [RUNNING]);
    assert.match(fs.readFileSync(log, 'utf8'), new RegExp(`^group rm logview/${ENDED} --json$`, 'm'));
  });
});

const SDKS = [['a stand-in hub SDK', FAKE_SDK, (body) => body === CLIENT]];
if (fs.existsSync(HUB_SDK)) SDKS.push(["the hub's own SDK", HUB_SDK, (body) => body !== STUB && /hub/i.test(body)]);

for (const [name, sdk, isClient] of SDKS) {
  describe(`viewer server under the hub, with ${name}`, () => {
    let config;
    let server;

    before(async () => {
      config = configDir();
      await buildSwarm(config, ENDED);
      server = await start(config, { HUB_SDK_SERVER: sdk, CLAUDE_HUB: '1', HUB_URL: 'http://localhost:3540' });
    });

    after(async () => {
      await stop(server);
      fs.rmSync(config, { recursive: true, force: true });
    });

    it('serves /hub-config from the SDK', async () => {
      assert.deepEqual((await json(server.port, '/hub-config')).body, { enabled: true, url: 'http://localhost:3540' });
    });

    it("serves the hub's client in place of the stub in public/vendor", async () => {
      const r = await request(server.port, '/vendor/claude-hub-sdk.js');
      assert.equal(r.status, 200);
      assert.match(r.type, /javascript/);
      assert.ok(isClient(r.body));
    });

    it('answers hub:ping with hub:pong over IPC', async () => {
      const pong = new Promise((resolve) => server.child.on('message', (m) => m?.type === 'hub:pong' && resolve(m)));
      server.child.send({ type: 'hub:ping', id: 7 });
      assert.deepEqual(await pong, { type: 'hub:pong', id: 7 });
    });

    it('keeps the app routes and the Host check', async () => {
      assert.equal((await json(server.port, '/api/swarms')).body.selected, ENDED);
      assert.equal((await request(server.port, '/hub-config', { host: 'evil.example' })).status, 403);
    });
  });
}

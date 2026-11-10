'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createViewers } = require('../lib/viewers');
const { createHistory } = require('../lib/history');

// A stand-in for `scratch ui --json`: an HTTP server that answers health, a page and an event stream.
async function fakeViewer(dir) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__scratch/health')) return res.end(JSON.stringify({ pid: 42, pads: [dir] }));
    if (req.url.startsWith('/events')) return res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head></head><body>pad</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

function fakeSpawn(servers) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.unref = () => {};
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    const { port } = servers[0].address();
    setImmediate(() => child.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}/?t=x`, pid: 42 })}\n`));
    servers.children.push(child);
    return child;
  };
}

test('a viewer sits behind a proxy that injects the bridge, and stops once idle with no stream open', async (t) => {
  const dir = 'C:/pads/one';
  const servers = [await fakeViewer(dir)];
  servers.children = [];
  t.after(() => {
    servers[0].closeAllConnections();
    servers[0].close();
  });
  const viewers = createViewers({
    resolveBin: () => 'scratch',
    spawn: fakeSpawn(servers),
    inject: (html) => html.replace('</head>', '<script>bridge</script></head>'),
    idleMs: 50,
  });
  t.after(() => viewers.stopAll());

  const url = await viewers.serve(dir);
  assert.notStrictEqual(new URL(url).port, String(servers[0].address().port));
  assert.match(await (await fetch(url)).text(), /<script>bridge<\/script><\/head>/);
  assert.strictEqual(await viewers.serve(dir), url, 'a healthy viewer is reused');

  const stream = new AbortController();
  const events = await fetch(new URL('/events?t=x', url), { signal: stream.signal });
  assert.strictEqual(events.status, 200);
  await new Promise((r) => setTimeout(r, 80));
  viewers.sweep();
  assert.ok(viewers.running(dir), 'an open stream keeps the viewer');

  stream.abort();
  await new Promise((r) => setTimeout(r, 80));
  viewers.sweep();
  assert.ok(!viewers.running(dir), 'idle with no stream stops it');
  assert.ok(servers.children[0].killed);
});

test('the history keeps one row per pad, newest first, grouped by project with Other last', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pads-')), 'history.json');
  const h = createHistory(file, 3);
  h.add({ dir: 'C:/a/one', project: null });
  h.add({ dir: 'C:/p/two', project: 'C:/p' });
  h.add({ dir: 'c:\\a\\ONE', project: 'C:/a' });
  h.add({ dir: 'C:/p/three', project: 'C:/p' });
  h.add({ dir: 'C:/q/four', project: 'C:/q' });
  const again = createHistory(file, 3);
  assert.deepStrictEqual(
    again.all().map((p) => p.dir),
    ['C:/q/four', 'C:/p/three', 'c:\\a\\ONE'],
  );
  assert.deepStrictEqual(
    again.groups().map((g) => g.label),
    ['q', 'p', 'a'],
  );
  h.add({ dir: 'C:/z/five' });
  assert.strictEqual(h.groups().at(-1).label, 'Other');
});

test('a pad opened again keeps the project it had', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pads-')), 'history.json');
  const h = createHistory(file);
  h.add({ dir: 'C:/p/one', project: 'C:/p', session: 's' });
  h.add({ dir: 'C:/p/one' });
  assert.deepStrictEqual(
    h.all().map((p) => [p.project, p.session]),
    [['C:/p', 's']],
  );
});

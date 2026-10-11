#!/usr/bin/env node
'use strict';

// Ships inside the plugin, and a plugin install never runs npm install, so only node: modules.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseExport, nameMap, logRow } = require('./lib/events');
const { buildModel } = require('./lib/model');
const { configDir, swarmRoot, listSwarms, describe, readRegistry, readDelivery, ID_RE } = require('./lib/swarms');
const { recordFile, liveRecord, claimRecord, removeRecord } = require('./lib/record');
const manifest = require('./hub-app.json');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(arg('port') ?? process.env.PORT ?? manifest.run.defaultPort);
const PINNED = arg('swarm') ? path.resolve(arg('swarm')) : null;
const STORE = path.resolve(arg('store') ?? path.join(__dirname, '..', 'scripts', 'store.mjs'));
const PUBLIC = path.join(__dirname, 'public');
const CONFIG = path.resolve(configDir());
// The hub's app and a viewer pinned to one folder are not the config dir's shared viewer.
const SHARED = !PINNED && process.env.CLAUDE_HUB !== '1';
const IDLE_MS = Number(arg('idle-exit') ?? 0) * 60_000;
const POLL_MS = 1000;
const RUNNING_RESEND_MS = 15_000;
const ALLOWED = new Set(
  ['localhost', '127.0.0.1', '[::1]', HOST, ...(process.env.ALLOWED_HOSTS || '').split(',')]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

// The hub's server SDK calls app.get(path, handler) and answers with res.type().send() or res.json().
function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.type = (t) => {
    res.setHeader('Content-Type', TYPES[`.${t}`] ?? t);
    return res;
  };
  res.send = (body) => {
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(body);
  };
  res.json = (data) => {
    res.setHeader('Content-Type', TYPES['.json']);
    res.end(JSON.stringify(data));
  };
  return res;
}

const routes = new Map();
const app = { get: (p, handler) => routes.set(p, handler) };

if (process.env.HUB_SDK_SERVER) require(process.env.HUB_SDK_SERVER).mount(app);

let store = null;
const storeReady = () => (store ??= import(pathToFileURL(STORE).href));

// A pinned folder ignores the id. Otherwise the id must name a folder under the root, and no id
// means the first listed swarm, the newest running one. `missing` tells a wrong id from no swarms.
function resolveSwarm(id) {
  if (PINNED) return { dir: PINNED };
  const root = swarmRoot();
  if (id) return ID_RE.test(id) && fs.existsSync(path.join(root, id)) ? { dir: path.join(root, id) } : { missing: true };
  const first = listSwarms(root)[0];
  return { dir: first ? path.join(root, first.id) : null };
}

const stats = { exports: 0, exportMs: 0, lastExportMs: 0, polls: 0 };
const watched = new Map();

function entry(dir) {
  if (!watched.has(dir)) watched.set(dir, { dir, key: null, store: null, sequence: 0, events: [], log: [], running: null, model: null, clients: new Set(), timer: null, lastSent: 0, loading: null });
  return watched.get(dir);
}

async function exportSince(dir, since) {
  const { main } = await storeReady();
  const t0 = performance.now();
  const r = main('export', { dir, since });
  const took = performance.now() - t0;
  stats.exports++;
  stats.exportMs += took;
  stats.lastExportMs = Math.round(took * 10) / 10;
  if (!r.ok) throw new Error(r.error);
  return { ...parseExport(r), raw: r.events ?? [] };
}

function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

const fileKey = (dir) =>
  ['swarm.db', 'swarm.db-wal', 'swarm.json'].map((f) => {
    const s = stat(path.join(dir, f));
    return s ? `${s.mtimeMs}:${s.size}` : '-';
  }).join('|');

// A swarm.db made again in the same folder is a new log, whatever its sequence.
const storeId = (dir) => {
  const s = stat(path.join(dir, 'swarm.db'));
  return s ? `${s.ino}:${s.birthtimeMs}` : null;
};

function registryOf(dir) {
  const r = readRegistry(dir) ?? {};
  return { listId: path.basename(dir), ...r, delivery: r.state === 'ended' ? readDelivery(dir) : null };
}

// Only the events after the last export are read. Callers that arrive while a load runs share it,
// so the same events are never appended twice.
function load(dir) {
  const w = entry(dir);
  w.loading ??= refresh(w).finally(() => {
    w.loading = null;
  });
  return w.loading;
}

async function refresh(w) {
  const key = fileKey(w.dir);
  if (key === w.key && w.model) return w;
  const id = storeId(w.dir);
  if (id !== w.store) Object.assign(w, { store: id, sequence: 0, events: [], log: [] });
  const next = await exportSince(w.dir, w.sequence);
  const registry = registryOf(w.dir);
  w.events.push(...next.events);
  const names = nameMap(w.events, registry);
  w.log.push(...next.raw.map((e) => logRow(e, names)));
  Object.assign(w, { key, sequence: next.sequence, running: next.running, model: buildModel(w.events, registry, Date.now(), next.running) });
  return w;
}

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// A running swarm's health depends on the clock, so its model is rebuilt now and then with no new events.
async function push(w) {
  stats.polls++;
  const before = w.key;
  await load(w.dir);
  const changed = w.key !== before;
  const stale = w.model.swarm.state === 'running' && Date.now() - w.lastSent >= RUNNING_RESEND_MS;
  if (!changed && !stale) return;
  if (!changed) w.model = buildModel(w.events, registryOf(w.dir), Date.now(), w.running);
  w.lastSent = Date.now();
  const data = frame('swarm', w.model);
  for (const res of w.clients) res.write(data);
}

// The poll stops with the last client, and the swarm's events are dropped with it.
function watch(w) {
  if (w.timer || !w.clients.size) return;
  w.timer = setInterval(() => {
    if (!w.clients.size) {
      clearInterval(w.timer);
      watched.delete(w.dir);
      return;
    }
    push(w).catch((err) => {
      for (const res of w.clients) res.write(frame('failure', String(err.message)));
    });
  }, POLL_MS);
}

const empty = () => buildModel([], {});
const NOT_FOUND = { error: 'no such swarm' };

app.get('/api/swarms', (_req, res) => {
  if (PINNED) {
    const one = describe(PINNED) ?? { id: path.basename(PINNED), goal: '', state: 'unknown' };
    return res.json({ pinned: true, root: PINNED, swarms: [one], selected: null });
  }
  const swarms = listSwarms(swarmRoot());
  res.json({ pinned: false, root: swarmRoot(), swarms, selected: swarms[0]?.id ?? null });
});

app.get('/api/swarm', async (req, res) => {
  const { dir, missing } = resolveSwarm(req.query.get('swarm'));
  if (missing) return res.status(404).json(NOT_FOUND);
  res.json(dir ? (await load(dir)).model : empty());
});

app.get('/api/log', async (req, res) => {
  const { dir, missing } = resolveSwarm(req.query.get('swarm'));
  if (missing) return res.status(404).json(NOT_FOUND);
  if (!dir) return res.json([]);
  const since = Number(req.query.get('since')) || 0;
  res.json((await load(dir)).log.filter((r) => r.seq > since));
});

app.get('/api/diff', async (req, res) => {
  const { dir } = resolveSwarm(req.query.get('swarm'));
  if (!dir) return res.status(404).json(NOT_FOUND);
  const { main } = await storeReady();
  const r = main('diff', { dir, publication_id: Number(req.query.get('publication')), path: req.query.get('path') ?? '' });
  if (!r.ok) return res.status(400).json({ error: r.error });
  const { ok: _ok, ...diff } = r;
  res.json(diff);
});

app.get('/api/stats', (_req, res) => {
  const swarms = [...watched.values()].map((w) => ({ id: path.basename(w.dir), clients: w.clients.size, watching: !!w.timer }));
  res.json({ ...stats, swarms });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, pid: process.pid, port: server.address()?.port ?? null, configDir: CONFIG, pinned: !!PINNED });
});

const activity = { last: Date.now(), streams: 0 };

// EventSource cannot read an error body, so a wrong id is a `missing` frame on an open stream.
app.get('/api/stream', async (req, res) => {
  const { dir, missing } = resolveSwarm(req.query.get('swarm'));
  const model = dir ? (await load(dir)).model : empty();
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (missing) return res.end(frame('missing', `No swarm named ${req.query.get('swarm')}.`));
  res.write(frame('swarm', model));
  activity.streams++;
  res.on('close', () => {
    activity.streams--;
    activity.last = Date.now();
  });
  if (!dir) return;
  const w = entry(dir);
  w.clients.add(res);
  req.on('close', () => w.clients.delete(res));
  watch(w);
});

app.get('/hub-app.json', (_req, res) => sendFile(res, path.join(__dirname, 'hub-app.json')));

function sendFile(res, file) {
  fs.readFile(file, (err, body) => {
    if (err) return res.status(404).json({ error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  });
}

function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return res.status(400).json({ error: 'bad path' });
  }
  const file = path.join(PUBLIC, rel.endsWith('/') ? `${rel}index.html` : rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return res.status(404).json({ error: 'not found' });
  sendFile(res, file);
}

function handle(req, res) {
  activity.last = Date.now();
  decorate(res);
  // A page on another site can reach a loopback server through DNS rebinding. The Host header gives it away.
  const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!ALLOWED.has(host)) return res.status(403).json({ error: `host ${host || '(none)'} is not allowed` });
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'method not allowed' });
  const url = new URL(req.url, 'http://viewer');
  req.query = url.searchParams;
  const route = routes.get(url.pathname);
  if (!route) return serveStatic(url.pathname, res);
  Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => {
      console.error(err);
      if (res.headersSent) return res.end();
      res.status(500).json({ error: `read failed (${err.code || err.message || 'error'})` });
    });
}

const server = http.createServer(handle);
server.keepAliveTimeout = 65_000;

const ready = (port) => console.log(`Swarm running at http://localhost:${port}`);

function idleExit() {
  const timer = setInterval(() => {
    if (activity.streams || Date.now() - activity.last < IDLE_MS) return;
    console.log(`Swarm exits: no request for ${IDLE_MS / 60_000} min`);
    clearInterval(timer);
    server.close();
    process.exit(0);
  }, Math.min(60_000, Math.max(100, IDLE_MS / 4)));
}

async function start() {
  const file = recordFile(CONFIG);
  if (SHARED) {
    const live = await liveRecord(file, CONFIG);
    if (live) return ready(live.port);
    process.on('exit', () => removeRecord(file));
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
  }
  server.on('error', (err) => {
    console.error(`Swarm could not listen on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
  });
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  const { port } = server.address();
  if (SHARED) {
    const claim = await claimRecord(file, CONFIG, port);
    if (claim.live) {
      server.close();
      return ready(claim.live.port);
    }
    if (!claim.claimed) console.error(`Swarm runs without a record: ${file} is held`);
  }
  ready(port);
  console.log(PINNED ? `swarm folder: ${PINNED}` : `swarms under: ${swarmRoot()}`);
  if (IDLE_MS > 0) idleExit();
}

if (require.main === module) start();

module.exports = server;

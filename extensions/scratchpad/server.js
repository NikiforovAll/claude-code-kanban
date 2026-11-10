#!/usr/bin/env node
'use strict';

// No dependencies: the server runs on node: modules only, so a linked or bundled install needs no npm install.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createViewers } = require('./lib/viewers');
const { createHistory } = require('./lib/history');
const { scratchBin } = require('./lib/scratch-bin');
const { bridgeScript } = require('./lib/bridge');
const { canonicalPath } = require('./lib/paths');

const DEFAULT_PORT = 3547;
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const PUBLIC = path.join(__dirname, 'public');
const MANIFEST = 'scratchpad.json';
const ALLOWED = new Set(['localhost', '127.0.0.1', '[::1]']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// A miss is probed again, so scratch installed after start works without a restart.
let bin = null;
const resolveBin = () => (bin ??= scratchBin());

const bridge = bridgeScript();
const tag = `<script>${bridge}</script>`;
const viewers = createViewers({
  resolveBin,
  spawn,
  inject: bridge ? (html) => (html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html) : undefined,
});
// The hub runs one set of apps per Claude config dir, so each dir keeps its own pad list.
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const history = createHistory(path.join(configDir, '.cck', 'scratchpads', 'history.json'));

const routes = new Map();
const posts = new Map();
const prefixes = [];

// The hub's server SDK calls app.get(path, handler) and app.use(prefix, handler), and answers with
// res.type().send(), res.json() or res.sendFile().
const app = {
  get: (p, fn) => routes.set(p, fn),
  use: (prefix, fn) => prefixes.push([prefix, fn]),
};

function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.type = (t) => {
    res.setHeader('Content-Type', TYPES[`.${t}`] ?? t);
    return res;
  };
  res.send = (body) => res.end(body);
  res.json = (body) => {
    res.setHeader('Content-Type', TYPES['.json']);
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  res.sendFile = (file) => sendFile(res, file);
}

function sendFile(res, file) {
  fs.readFile(file, (err, body) => {
    if (err) return res.status(404).json({ error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** The pad folder for a folder or its scratchpad.json. */
function padDir(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw badRequest('path must be an absolute path');
  const abs = path.resolve(target);
  const dir = path.basename(abs).toLowerCase() === MANIFEST ? path.dirname(abs) : abs;
  if (!fs.existsSync(path.join(dir, MANIFEST))) throw badRequest(`Not a scratchpad: ${target}`);
  return dir;
}

const optional = (v) => (typeof v === 'string' && v ? v : null);

routes.set('/api/pads', (_req, res) => {
  const groups = history.groups().map((g) => ({
    ...g,
    pads: g.pads.map((p) => ({ ...p, key: canonicalPath(p.dir), name: path.basename(p.dir) })),
  }));
  res.json({ groups, viewers: viewers.list(), scratch: !!resolveBin() });
});

posts.set('/api/open', async (req, res) => {
  const body = await readBody(req);
  const dir = padDir(body.path);
  const url = await viewers.serve(dir);
  if (body.remember !== false) history.add({ dir, project: optional(body.project), session: optional(body.session) });
  res.json({ url, dir, key: canonicalPath(dir), name: path.basename(dir) });
});

posts.set('/api/forget', async (req, res) => {
  const { path: dir } = await readBody(req);
  if (typeof dir !== 'string' || !dir) throw badRequest('path is required');
  res.json({ forgotten: history.remove(dir) });
});

posts.set('/api/viewers/stop', async (req, res) => {
  const { path: dir } = await readBody(req);
  res.json({ stopped: viewers.stop(String(dir)) });
});

posts.set('/api/viewers/restart', async (req, res) => {
  const dir = padDir((await readBody(req)).path);
  res.json({ url: await viewers.restart(dir) });
});

// Run alone, the page gets no SDK and works without the hub.
if (process.env.HUB_SDK_SERVER) require(process.env.HUB_SDK_SERVER).mount(app);
else routes.set('/vendor/claude-hub-sdk.js', (_req, res) => res.type('js').send(''));

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

// The hub forwards Host as the browser sent it but rewrites Origin to the app's own port.
const ownOrigin = (origin) => {
  try {
    const u = new URL(origin);
    return ALLOWED.has(u.hostname.toLowerCase()) && Number(u.port) === server.address()?.port;
  } catch {
    return false;
  }
};

function handle(req, res) {
  decorate(res);
  // A page on another site can reach a loopback server through DNS rebinding. The Host header gives it away.
  const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!ALLOWED.has(host)) return res.status(403).json({ error: `host ${host || '(none)'} is not allowed` });
  const url = new URL(req.url, 'http://scratchpads');
  req.path = url.pathname;
  const post = req.method === 'POST' && posts.get(url.pathname);
  if (!post && req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'method not allowed' });
  // A page on another site can still send a POST to a loopback port, and the viewers run code.
  if (post && !ownOrigin(req.headers.origin)) return res.status(403).json({ error: 'a write must come from this page' });
  const prefix = !post && prefixes.find(([p]) => url.pathname.startsWith(`${p}/`));
  if (prefix) {
    req.path = url.pathname.slice(prefix[0].length);
    return prefix[1](req, res, () => serveStatic(url.pathname, res));
  }
  const route = post || routes.get(url.pathname);
  if (!route) return serveStatic(url.pathname, res);
  Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => {
      if (!err.status) console.error(err);
      if (res.headersSent) return res.end();
      res.status(err.status || 502).json({ error: err.message });
    });
}

const server = http.createServer(handle);
server.keepAliveTimeout = 65_000;

function shutdown() {
  viewers.stopAll();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, shutdown);
process.on('exit', () => viewers.stopAll());

server.on('error', (err) => {
  console.error(`Scratchpads could not listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Scratchpads running at http://localhost:${server.address().port}`);
  if (!resolveBin()) console.log('scratch CLI not found on PATH: pads will not open');
});

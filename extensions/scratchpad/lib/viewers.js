'use strict';

// One `scratch ui --json` browser viewer per pad, each behind its own loopback proxy. The viewer's page
// uses root paths (/events, /data, href="/file.md"), so a proxy under a path prefix would break it.
// The proxy adds the key bridge to the page and counts its live-reload streams: a viewer that no page
// has open for idleMs stops, and the next request for its pad starts it again.

const http = require('node:http');
const path = require('node:path');
const { canonicalPath } = require('./paths');

const READY_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 1500;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * @param {object} o
 * @param {() => string|null} o.resolveBin the `scratch` executable, or null when it cannot be launched
 * @param {Function} o.spawn child_process.spawn
 * @param {(html: string) => string} [o.inject] rewrites each HTML page the viewer serves
 */
function createViewers({
  resolveBin,
  spawn,
  inject = (html) => html,
  fetch = globalThis.fetch,
  idleMs = 10 * 60_000,
  readyTimeoutMs = READY_TIMEOUT_MS,
}) {
  const live = new Map();
  const starting = new Map();

  function stop(key) {
    const entry = live.get(key);
    if (!entry) return false;
    live.delete(key);
    entry.proxy.close();
    entry.proxy.closeAllConnections();
    entry.child.kill();
    return true;
  }

  async function healthy(entry, key) {
    try {
      const res = await fetch(new URL(`/__scratch/health${entry.upstream.search}`, entry.upstream), {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const { pid, pads } = await res.json();
      return pid === entry.pid && Array.isArray(pads) && pads.some((p) => canonicalPath(p) === key);
    } catch {
      return false;
    }
  }

  function proxyRequest(entry, req, res) {
    const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (!LOOPBACK.has(host)) {
      res.writeHead(403).end();
      return;
    }
    entry.lastUse = Date.now();
    const headers = { ...req.headers, host: entry.upstream.host };
    delete headers['accept-encoding'];
    const up = http.request(
      { host: entry.upstream.hostname, port: entry.upstream.port, method: req.method, path: req.url, headers },
      (upRes) => {
        if (req.url.startsWith('/events')) {
          entry.streams++;
          res.on('close', () => {
            entry.streams--;
            entry.lastUse = Date.now();
          });
        }
        if (!String(upRes.headers['content-type']).startsWith('text/html')) {
          res.writeHead(upRes.statusCode, upRes.headers);
          res.flushHeaders();
          upRes.pipe(res);
          return;
        }
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const { 'content-length': _, ...rest } = upRes.headers;
          res.writeHead(upRes.statusCode, rest);
          res.end(inject(Buffer.concat(chunks).toString('utf8')));
        });
      },
    );
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`scratch viewer did not answer (${e.code || e.message})`);
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  function listenProxy(entry) {
    const proxy = http.createServer((req, res) => proxyRequest(entry, req, res));
    return new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => resolve(proxy));
    });
  }

  function start(dir, key) {
    const file = resolveBin();
    if (!file) {
      const err = new Error('scratch CLI not found on PATH');
      err.status = 501;
      return Promise.reject(err);
    }
    // No `detached`: on Windows it overrides `windowsHide` and the bun shim opens a console window.
    const child = spawn(file, ['ui', path.basename(dir), '--dir', path.dirname(dir), '--json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin.on('error', () => {});
    let stderr = '';
    child.stderr.on('data', (b) => {
      stderr = (stderr + b).slice(-2000);
    });
    return new Promise((resolve, reject) => {
      let buf = '';
      let entry = null;
      const fail = (msg) => {
        clearTimeout(timer);
        child.kill();
        reject(new Error(`${msg}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
      };
      const timer = setTimeout(() => fail('scratch viewer did not start'), readyTimeoutMs);
      // Read stdout to the end, so a chatty viewer never fills the pipe and blocks.
      child.stdout.on('data', async (b) => {
        if (entry) return;
        buf += b;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        let ready;
        try {
          ready = JSON.parse(buf.slice(0, nl));
        } catch {
          fail('scratch viewer printed no ready line (needs scratch with `ui --json`)');
          return;
        }
        entry = { child, dir, pid: ready.pid, upstream: new URL(ready.url), streams: 0, lastUse: Date.now() };
        try {
          entry.proxy = await listenProxy(entry);
        } catch (e) {
          fail(`proxy did not start (${e.message})`);
          return;
        }
        const url = new URL(entry.upstream);
        url.port = entry.proxy.address().port;
        entry.url = url.href;
        live.set(key, entry);
        resolve(entry);
      });
      child.on('error', (e) => fail(`scratch viewer failed to start (${e.message})`));
      child.on('exit', (code) => {
        if (!entry) {
          fail(`scratch viewer exited (${code})`);
          return;
        }
        if (live.get(key) === entry) stop(key);
      });
      child.unref();
      child.stdin.unref?.();
      child.stdout.unref?.();
      child.stderr.unref?.();
    });
  }

  /** The proxied viewer URL for the pad at `dir`, started when no live one answers for it. */
  async function serve(dir) {
    const key = canonicalPath(dir);
    const entry = live.get(key);
    if (entry && (await healthy(entry, key))) {
      entry.lastUse = Date.now();
      return entry.url;
    }
    if (entry) stop(key);
    if (!starting.has(key)) starting.set(key, start(dir, key).finally(() => starting.delete(key)));
    return (await starting.get(key)).url;
  }

  /** A new viewer for the pad, so it runs the `scratch` installed now. */
  async function restart(dir) {
    stop(canonicalPath(dir));
    return serve(dir);
  }

  function sweep(now = Date.now()) {
    for (const [key, entry] of live) if (!entry.streams && now - entry.lastUse >= idleMs) stop(key);
  }
  const timer = setInterval(sweep, Math.min(60_000, idleMs));
  timer.unref();

  function list() {
    return [...live.entries()].map(([key, e]) => ({
      dir: e.dir,
      key,
      name: path.basename(e.dir),
      streams: e.streams,
      idleSince: e.streams ? null : e.lastUse,
    }));
  }

  return {
    serve,
    restart,
    stop: (dir) => stop(canonicalPath(dir)),
    running: (dir) => live.has(canonicalPath(dir)),
    list,
    sweep,
    stopAll: () => {
      clearInterval(timer);
      for (const key of [...live.keys()]) stop(key);
    },
  };
}

module.exports = { createViewers };

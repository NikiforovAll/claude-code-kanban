// One `scratch ui --json` browser viewer per pad, for scratchpad panes. Each child holds a pipe on
// its stdin that cck never writes to: when cck exits, the pipe closes and the viewer exits with it.

const path = require('node:path');
const { canonicalPath } = require('./linked-docs');

const READY_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 1500;

/**
 * @param {object} o
 * @param {() => string|null} o.resolveBin the `scratch` executable, or null when it cannot be launched
 * @param {(file: string, args: string[], opts: object) => import('node:child_process').ChildProcess} o.spawn
 * @param {(pad: string) => void} [o.onExit] the canonical pad dir of a viewer that exited
 */
function createScratchServers({ resolveBin, spawn, fetch = globalThis.fetch, onExit = () => {}, max = 4, readyTimeoutMs = READY_TIMEOUT_MS }) {
  // Map order is recency: the first entry is the one stopped when a new pad needs room.
  const live = new Map();
  const starting = new Map();

  function stop(key) {
    const entry = live.get(key);
    if (!entry) return;
    live.delete(key);
    entry.child.kill();
  }

  async function healthy(entry, key) {
    try {
      const res = await fetch(new URL(`/__scratch/health${new URL(entry.url).search}`, entry.url), {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const { pid, pads } = await res.json();
      return pid === entry.pid && Array.isArray(pads) && pads.some((p) => canonicalPath(p) === key);
    } catch {
      return false;
    }
  }

  async function start(dir, key) {
    const file = resolveBin();
    if (!file) {
      const err = new Error('scratch CLI not found on PATH');
      err.status = 501;
      throw err;
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
      child.stdout.on('data', (b) => {
        if (entry) return;
        buf += b;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        try {
          const ready = JSON.parse(buf.slice(0, nl));
          entry = { child, url: ready.url, pid: ready.pid };
        } catch {
          fail('scratch viewer printed no ready line (needs scratch with `ui --json`)');
          return;
        }
        buf = '';
        while (live.size >= max) stop(live.keys().next().value);
        live.set(key, entry);
        resolve(entry);
      });
      child.on('error', (e) => fail(`scratch viewer failed to start (${e.message})`));
      child.on('exit', (code) => {
        if (!entry) {
          fail(`scratch viewer exited (${code})`);
          return;
        }
        if (live.get(key) === entry) live.delete(key);
        onExit(key);
      });
      child.unref();
      child.stdin.unref?.();
      child.stdout.unref?.();
      child.stderr.unref?.();
    });
  }

  /** The viewer URL for the pad at `dir`, started when no live one answers for it. */
  async function serve(dir) {
    const key = canonicalPath(dir);
    const entry = live.get(key);
    if (entry && (await healthy(entry, key))) {
      live.delete(key);
      live.set(key, entry);
      return entry.url;
    }
    if (entry) stop(key);
    if (!starting.has(key)) starting.set(key, start(dir, key).finally(() => starting.delete(key)));
    return (await starting.get(key)).url;
  }

  return { serve, size: () => live.size };
}

module.exports = { createScratchServers };

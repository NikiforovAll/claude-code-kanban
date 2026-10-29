// Starts a global add-on's own server (`run` in its entry) the first time the board opens it and
// the URL's port does not answer. The process is cck's child, so it ends with the board; under
// the hub, `taskkill /f /t` on cck takes it too. A second board on the config dir finds the
// port answering and starts nothing.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { sampleUrl } = require('./addons');
const { portOf } = require('./panes');

const MAX_STARTS = 3;
const STARTS_WINDOW_MS = 60_000;
const READY_MS = 20_000;
const POLL_MS = 300;

function urlPort(url) {
  const u = new URL(url);
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: portOf(u) };
}

const targetOf = (entry) => urlPort(sampleUrl(entry.url));

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

function portAnswers({ host, port }, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Sync only on exit, where nothing async runs; else taskkill would hold the event loop for its run.
function killTree(child, sync = false) {
  if (exited(child)) return;
  if (process.platform !== 'win32') {
    // The shell's own group: SIGTERM to the shell alone leaves the server it started running.
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    return;
  }
  const args = ['/f', '/t', '/pid', String(child.pid)];
  const opts = { windowsHide: true, stdio: 'ignore' };
  if (sync) spawnSync('taskkill', args, opts);
  else spawn('taskkill', args, opts).once('error', () => {});
}

/**
 * @param {object} o
 * @param {string} o.logDir one `<id>.log` per add-on, rewritten on each start
 * @param {(target: {host: string, port: number}) => Promise<boolean>} [o.probe]
 */
function createAddonRunner({ logDir, probe = portAnswers, now = Date.now }) {
  const byId = new Map();
  const logPath = (id) => path.join(logDir, `${id}.log`);

  async function waitReady(target, child) {
    const until = now() + READY_MS;
    while (now() < until) {
      if (exited(child)) return false;
      if (await probe(target)) return true;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return false;
  }

  async function start(entry, target, state) {
    const t = now();
    state.starts = state.starts.filter((s) => t - s < STARTS_WINDOW_MS);
    if (state.starts.length >= MAX_STARTS) {
      return { state: 'failed', error: `Started ${MAX_STARTS} times in a minute; see the log`, log: logPath(entry.id) };
    }
    state.starts.push(t);
    fs.mkdirSync(logDir, { recursive: true });
    const fd = fs.openSync(logPath(entry.id), 'w');
    let child;
    try {
      child = spawn(entry.run, {
        shell: true,
        detached: process.platform !== 'win32',
        cwd: entry.cwd || undefined,
        env: { ...process.env, PORT: String(target.port) },
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } catch (e) {
      return { state: 'failed', error: e.message, log: logPath(entry.id) };
    } finally {
      fs.closeSync(fd);
    }
    child.once('error', () => {});
    state.child = child;
    state.started = entry;
    if (await waitReady(target, child)) return { state: 'up' };
    const gone = exited(child);
    killTree(child);
    return { state: 'failed', error: gone ? `Exited with code ${child.exitCode}` : `No answer on port ${target.port} in ${READY_MS / 1000} s`, log: logPath(entry.id) };
  }

  // One start at a time per add-on: a second open while it starts waits for the same answer.
  async function ensure(entry) {
    if (!entry.run) return { state: 'none' };
    const target = targetOf(entry);
    if (!byId.has(entry.id)) byId.set(entry.id, { starts: [], child: null, pending: null });
    const state = byId.get(entry.id);
    if (state.pending) return state.pending;
    state.pending = probe(target)
      .then((up) => (up ? { state: 'up' } : start(entry, target, state)))
      .finally(() => {
        state.pending = null;
      });
    return state.pending;
  }

  function ownChild(id) {
    const child = byId.get(id)?.child;
    return child && !exited(child) ? child : null;
  }

  // 'running' (this board's child, or `external`: another process answers the port) or 'stopped'.
  async function status(entry) {
    if (ownChild(entry.id)) return 'running';
    return (await probe(targetOf(entry))) ? 'external' : 'stopped';
  }

  // Kills this board's child and starts it again. A server this board did not start is left alone.
  async function restart(entry) {
    const child = ownChild(entry.id);
    if (child) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        killTree(child);
      });
    } else if ((await status(entry)) === 'external') {
      return { state: 'external', error: 'Its server was not started by this board, so the board cannot restart it' };
    }
    const target = targetOf(entry);
    const until = now() + READY_MS;
    while (now() < until && (await probe(target))) await new Promise((r) => setTimeout(r, POLL_MS));
    return ensure(entry);
  }

  function stop(id) {
    const state = byId.get(id);
    if (state?.child) killTree(state.child);
    byId.delete(id);
    fs.rmSync(logPath(id), { force: true });
  }

  // After another process changed addons.json: stops each server whose entry is gone or now starts
  // another way, so a removed add-on lets go of its folder and the next open runs the new command.
  function retain(entries) {
    for (const [id, state] of byId) {
      const e = entries.find((x) => x.id === id);
      const was = state.started;
      if (!e || (was && (e.run !== was.run || e.cwd !== was.cwd || e.url !== was.url))) stop(id);
    }
  }

  function shutdown() {
    for (const state of byId.values()) if (state.child) killTree(state.child, true);
  }

  return { ensure, status, restart, stop, retain, shutdown };
}

module.exports = { createAddonRunner, urlPort };

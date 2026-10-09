'use strict';

// cck's side of the terminal host (lib/terminal-host.js). cck keeps the gates it can check
// alone (enabled, exposure, Host and Origin, the token) and the ids the host last reported,
// so the board's sync callers stay sync; everything else is a call over IPC.

const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const path = require('node:path');
const { tokenMatches, localUnavailableReason, refuseUpgrade, clientConfigFor } = require('./terminal');

const HOST = path.join(__dirname, 'terminal-host.js');
const CALL_TIMEOUT_MS = 15000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000;
const RESTART_DELAY_MS = 1000;

function hostError(message) {
  return Object.assign(new Error(message), { status: 503 });
}

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./terminal').readTerminalConfig>} o.config
 * @param {{EXPOSED: boolean, upgradeVerdict: (req: any) => string|null}} o.net
 * @param {string} o.claudeDir
 * @param {boolean} o.isDefaultDir
 * @param {string} o.sessionsDir  claude's live-session registry
 * @param {(id: string) => string|null|Promise<string|null>} o.resolveCwd
 * @param {(dir: string) => boolean|Promise<boolean>} o.isAllowedFolder
 * @param {string} [o.token]
 * @param {() => {sessions?: string[]}|null} [o.load]
 * @param {(data: {sessions: string[]}) => void} [o.save]
 * @param {() => void} [o.onChange]
 * @param {(id: string) => void} [o.onExit]
 */
function createTerminalClient(o) {
  const { config, net } = o;
  const token = o.token || crypto.randomBytes(32).toString('hex');
  const localReason = localUnavailableReason(config, net);
  let child = null;
  let hostReason = null;
  let ids = [];
  let terminalIds = [];
  let serverUrl = null;
  let restoreAsked = false;
  let stopped = false;
  let shuttingDown = false;
  const restarts = [];
  let nextCall = 0;
  const calls = new Map();
  let settle;
  const started = new Promise((resolve) => { settle = resolve; });

  function unavailableReason() {
    if (localReason) return localReason;
    if (stopped) return 'the terminal host stopped';
    if (!child) return 'the terminal host is restarting';
    return hostReason;
  }

  function spawn() {
    hostReason = null;
    const c = fork(HOST, [], { execArgv: [], windowsHide: true });
    child = c;
    c.on('message', (msg) => { if (c === child) onMessage(c, msg); });
    c.on('exit', (code, signal) => { if (c === child) onHostExit(code, signal); });
    c.on('error', () => {});
    c.send({
      t: 'init', config, claudeDir: o.claudeDir, isDefaultDir: o.isDefaultDir, sessionsDir: o.sessionsDir, token, serverUrl,
      saved: config.restore ? o.load?.() ?? null : null,
    });
    if (restoreAsked) call('restore').catch(() => {});
  }

  function onMessage(c, msg) {
    if (msg.t === 'state') {
      hostReason = msg.reason;
      ids = msg.ids;
      terminalIds = msg.terminalIds || [];
      settle(hostReason);
      o.onChange?.();
    } else if (msg.t === 'exit') o.onExit?.(msg.id);
    else if (msg.t === 'save') o.save?.(msg.data);
    else if (msg.t === 'reply') {
      const pending = calls.get(msg.id);
      if (!pending) return;
      calls.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.value);
    } else if (msg.t === 'ask') answer(c, msg);
  }

  const ASKS = {
    resolveCwd: [o.resolveCwd, null],
    isAllowedFolder: [o.isAllowedFolder, false],
  };

  async function answer(c, msg) {
    const [fn, fallback] = ASKS[msg.op];
    let value;
    try {
      value = await fn(msg.arg);
    } catch {
      value = fallback;
    }
    if (c.connected) c.send({ t: 'answer', id: msg.id, value });
  }

  // The PTYs die with the host, as they do with cck; a new host resumes terminals.json.
  function onHostExit(code, signal) {
    child = null;
    for (const pending of calls.values()) {
      clearTimeout(pending.timer);
      pending.reject(hostError('the terminal host stopped'));
    }
    calls.clear();
    if (shuttingDown) return;
    console.log(`Terminal host exited (${signal || code})`);
    const lost = ids;
    ids = [];
    terminalIds = [];
    for (const id of lost) o.onExit?.(id);
    o.onChange?.();
    const now = Date.now();
    while (restarts.length && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length >= MAX_RESTARTS) {
      stopped = true;
      console.log(`Terminal unavailable: the host stopped ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 1000} s`);
      settle(unavailableReason());
      return;
    }
    restarts.push(now);
    setTimeout(() => { if (!shuttingDown) spawn(); }, RESTART_DELAY_MS * restarts.length).unref();
  }

  function call(op, ...args) {
    const c = child;
    if (!c?.connected) return Promise.reject(hostError(unavailableReason() || 'the terminal host is not running'));
    return new Promise((resolve, reject) => {
      const id = ++nextCall;
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(hostError('the terminal host did not answer'));
      }, CALL_TIMEOUT_MS);
      calls.set(id, { resolve, reject, timer });
      c.send({ t: 'call', id, op, args });
    });
  }

  function handleUpgrade(req, socket, head) {
    if (refuseUpgrade(req, socket, () => unavailableReason() || net.upgradeVerdict(req))) return;
    // The client sends nothing before the 101, so no byte is lost between the two processes.
    child.send({ t: 'upgrade', method: req.method, url: req.url, headers: req.headers, head: head.toString('base64') }, socket, (err) => {
      if (err) socket.destroy();
    });
  }

  function authorized(providedToken) {
    return tokenMatches(token, providedToken);
  }

  function isRunning(id) {
    return ids.includes(id);
  }

  function hasTerminal(terminalId) {
    return terminalIds.includes(terminalId);
  }

  // The host sends both lists from one array of terminals.
  function sessionOfTerminal(terminalId) {
    const at = terminalIds.indexOf(terminalId);
    return at < 0 ? null : ids[at];
  }

  async function startNew(msg, extraEnv) {
    if (localReason) return { status: 403, error: localReason };
    return call('startNew', msg, extraEnv);
  }

  async function end(id, providedToken) {
    if (!authorized(providedToken)) return 'auth';
    if (localReason) return 'not-found';
    return call('end', id, providedToken);
  }

  async function paste(id, text) {
    if (!isRunning(id)) return false;
    return call('paste', id, text).catch(() => false);
  }

  function restore() {
    restoreAsked = true;
    if (child) call('restore').catch(() => {});
  }

  function setServerUrl(url) {
    serverUrl = url;
    if (child?.connected) child.send({ t: 'port', url });
  }

  // With no host there are no terminals, which the hub's eviction check must still read.
  async function sessions() {
    return child?.connected ? call('sessions') : [];
  }

  async function stats() {
    const c = child;
    return { hostPid: c?.pid ?? null, claudePids: c?.connected ? await call('claudePids') : {} };
  }

  function clientConfig() {
    return clientConfigFor(config, !unavailableReason());
  }

  // Closing the channel is what ends the host, so it ends its PTYs itself.
  function shutdown() {
    shuttingDown = true;
    try { child?.disconnect(); } catch { /* already closed */ }
  }

  if (localReason) settle(localReason);
  else spawn();

  return {
    token, handleUpgrade, clientConfig, unavailableReason, authorized, isRunning, hasTerminal, sessionOfTerminal, startNew, end, paste, restore,
    setServerUrl, sessions, stats, shutdown, started,
    ids: () => [...ids],
  };
}

module.exports = { createTerminalClient };

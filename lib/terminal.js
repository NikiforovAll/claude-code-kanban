'use strict';

// Embedded terminal: one PTY per session id, reached over a WebSocket.
//
// A PTY endpoint turns any gap in the network boundary into code execution as the
// user, so the upgrade passes three independent gates: Host + strict Origin
// (net-guard upgradeVerdict), refusal when the server is exposed, and a per-launch
// token sent in the first message. The token is the only one that stops a
// non-browser local process.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WS_PATH = '/api/terminal/ws';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = new Set(['auto', 'resume', 'fork', 'shell']);
// Watermarks from https://xtermjs.org/docs/guides/flowcontrol/ — pause the PTY while a
// client lags, so a runaway process cannot grow the socket buffer without bound.
const HIGH_WATER = 128 * 1024;
const LOW_WATER = 16 * 1024;
const HELLO_TIMEOUT_MS = 5000;
const MAX_PAYLOAD = 1024 * 1024;
// The hub hands its children PORT=0 and friends; a dev server started in the terminal
// would otherwise bind a random port, and a nested `claude` would think it runs inside one.
const STRIP_ENV = [
  'PORT', 'HOST', 'ALLOWED_HOSTS', 'CLAUDE_HUB', 'HUB_URL',
  'CCK_TERMINAL', 'CCK_TERMINAL_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
];

function posInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// CCK_TERMINAL is the hub's `terminal` config block as JSON; flags win over it.
function readTerminalConfig({ argv = process.argv, env = process.env, getArgValue } = {}) {
  let cfg = {};
  try { cfg = JSON.parse(env.CCK_TERMINAL || '{}') || {}; } catch { cfg = {}; }
  return {
    enabled: argv.includes('--enable-terminal') || cfg.enabled === true,
    shell: (getArgValue && getArgValue('terminal-shell')) || (typeof cfg.shell === 'string' && cfg.shell) || null,
    maxSessions: posInt(cfg.maxSessions, 8),
    fontFamily: typeof cfg.fontFamily === 'string' && cfg.fontFamily ? cfg.fontFamily : null,
    fontSize: posInt(cfg.fontSize, 13),
    scrollback: posInt(cfg.scrollback, 5000),
    noFlicker: cfg.noFlicker !== false,
  };
}

function shellFamily(shell) {
  const base = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') return 'pwsh';
  if (base === 'cmd') return 'cmd';
  return 'posix';
}

function defaultShell(which) {
  if (process.platform === 'win32') return which('pwsh') ? 'pwsh.exe' : 'powershell.exe';
  return process.env.SHELL || '/bin/sh';
}

// claudeArgs is null for a plain shell. Its items are fixed flags plus a validated
// UUID, so joining them into a shell command line cannot inject.
function shellArgs(shell, claudeArgs) {
  const family = shellFamily(shell);
  if (!claudeArgs) return family === 'pwsh' ? ['-NoLogo'] : [];
  const cmd = ['claude', ...claudeArgs].join(' ');
  if (family === 'pwsh') return ['-NoLogo', '-NoExit', '-Command', cmd];
  if (family === 'cmd') return ['/k', cmd];
  // $0 is the shell itself (the argument after the script), so exiting claude
  // lands in an interactive shell of the same kind.
  return ['-c', `${cmd}; exec "$0"`, shell];
}

function claudeArgsFor(mode, id) {
  if (mode === 'shell') return null;
  if (mode === 'fork') return ['--resume', id, '--fork-session'];
  return ['--resume', id];
}

// Claude Code keeps .claude.json beside ~/.claude when CLAUDE_CONFIG_DIR is unset but
// inside the dir when set, so the default dir must stay unset, not be spelled out.
function ptyEnv({ claudeDir, isDefaultDir, noFlicker }) {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  if (isDefaultDir) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = claudeDir;
  // xterm.js #5801: a clear inside a synchronized-output block jumps the viewport.
  if (noFlicker) env.CLAUDE_CODE_NO_FLICKER = '1';
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

function clampDim(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(500, Math.max(2, n)) : fallback;
}

function refuse(socket, status, reason) {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${reason}\n`);
  } catch { /* socket already gone */ }
  socket.destroy();
}

/**
 * @param {object} o
 * @param {ReturnType<typeof readTerminalConfig>} o.config
 * @param {{EXPOSED: boolean, upgradeVerdict: (req: any) => string|null}} o.net
 * @param {string} o.claudeDir
 * @param {boolean} o.isDefaultDir
 * @param {(id: string) => string|null} o.resolveCwd  null = unknown session
 * @param {(id: string) => boolean} o.isLiveElsewhere
 * @param {(cmd: string) => string|null} o.which
 * @param {string} [o.token]
 */
function createTerminalService(o) {
  const { config, net } = o;
  const token = o.token || crypto.randomBytes(32).toString('hex');
  const sessions = new Map();
  let pty = null;
  let loadError = null;
  let wss = null;
  let Headless = null;
  let Serialize = null;

  // Lazy and optional: a missing prebuilt must hide the feature, not crash cck.
  function load() {
    if (pty || loadError) return !!pty;
    try {
      pty = require('@lydell/node-pty');
      ({ Terminal: Headless } = require('@xterm/headless'));
      ({ SerializeAddon: Serialize } = require('@xterm/addon-serialize'));
      const { WebSocketServer } = require('ws');
      wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    } catch (e) {
      pty = null;
      loadError = `terminal backend failed to load: ${e.message}`;
    }
    return !!pty;
  }

  function unavailableReason() {
    if (!config.enabled) return 'disabled';
    if (net.EXPOSED) return 'refused while listening on a non-loopback address';
    if (!load()) return loadError;
    return null;
  }

  function send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function sendOutput(ws, buf) {
    ws.unacked += buf.length;
    ws.send(buf);
  }

  function updateFlow(s) {
    let lagging = false;
    let drained = true;
    for (const ws of s.sockets) {
      if (ws.unacked > HIGH_WATER) lagging = true;
      if (ws.unacked > LOW_WATER) drained = false;
    }
    if (lagging && !s.paused) { s.paused = true; s.pty.pause(); }
    else if (drained && s.paused) { s.paused = false; s.pty.resume(); }
  }

  function spawnSession(id, mode, cwdCandidate, cols, rows) {
    const cwd = cwdCandidate && fs.existsSync(cwdCandidate) ? cwdCandidate : os.homedir();
    const shell = config.shell || defaultShell(o.which);
    const proc = pty.spawn(shell, shellArgs(shell, claudeArgsFor(mode, id)), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: ptyEnv({ claudeDir: o.claudeDir, isDefaultDir: o.isDefaultDir, noFlicker: config.noFlicker }),
    });
    const term = new Headless({ cols, rows, scrollback: config.scrollback, allowProposedApi: true });
    const serializer = new Serialize();
    term.loadAddon(serializer);
    const s = { id, mode, cwd, pty: proc, term, serializer, sockets: new Set(), exited: false, paused: false, startedAt: Date.now() };

    proc.onData((data) => {
      term.write(data);
      if (!s.sockets.size) return;
      const buf = Buffer.from(data, 'utf8');
      for (const ws of s.sockets) if (ws.readyState === 1) sendOutput(ws, buf);
      updateFlow(s);
    });
    proc.onExit(({ exitCode }) => {
      s.exited = true;
      if (sessions.get(id) === s) sessions.delete(id);
      for (const ws of s.sockets) {
        send(ws, { t: 'exit', code: exitCode });
        ws.close(1000);
      }
      term.dispose();
    });
    sessions.set(id, s);
    return s;
  }

  function attach(ws, s, attached) {
    ws.unacked = 0;
    s.sockets.add(ws);
    send(ws, { t: 'ready', attached });
    const snapshot = s.serializer.serialize();
    if (snapshot) sendOutput(ws, Buffer.from(snapshot, 'utf8'));

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (s.exited) return;
      if (msg.t === 'in' && typeof msg.d === 'string') s.pty.write(msg.d);
      else if (msg.t === 'resize') {
        const cols = clampDim(msg.cols, s.term.cols);
        const rows = clampDim(msg.rows, s.term.rows);
        s.pty.resize(cols, rows);
        s.term.resize(cols, rows);
      } else if (msg.t === 'ack' && Number.isFinite(msg.n)) {
        ws.unacked = Math.max(0, ws.unacked - msg.n);
        updateFlow(s);
      } else if (msg.t === 'kill') s.pty.kill();
    });
    ws.on('close', () => {
      s.sockets.delete(ws);
      if (!s.exited) updateFlow(s);
    });
  }

  function onHello(ws, msg) {
    if (!msg || msg.t !== 'hello' || !tokenMatches(token, msg.token)) {
      send(ws, { t: 'error', msg: 'invalid terminal token' });
      return ws.close(4001);
    }
    const id = msg.id;
    const mode = MODES.has(msg.mode) ? msg.mode : null;
    if (typeof id !== 'string' || !UUID_RE.test(id) || !mode) {
      send(ws, { t: 'error', msg: 'invalid session id or mode' });
      return ws.close(4002);
    }
    const cols = clampDim(msg.cols, 80);
    const rows = clampDim(msg.rows, 24);

    const existing = sessions.get(id);
    if (existing) return attach(ws, existing, true);

    if (mode === 'auto' && o.isLiveElsewhere(id)) {
      send(ws, { t: 'live' });
      return ws.close(1000);
    }
    if (sessions.size >= config.maxSessions) {
      send(ws, { t: 'error', msg: `${config.maxSessions} terminals are open; end one first` });
      return ws.close(4003);
    }
    const cwd = o.resolveCwd(id);
    if (mode !== 'shell' && cwd === null) {
      send(ws, { t: 'error', msg: 'unknown session' });
      return ws.close(4004);
    }
    let s;
    try {
      s = spawnSession(id, mode === 'auto' ? 'resume' : mode, cwd, cols, rows);
    } catch (e) {
      send(ws, { t: 'error', msg: `failed to start the shell: ${e.message}` });
      return ws.close(4005);
    }
    attach(ws, s, false);
  }

  function handleUpgrade(req, socket, head) {
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { pathname = ''; }
    if (pathname !== WS_PATH) return refuse(socket, '404 Not Found', 'no such endpoint');
    const reason = unavailableReason() || net.upgradeVerdict(req);
    if (reason) return refuse(socket, '403 Forbidden', reason);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const timer = setTimeout(() => ws.close(4001), HELLO_TIMEOUT_MS);
      ws.once('message', (raw, isBinary) => {
        clearTimeout(timer);
        let msg = null;
        if (!isBinary) { try { msg = JSON.parse(raw.toString()); } catch { /* treated as bad hello */ } }
        onHello(ws, msg);
      });
      ws.on('error', () => {});
    });
  }

  function clientConfig() {
    return {
      available: !unavailableReason(),
      fontFamily: config.fontFamily,
      fontSize: config.fontSize,
      scrollback: config.scrollback,
      maxSessions: config.maxSessions,
    };
  }

  function list() {
    return [...sessions.values()].map((s) => ({
      id: s.id, mode: s.mode, cwd: s.cwd, pid: s.pty.pid, clients: s.sockets.size, startedAt: s.startedAt,
    }));
  }

  // Same token as the WebSocket hello: ending a terminal kills a running claude process.
  function end(id, providedToken) {
    if (!tokenMatches(token, providedToken)) return 'auth';
    const s = sessions.get(id);
    if (!s) return 'not-found';
    s.pty.kill();
    return null;
  }

  function shutdown() {
    for (const s of sessions.values()) {
      try { s.pty.kill(); } catch { /* already gone */ }
    }
    sessions.clear();
  }

  return { token, handleUpgrade, clientConfig, list, end, shutdown, unavailableReason };
}

module.exports = { createTerminalService, readTerminalConfig, shellArgs };

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
const { isContained } = require('./contain');
const priority = require('./priority');

const WS_PATH = '/api/terminal/ws';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = new Set(['auto', 'resume', 'fork', 'shell', 'new', 'pick']);
const PICK_POLL_MS = 1000;
// How long before the PTY a registry entry may claim to have started (clock skew between the two).
const PICK_START_SLACK_MS = 2000;
// A new session's name and worktree reach a shell command line, so they are held to a
// charset that needs no escaping beyond plain quotes. The first character is never '-'.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const WORKTREE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODELS = new Set(['fable', 'opus', 'sonnet', 'haiku']);
// Extra claude args reach the command line inside plain quotes (quoteArg), so a character
// that ends or expands those quotes in any of the shells is refused.
// biome-ignore lint/suspicious/noControlCharactersInRegex: refuses control characters on purpose
const EXTRA_ARG_RE = /^[^\x00-\x1f\x7f'"%]*$/;
const MAX_EXTRA_ARGS = 64;
const MAX_EXTRA_ARG = 4096;
// cck sets these itself, or they would start something other than a new session.
const OWNED_FLAGS = new Set([
  '--session-id', '-n', '--name', '--model', '-w', '--worktree',
  '-r', '--resume', '-c', '--continue', '--fork-session', '-p', '--print',
]);
const MAX_PROMPT = 32 * 1024;
const PROMPT_QUIET_MS = 400;
// Watermarks from https://xtermjs.org/docs/guides/flowcontrol/ — pause the PTY while a
// client lags, so a runaway process cannot grow the socket buffer without bound.
const HIGH_WATER = 128 * 1024;
const LOW_WATER = 16 * 1024;
const HELLO_TIMEOUT_MS = 5000;
const BOOST_TRIES = 30;
const MAX_PAYLOAD = 1024 * 1024;
// Each restored terminal is a full claude process, so they start one at a time.
const RESTORE_GAP_MS = 2000;
// The hub stops cck with `taskkill /f /t`, which can deliver the PTY exits to cck a moment
// before cck itself dies. The delay keeps that teardown out of the saved list.
const SAVE_DELAY_MS = 1000;
// A fork runs under its parent's id until claude names the new one, so it has no id to resume.
const RESTORABLE_MODES = new Set(['resume', 'new']);
// The size of a PTY no browser has attached to yet; the first attach resizes it.
const HEADLESS_COLS = 120;
const HEADLESS_ROWS = 32;
// The hub hands its children PORT=0 and friends; a dev server started in the terminal
// would otherwise bind a random port, and a nested `claude` would think it runs inside one.
const STRIP_ENV = [
  'PORT', 'HOST', 'ALLOWED_HOSTS', 'CLAUDE_HUB', 'HUB_URL',
  'CCK_TERMINAL', 'CCK_TERMINAL_TOKEN', 'CCK_TERMINAL_SHELL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
  // A cck started from inside Claude Code carries these; a claude that inherits them runs as that
  // session's child and writes no live-session registry entry, which the resume picker relies on.
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH',
  // A cck started inside tmux passes these on, and claude then lists its session under a tmux pane it is not in.
  'TMUX', 'TMUX_PANE',
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
    shell:
      getArgValue?.('terminal-shell') ||
      env.CCK_TERMINAL_SHELL ||
      (typeof cfg.shell === 'string' && cfg.shell) ||
      null,
    maxSessions: posInt(cfg.maxSessions, 30),
    fontFamily: typeof cfg.fontFamily === 'string' && cfg.fontFamily ? cfg.fontFamily : null,
    fontSize: posInt(cfg.fontSize, 13),
    scrollback: posInt(cfg.scrollback, 5000),
    noFlicker: cfg.noFlicker !== false,
    restore: cfg.restore !== false,
  };
}

// Git for Windows ships two bash.exe files; bin\ is the launcher that sets up the MSYS environment.
const GIT_BASH_RE = /[\\/]Git[\\/](usr[\\/])?bin[\\/]bash\.exe$/i;

function shellFamily(shell) {
  if (GIT_BASH_RE.test(shell)) return 'gitbash';
  const base = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') return 'pwsh';
  if (base === 'cmd') return 'cmd';
  return 'posix';
}

function findGitBash(which, env) {
  const git = which('git');
  const candidates = [
    git && path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// `value` is `gitbash`, a program name looked up on PATH (pwsh, cmd, zsh), or a path.
// Unset means the platform default. Throws when the named shell cannot be found.
function resolveShell(value, which, platform = process.platform, env = process.env) {
  if (!value) {
    if (platform === 'win32') return which('pwsh') || which('powershell') || 'powershell.exe';
    return env.SHELL || '/bin/sh';
  }
  // which() appends PATHEXT itself, so a bare `cmd.exe` would never match.
  const name = /[\\/]/.test(value) ? value : value.replace(/\.exe$/i, '');
  const found = name.toLowerCase() === 'gitbash' ? findGitBash(which, env) : which(name);
  if (!found) throw new Error(`terminal shell "${value}" not found`);
  return found;
}

// claudeArgs is null for a plain shell. Its items are fixed flags, a validated UUID, or
// values that passed NAME_RE / WORKTREE_RE / EXTRA_ARG_RE, so plain quoting is enough to
// keep a space from splitting an argument and nothing can break out of the quotes.
function quoteArg(arg, family) {
  if (/^[A-Za-z0-9._-]+$/.test(arg)) return arg;
  return family === 'cmd' ? `"${arg}"` : `'${arg}'`;
}

function shellArgs(shell, claudeArgs) {
  const family = shellFamily(shell);
  if (!claudeArgs) return family === 'pwsh' ? ['-NoLogo'] : family === 'gitbash' ? ['--login', '-i'] : [];
  const cmd = ['claude', ...claudeArgs].map((a) => quoteArg(a, family)).join(' ');
  if (family === 'pwsh') return ['-NoLogo', '-NoExit', '-Command', cmd];
  if (family === 'cmd') return ['/k', cmd];
  if (family === 'gitbash') return ['--login', '-i', '-c', `${cmd}; exec bash --login -i`];
  // $0 is the shell itself (the argument after the script), so exiting claude
  // lands in an interactive shell of the same kind.
  return ['-c', `${cmd}; exec "$0"`, shell];
}

function claudeArgsFor(mode, id, spec) {
  if (mode === 'shell') return null;
  if (mode === 'fork') return ['--resume', id, '--fork-session'];
  if (mode === 'pick') return ['--resume'];
  if (mode === 'new') {
    const args = ['--session-id', id, ...(spec.extraArgs || [])];
    if (spec.name) args.push('--name', spec.name);
    if (spec.model) args.push('--model', spec.model);
    // Last, because its value is optional and a following flag must not be taken for it.
    if (spec.worktree === true) args.push('-w');
    else if (spec.worktree) args.push('-w', spec.worktree);
    return args;
  }
  return ['--resume', id];
}

function extraArgsError(args) {
  if (!Array.isArray(args) || args.length > MAX_EXTRA_ARGS) return `claude args (at most ${MAX_EXTRA_ARGS})`;
  for (const a of args) {
    if (typeof a !== 'string' || a.length > MAX_EXTRA_ARG || !EXTRA_ARG_RE.test(a)) return 'claude arg: no quotes, % or control characters';
    const flag = a.split('=')[0];
    if (OWNED_FLAGS.has(flag)) return `claude arg: cck sets ${flag}`;
  }
  return null;
}

// Returns the new-session options from a hello, or a string naming the bad field.
function parseNewSpec(msg) {
  if (typeof msg.cwd !== 'string' || !msg.cwd) return 'folder';
  const name = typeof msg.name === 'string' ? msg.name.trim() : '';
  if (name && !NAME_RE.test(name)) return 'name';
  const worktree = msg.worktree ?? false;
  if (typeof worktree !== 'boolean' && !(typeof worktree === 'string' && WORKTREE_RE.test(worktree))) return 'worktree name';
  const model = msg.model || null;
  if (model && !MODELS.has(model)) return 'model';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ESC so a prompt cannot carry terminal sequences
  const prompt = typeof msg.prompt === 'string' ? msg.prompt.replace(/\x1b/g, '').trim() : '';
  if (prompt.length > MAX_PROMPT) return 'prompt';
  const extraArgs = msg.extraArgs ?? [];
  const bad = extraArgsError(extraArgs);
  if (bad) return bad;
  return { cwd: msg.cwd, name: name || null, worktree, model, prompt: prompt || null, extraArgs };
}

function samePath(a, b) {
  return isContained(a, b) && isContained(b, a);
}

// The registry entry of the claude a pick PTY started: same folder, started no earlier than the PTY.
function findPickProcess(live, pty, claimed) {
  return live.find(
    (l) => l.pid && !claimed.has(l.pid) && l.startedAt >= pty.startedAt - PICK_START_SLACK_MS && samePath(l.cwd, pty.cwd),
  )?.pid;
}

function screenText(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n');
}

// Claude Code keeps .claude.json beside ~/.claude when CLAUDE_CONFIG_DIR is unset but
// inside the dir when set, so the default dir must stay unset, not be spelled out.
// CCK_URL pins the CLI and the postman to this board: two boards on one config dir share
// one server.json, and the last one started owns it.
function ptyEnv({ claudeDir, isDefaultDir, noFlicker, cckUrl }) {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  if (isDefaultDir) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = claudeDir;
  if (cckUrl) env.CCK_URL = cckUrl;
  else delete env.CCK_URL;
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

// Destroying right after write can reset the connection before the response is sent (seen on Windows).
function refuse(socket, status, reason) {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${reason}\n`);
}

/**
 * @param {object} o
 * @param {ReturnType<typeof readTerminalConfig>} o.config
 * @param {{EXPOSED: boolean, upgradeVerdict: (req: any) => string|null}} o.net
 * @param {string} o.claudeDir
 * @param {boolean} o.isDefaultDir
 * @param {(id: string) => string|null} o.resolveCwd  null = unknown session
 * @param {(id: string, exceptPid?: number) => boolean} o.isLiveElsewhere
 * @param {(dir: string) => boolean} o.isAllowedFolder  where a new session may start
 * @param {() => {pid: number|null, sessionId: string, cwd: string|null, startedAt: number}[]} o.liveSessions
 *   claude's live-session registry, read fresh
 * @param {(cmd: string) => string|null} o.which
 * @param {string} [o.token]
 * @param {() => void} [o.onChange]  a terminal started, ended or moved to another session id
 * @param {() => {sessions?: string[]}|null} [o.load]  the saved list, read when config.restore is on
 * @param {(data: {sessions: string[]}) => void} [o.save]  the session ids to resume on the next start
 * @param {object} [o.pty]  stands in for @lydell/node-pty in tests
 */
function createTerminalService(o) {
  const { config, net } = o;
  if (config.enabled) priority.raise();
  const token = o.token || crypto.randomBytes(32).toString('hex');
  const sessions = new Map();
  let pty = null;
  let loadError = null;
  let wss = null;
  let Headless = null;
  let Serialize = null;
  let shell = null;
  let shuttingDown = false;
  let saveTimer = null;
  let lastSaved = null;
  const saveDelayMs = o.saveDelayMs ?? SAVE_DELAY_MS;
  const restoreGapMs = o.restoreGapMs ?? RESTORE_GAP_MS;
  // Read before any terminal starts, so the first save keeps the ids still waiting to restore.
  const saved = config.restore ? o.load?.()?.sessions : null;
  const restoreQueue = Array.isArray(saved) ? saved.filter((id) => typeof id === 'string' && UUID_RE.test(id)) : [];

  // Lazy and optional: a missing prebuilt or shell must hide the feature, not crash cck.
  function load() {
    if (pty || loadError) return !!pty;
    try {
      shell = resolveShell(config.shell, o.which);
    } catch (e) {
      loadError = e.message;
      return false;
    }
    try {
      pty = o.pty || require('@lydell/node-pty');
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

  function changed() {
    scheduleSave();
    o.onChange?.();
  }

  function scheduleSave() {
    if (!o.save || shuttingDown || saveTimer) return;
    saveTimer = setTimeout(saveState, saveDelayMs);
    saveTimer.unref();
  }

  function saveState() {
    saveTimer = null;
    const ids = new Set(restoreQueue);
    for (const s of sessions.values()) if (!s.ended && RESTORABLE_MODES.has(s.mode)) ids.add(s.id);
    const data = { sessions: [...ids] };
    const json = JSON.stringify(data);
    if (json === lastSaved) return;
    lastSaved = json;
    o.save(data);
  }

  // Starts `claude --resume` for each terminal open when cck last stopped, headless like
  // startNew. A session that runs elsewhere or lost its transcript is dropped.
  function restore() {
    if (!restoreQueue.length || unavailableReason()) return;
    console.log(`Restoring ${restoreQueue.length} terminal(s)`);
    const next = () => {
      while (restoreQueue.length && !shuttingDown) {
        const id = restoreQueue.shift();
        if (sessions.has(id) || o.isLiveElsewhere(id)) continue;
        const r = start(id, 'resume', {}, HEADLESS_COLS, HEADLESS_ROWS);
        if (!r.error) break;
        console.log(`Could not restore terminal ${id}: ${r.error}`);
      }
      scheduleSave();
      if (restoreQueue.length && !shuttingDown) setTimeout(next, restoreGapMs).unref();
    };
    next();
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

  // Waits for claude to turn on bracketed paste (its input box is live), then for the
  // screen to settle. A folder-trust question also takes input, and Enter there would
  // answer it, so the prompt waits for as long as that question is on screen.
  function bracketed(text) {
    return `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`;
  }

  function onTrustScreen(s) {
    return /\btrust\b/i.test(screenText(s.term));
  }

  function queuePrompt(s, prompt) {
    let armed = false;
    let timer = null;
    const text = bracketed(prompt);
    s.onOutput = (data) => {
      if (!armed && data.includes('\x1b[?2004h')) armed = true;
      if (!armed) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (s.exited || onTrustScreen(s)) return;
        s.onOutput = null;
        s.pty.write(text);
        setTimeout(() => { if (!s.exited) s.pty.write('\r'); }, 100);
      }, PROMPT_QUIET_MS);
    };
  }

  // The process a viewer types into: claude, found through its registry entry, or the shell.
  function inputPid(s) {
    if (s.mode === 'shell') return s.pty.pid;
    if (s.claudePid || s.mode === 'pick') return s.claudePid;
    const live = o.liveSessions();
    const own = live.find((l) => l.pid && l.sessionId === s.id && l.startedAt >= s.startedAt - PICK_START_SLACK_MS);
    if (own || s.mode !== 'fork') {
      s.claudePid = own?.pid;
      return s.claudePid;
    }
    const claimed = new Set([...sessions.values()].map((x) => x.claudePid).filter(Boolean));
    s.claudePid = findPickProcess(live, s, claimed);
    return s.claudePid;
  }

  // claude writes its registry entry a moment after it starts, so the pid is polled for.
  function syncBoost(s) {
    const want = s.sockets.size > 0 && !s.exited;
    if (want && !s.boost) {
      if (s.boostTimer) return;
      let tries = 0;
      const tryBoost = () => {
        const pid = inputPid(s);
        if (!pid && ++tries < BOOST_TRIES) return;
        clearInterval(s.boostTimer);
        s.boostTimer = null;
        if (!pid) return;
        const before = priority.raise(pid);
        s.boost = { pid, before };
      };
      s.boostTimer = setInterval(tryBoost, PICK_POLL_MS);
      tryBoost();
    } else if (!want) {
      clearInterval(s.boostTimer);
      s.boostTimer = null;
      if (s.boost && s.boost.before !== null && !s.exited) priority.restore(s.boost.pid, s.boost.before);
      s.boost = null;
    }
  }

  function spawnSession(id, mode, cwdCandidate, cols, rows, spec, extraEnv) {
    const cwd = cwdCandidate && fs.existsSync(cwdCandidate) ? cwdCandidate : os.homedir();
    const env = { ...ptyEnv({ claudeDir: o.claudeDir, isDefaultDir: o.isDefaultDir, noFlicker: config.noFlicker, cckUrl: o.serverUrl?.() }), ...extraEnv };
    // Git Bash's login profile cds to $HOME unless this is set.
    if (shellFamily(shell) === 'gitbash') env.CHERE_INVOKING = '1';
    const proc = pty.spawn(shell, shellArgs(shell, claudeArgsFor(mode, id, spec)), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
    const term = new Headless({ cols, rows, scrollback: config.scrollback, allowProposedApi: true });
    const serializer = new Serialize();
    term.loadAddon(serializer);
    const s = {
      id, mode, cwd, pty: proc, term, serializer, sockets: new Set(), exited: false, ended: false, paused: false, startedAt: Date.now(),
      name: spec?.name || null, worktree: spec?.worktree || false, onOutput: null,
    };
    if (spec?.prompt) queuePrompt(s, spec.prompt);
    if (mode === 'pick') watchPick(s);

    proc.onData((data) => {
      term.write(data);
      if (s.onOutput) s.onOutput(data);
      if (!s.sockets.size) return;
      const buf = Buffer.from(data, 'utf8');
      for (const ws of s.sockets) if (ws.readyState === 1) sendOutput(ws, buf);
      updateFlow(s);
    });
    proc.onExit(({ exitCode }) => {
      s.exited = true;
      clearInterval(s.pickTimer);
      clearInterval(s.boostTimer);
      if (sessions.get(s.id) === s) sessions.delete(s.id);
      o.onExit?.(s.id);
      if (!s.ended) changed();
      for (const ws of s.sockets) {
        send(ws, { t: 'exit', code: exitCode, ended: s.ended });
        ws.close(1000);
      }
      term.dispose();
    });
    sessions.set(id, s);
    priority.raiseConsoleHosts();
    changed();
    return s;
  }

  // `claude --resume` opens its own picker, so the session is unknown until the user picks.
  // Claude's registry entry keeps its pid and swaps its sessionId to the picked one; the entry
  // is found by folder and start time, and the pick shows as an id with a transcript behind it.
  function watchPick(s) {
    s.pickTimer = setInterval(() => {
      const live = o.liveSessions();
      const entry = s.claudePid && live.find((l) => l.pid === s.claudePid);
      if (!entry) {
        // Claude left the picker without a pick and the PTY fell back to its shell.
        if (s.claudePid) return clearInterval(s.pickTimer);
        const claimed = new Set([...sessions.values()].map((x) => x.claudePid).filter(Boolean));
        s.claudePid = findPickProcess(live, s, claimed);
        return;
      }
      const picked = entry.sessionId;
      if (picked === s.id || o.resolveCwd(picked) === null) return;
      clearInterval(s.pickTimer);
      // Two claude processes on one session write the same transcript. When cck already runs it,
      // the pick is ended and its viewers move to that terminal; the sockets leave first so no
      // exit reaches them.
      if (sessions.has(picked)) {
        const sockets = [...s.sockets];
        s.sockets.clear();
        kill(s);
        for (const ws of sockets) send(ws, { t: 'rekey', id: picked, duplicate: true });
        return;
      }
      const elsewhere = o.isLiveElsewhere(picked, s.claudePid);
      sessions.delete(s.id);
      s.id = picked;
      s.mode = 'resume';
      sessions.set(picked, s);
      changed();
      for (const ws of s.sockets) send(ws, { t: 'rekey', id: picked, elsewhere });
    }, PICK_POLL_MS);
  }

  function attach(ws, s, attached) {
    ws.unacked = 0;
    s.sockets.add(ws);
    syncBoost(s);
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
      } else if (msg.t === 'kill') kill(s);
    });
    ws.on('close', () => {
      s.sockets.delete(ws);
      syncBoost(s);
      if (!s.exited) updateFlow(s);
    });
  }

  function onHello(ws, msg) {
    if (!msg || msg.t !== 'hello' || !tokenMatches(token, msg.token)) {
      send(ws, { t: 'error', msg: 'The terminal token is out of date. Reload the hub window.' });
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

    // An ended PTY stays in the map until its process exits; a hello for its id starts a new one.
    const existing = sessions.get(id);
    if (existing && !existing.ended) return attach(ws, existing, true);

    if (mode === 'auto' && o.isLiveElsewhere(id)) {
      send(ws, { t: 'live' });
      return ws.close(1000);
    }
    const r = start(id, mode, msg, cols, rows);
    if (r.error) {
      send(ws, { t: 'error', msg: r.error });
      return ws.close(r.code);
    }
    attach(ws, r.session, false);
  }

  // The admission rules shared by the socket hello and startNew. A refusal carries both a
  // WebSocket close code and an HTTP status, so each caller maps it its own way.
  function start(id, mode, msg, cols, rows, extraEnv) {
    if (sessions.size >= config.maxSessions) {
      return { code: 4003, status: 429, error: `${config.maxSessions} terminals are open; end one first` };
    }
    const known = o.resolveCwd(id);
    let cwd = known;
    let spec = null;
    if (mode === 'new' || mode === 'pick') {
      if (mode === 'new') {
        spec = parseNewSpec(msg);
        if (typeof spec === 'string') return { code: 4002, status: 400, error: `invalid ${spec}` };
      }
      if (known !== null) return { code: 4006, status: 409, error: 'session id already in use' };
      if (typeof msg.cwd !== 'string' || !o.isAllowedFolder(msg.cwd)) {
        return { code: 4004, status: 403, error: 'folder is not a known project or a folder picked in this run' };
      }
      cwd = msg.cwd;
    } else if (mode !== 'shell' && known === null) {
      return { code: 4004, status: 404, error: 'unknown session' };
    }
    try {
      return { session: spawnSession(id, mode === 'auto' ? 'resume' : mode, cwd, cols, rows, spec, extraEnv) };
    } catch (e) {
      return { code: 4005, status: 500, error: `failed to start the shell: ${e.message}` };
    }
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

  // kill() returns before the process is gone, so an ended session leaves list() at once.
  function kill(s) {
    s.ended = true;
    s.pty.kill();
    changed();
  }

  function list() {
    return [...sessions.values()].filter((s) => !s.ended).map((s) => ({
      id: s.id, mode: s.mode, cwd: s.cwd, pid: s.pty.pid, clients: s.sockets.size, startedAt: s.startedAt,
      name: s.name, worktree: s.worktree,
    }));
  }

  function claudePids() {
    const out = {};
    for (const s of sessions.values()) {
      if (s.ended || s.exited || s.mode === 'shell') continue;
      const pid = inputPid(s);
      if (pid) out[s.id] = pid;
    }
    return out;
  }

  function isRunning(id) {
    const s = sessions.get(id);
    return !!s && !s.ended;
  }

  function authorized(providedToken) {
    return tokenMatches(token, providedToken);
  }

  // Same token as the WebSocket hello: ending a terminal kills a running claude process.
  function end(id, providedToken) {
    if (!authorized(providedToken)) return 'auth';
    const s = sessions.get(id);
    if (!s) return 'not-found';
    kill(s);
    return null;
  }

  // A 'new' session for a caller with no socket. The PTY runs headless until a browser
  // attaches, and a later attach resizes it.
  function startNew(msg, extraEnv) {
    const reason = unavailableReason();
    if (reason) return { status: 403, error: reason };
    if (msg.id != null && !(typeof msg.id === 'string' && UUID_RE.test(msg.id))) return { status: 400, error: 'invalid session id' };
    const r = start(msg.id || crypto.randomUUID(), 'new', msg, HEADLESS_COLS, HEADLESS_ROWS, extraEnv);
    return r.error ? r : { id: r.session.id, cwd: r.session.cwd };
  }

  // Pastes into claude's input box and stops there: Enter would also submit whatever the
  // user had half-typed, and over a permission dialog it would answer it. A fork runs under
  // a new session id, so its terminal id does not name the session the text is for. A
  // pending queued prompt owns the input box until it is sent.
  function paste(id, text) {
    const s = sessions.get(id);
    if (!s || s.ended || s.exited || s.onOutput || s.mode === 'shell' || s.mode === 'fork') return false;
    if (onTrustScreen(s)) return false;
    s.pty.write(bracketed(text));
    return true;
  }

  function shutdown() {
    shuttingDown = true;
    clearTimeout(saveTimer);
    for (const s of sessions.values()) {
      try { s.pty.kill(); } catch { /* already gone */ }
    }
    sessions.clear();
  }

  return { token, handleUpgrade, clientConfig, list, claudePids, isRunning, end, authorized, startNew, paste, restore, shutdown, unavailableReason };
}

module.exports = { createTerminalService, readTerminalConfig, ptyEnv, shellArgs, resolveShell, claudeArgsFor, parseNewSpec, findPickProcess, tokenMatches };

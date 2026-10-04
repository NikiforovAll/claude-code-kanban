'use strict';

// The terminal's own process, forked by lib/terminal-client.js. It runs the terminal
// service unchanged; cck reaches it only over the IPC channel and ends it by closing that.

const { createTerminalService } = require('./terminal');
const { readLiveSessions, isSessionLive } = require('./live-sessions');
const { whichSync } = require('./open-editor');

let service = null;
let serverUrl = null;
let lastState = null;
let nextAsk = 0;
const asks = new Map();

function send(msg) {
  if (process.connected) process.send(msg);
}

function ask(op, arg) {
  return new Promise((resolve) => {
    const id = ++nextAsk;
    asks.set(id, resolve);
    send({ t: 'ask', id, op, arg });
  });
}

// The service reports every attach and detach too; cck needs only a change of ids or reason.
function pushState() {
  const state = { t: 'state', reason: service.unavailableReason(), ids: service.list().map((s) => s.id) };
  const key = JSON.stringify(state);
  if (key === lastState) return;
  lastState = key;
  send(state);
}

function init(msg) {
  serverUrl = msg.serverUrl;
  const liveSessions = () => readLiveSessions(msg.sessionsDir);
  service = createTerminalService({
    config: msg.config,
    // cck checked Host, Origin and exposure before it handed the socket over.
    net: { EXPOSED: false, upgradeVerdict: () => null },
    claudeDir: msg.claudeDir,
    isDefaultDir: msg.isDefaultDir,
    token: msg.token,
    serverUrl: () => serverUrl,
    which: whichSync,
    liveSessions,
    isLiveElsewhere: (id, exceptPid) => isSessionLive(liveSessions(), id, exceptPid),
    resolveCwd: (id) => ask('resolveCwd', id),
    isAllowedFolder: (dir) => ask('isAllowedFolder', dir),
    load: () => msg.saved,
    save: (data) => send({ t: 'save', data }),
    onChange: pushState,
    onExit: (id) => send({ t: 'exit', id }),
  });
  pushState();
}

const CALLS = {
  startNew: (msg, extraEnv) => service.startNew(msg, extraEnv),
  end: (id, token) => service.end(id, token),
  paste: (id, text) => service.paste(id, text),
  restore: () => service.restore(),
  sessions: () => service.list(),
  claudePids: () => service.claudePids(),
};

async function call(msg) {
  try {
    send({ t: 'reply', id: msg.id, value: await CALLS[msg.op](...msg.args) });
  } catch (e) {
    send({ t: 'reply', id: msg.id, error: e.message });
  }
}

process.on('message', (msg, socket) => {
  if (msg.t === 'init') init(msg);
  else if (msg.t === 'port') serverUrl = msg.url;
  else if (msg.t === 'upgrade') {
    if (!socket) return;
    service.handleUpgrade({ method: msg.method, url: msg.url, headers: msg.headers }, socket, Buffer.from(msg.head, 'base64'));
  } else if (msg.t === 'call') call(msg);
  else if (msg.t === 'answer') {
    asks.get(msg.id)?.(msg.value);
    asks.delete(msg.id);
  }
});

// cck is gone, so no claude may outlive the board that started it.
process.on('disconnect', () => {
  service?.shutdown();
  process.exit(0);
});

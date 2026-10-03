const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTerminalFrame, claimSig, isClaimed, parentOriginOf, tailOf } = require('../public/terminal-frame.js');

const BOARD = 'http://localhost:3541';
const app = readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function appFunction(name) {
  const src = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(app)[0];
  const context = vm.createContext({});
  vm.runInContext(src, context);
  return context[name];
}

const press = (init) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init });

describe('terminalFrameOrigin', () => {
  const origin = appFunction('terminalFrameOrigin');
  const at = (url) => {
    const u = new URL(url);
    return origin({ protocol: u.protocol, hostname: u.hostname, port: u.port, origin: u.origin });
  };

  it('picks another loopback name so the frame is another site', () => {
    assert.equal(at('http://localhost:3541/'), 'http://[::1]:3541');
    assert.equal(at('http://127.0.0.1:3741/'), 'http://localhost:3741');
  });

  it('keeps any other host', () => {
    assert.equal(at('http://[::1]:3541/'), 'http://[::1]:3541');
    assert.equal(at('http://192.168.1.5:3541/'), 'http://192.168.1.5:3541');
  });
});

describe('parentOriginOf', () => {
  it('reads the board origin from the fragment', () => {
    assert.equal(parentOriginOf(`#p=${encodeURIComponent(BOARD)}`), BOARD);
    assert.equal(parentOriginOf(`#x=1&p=${encodeURIComponent(`${BOARD}/path`)}`), BOARD);
  });

  it('gives null without a valid origin', () => {
    assert.equal(parentOriginOf(''), null);
    assert.equal(parentOriginOf('#p=not%20a%20url'), null);
  });
});

describe('key claims', () => {
  it('matches a press by code or, for a code-less claim, by key', () => {
    const claims = new Set([
      claimSig(press({ ctrlKey: true, altKey: true, key: 's', code: 'KeyS' })),
      claimSig(press({ ctrlKey: true, altKey: true, key: 'p', code: '' })),
    ]);
    const claimed = (e) => isClaimed(claims, press(e));
    assert.equal(claimed({ ctrlKey: true, altKey: true, key: 'ß', code: 'KeyS' }), true);
    assert.equal(claimed({ ctrlKey: true, altKey: true, key: 'P', code: 'KeyR' }), true);
    assert.equal(claimed({ ctrlKey: true, key: 's', code: 'KeyS' }), false);
    assert.equal(claimed({ ctrlKey: true, altKey: true, key: 'x', code: 'KeyX' }), false);
  });
});

describe('terminalClaims', () => {
  const src = [
    /^const TERMINAL_PROBE_KEYS = [\s\S]*?^\];/m.exec(app)[0],
    /^function terminalClaims\(\) \{[\s\S]*?^\}/m.exec(app)[0],
  ].join('\n');

  function claimsFor(shortcut) {
    const context = vm.createContext({ terminalShortcut: shortcut, hub: { forwards: () => false } });
    vm.runInContext(src, context);
    return new Set(context.terminalClaims().map(claimSig));
  }

  it('leaves Ctrl+_ to the terminal while Ctrl+- zooms', () => {
    const zoom = (e) => (e.ctrlKey && !e.altKey && (e.key === '-' || e.key === '+' || e.key === '=') ? 1 : null);
    const claims = claimsFor(zoom);
    const claimed = (e) => isClaimed(claims, press(e));
    assert.equal(claimed({ ctrlKey: true, key: '-', code: 'Minus' }), true);
    assert.equal(claimed({ ctrlKey: true, shiftKey: true, key: '_', code: 'Minus' }), false);
    assert.equal(claimed({ ctrlKey: true, shiftKey: true, key: '+', code: 'Equal' }), true);
  });

  it('passes the probe flag to terminalShortcut', () => {
    const seen = [];
    claimsFor((e, probe) => {
      seen.push(probe);
      return null;
    });
    assert.ok(seen.length > 0 && seen.every((p) => p === true));
  });
});

describe('tailOf', () => {
  const buffer = (lines) => ({
    length: lines.length,
    getLine: (i) => ({ translateToString: () => lines[i] }),
  });

  it('gives the last lines and skips trailing blank rows', () => {
    assert.equal(tailOf(buffer(['a', 'b', 'c', '', '']), 2), 'b\nc');
    assert.equal(tailOf(buffer(['', '']), 3), '');
    assert.equal(tailOf(null, 3), '');
  });
});

describe('createTerminalFrame', () => {
  function stubWindow(extra = {}) {
    const posted = [];
    const listeners = {};
    const docListeners = {};
    const parent = { postMessage: (message, origin) => posted.push({ message, origin }) };
    const terms = [];
    class Terminal {
      constructor(options) {
        this.options = { ...options };
        this.cols = 80;
        this.rows = 24;
        this.unicode = {};
        this.parser = { registerOscHandler() {} };
        this.textarea = { addEventListener() {} };
        terms.push(this);
      }
      loadAddon() {}
      open() {}
      attachCustomKeyEventHandler(fn) {
        this.keyFilter = fn;
      }
      onData() {}
      onResize() {}
      focus() {
        this.focused = true;
      }
      hasSelection() {
        return false;
      }
    }
    const win = {
      parent,
      location: { hash: `#p=${encodeURIComponent(BOARD)}`, protocol: 'http:', host: '127.0.0.1:3541' },
      document: {
        getElementById: () => ({ offsetWidth: 0, offsetHeight: 0 }),
        documentElement: { style: { setProperty() {} } },
        addEventListener: (type, fn) => {
          docListeners[type] = fn;
        },
      },
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      Terminal,
      FitAddon: { FitAddon: class {} },
      Unicode11Addon: { Unicode11Addon: class {} },
      WebglAddon: {
        WebglAddon: class {
          onContextLoss() {}
        },
      },
      ResizeObserver: class {
        observe() {}
      },
      requestAnimationFrame: () => 0,
      setTimeout: () => 0,
      clearTimeout() {},
      navigator: {},
      ...extra,
    };
    createTerminalFrame(win);
    const send = (data, from = {}) =>
      listeners.message({ source: from.source ?? parent, origin: from.origin ?? BOARD, data });
    return { posted, terms, send, docListeners, win };
  }

  const init = { type: 'cck-term:init', fontFamily: 'mono', fontSize: 13, scrollback: 1000, themeOptions: { theme: {} } };

  it('ignores messages from anything but the board', () => {
    const w = stubWindow();
    w.send(init, { origin: 'http://evil.example' });
    w.send(init, { source: {} });
    assert.equal(w.terms.length, 0);
    w.send(init);
    assert.equal(w.terms.length, 1);
    assert.deepEqual(
      w.posted.map((p) => [p.message.type, p.origin]),
      [
        ['cck-term:loaded', BOARD],
        ['cck-term:term', BOARD],
      ],
    );
  });

  it('hands a claimed key to the board and keeps the rest', () => {
    const w = stubWindow();
    w.send(init);
    w.send({ type: 'cck-term:claims', keys: [press({ ctrlKey: true, key: '`', code: 'Backquote' })] });
    const term = w.terms[0];
    let prevented = false;
    const ev = (e) => ({ type: 'keydown', preventDefault: () => (prevented = true), ...press(e) });
    assert.equal(term.keyFilter(ev({ ctrlKey: true, key: '`', code: 'Backquote' })), false);
    assert.ok(prevented);
    assert.deepEqual(w.posted.at(-1).message, {
      type: 'cck-term:key',
      key: '`',
      code: 'Backquote',
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    });
    assert.equal(term.keyFilter(ev({ ctrlKey: true, key: 'l', code: 'KeyL' })), true);
  });

  it('hands back a hub key the way the SDK names it', () => {
    const { comboOf } = require('./vendor/claude-hub-sdk.js');
    const w = stubWindow({ ClaudeHub: { comboOf } });
    w.send(init);
    w.send({ type: 'cck-term:claims', keys: [], forward: ['ctrl+alt+a'] });
    const term = w.terms[0];
    const ev = (e) => ({ type: 'keydown', preventDefault() {}, ...press({ ctrlKey: true, altKey: true, ...e }) });
    assert.equal(term.keyFilter(ev({ key: 'a', code: 'KeyA' })), false);
    assert.equal(term.keyFilter(ev({ key: 'ф', code: 'KeyA' })), false);
    assert.equal(term.keyFilter(ev({ key: 'q', code: 'KeyA' })), true);
  });

  it('hands a claimed key to the board when the frame has focus but xterm does not', () => {
    const w = stubWindow();
    w.send(init);
    w.send({ type: 'cck-term:claims', keys: [press({ altKey: true, key: '`', code: 'Backquote' })] });
    const term = w.terms[0];
    const ev = (target) => ({ target, preventDefault() {}, ...press({ altKey: true, key: '`', code: 'Backquote' }) });
    w.docListeners.keydown(ev(term.textarea));
    assert.equal(w.posted.at(-1).message.type, 'cck-term:term');
    w.docListeners.keydown(ev({}));
    assert.equal(w.posted.at(-1).message.type, 'cck-term:key');
  });

  it('tells the board an open arrived before the socket connects', () => {
    const w = stubWindow();
    w.send(init);
    w.terms[0].write = () => {};
    w.terms[0].buffer = { active: null };
    const sockets = [];
    w.win.WebSocket = class {
      constructor(url) {
        this.url = url;
        sockets.push(this);
      }
    };
    w.send({ type: 'cck-term:open', socketId: 7, hello: {}, reset: false });
    assert.deepEqual(w.posted.at(-1).message, { type: 'cck-term:opening', socketId: 7 });
    assert.equal(sockets.length, 1);
  });
});

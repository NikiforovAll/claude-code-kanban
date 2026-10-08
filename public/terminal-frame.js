// The terminal half of the board's TERMINAL region. The board frames this page from the other
// loopback name (see terminalFrameOrigin in app.js), a different site, so Chrome runs it in its own
// renderer process: keys, output and acks never wait behind board work. The board keeps every decision
// (when to open, retries, prompts, focus); this page keeps xterm and the socket.
((root) => {
  'use strict';

  const ACK_BATCH_BYTES = 32 * 1024;
  const MSG = 'cck-term:';

  const modsOf = (e) =>
    [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'].filter(Boolean).join('+');

  // A claim names a key by its physical code, or by its character when the layout moves it. A press
  // that AltGr turns into a character (Polish AltGr+S is 'ś') is matched by its character only.
  function keySigs(e) {
    const mods = modsOf(e);
    return [
      e.code && !e.getModifierState?.('AltGraph') && `${mods}|c:${e.code}`,
      typeof e.key === 'string' && `${mods}|k:${e.key.toLowerCase()}`,
    ].filter(Boolean);
  }

  const claimSig = (c) => keySigs(c)[0];

  const isClaimed = (claims, e) => keySigs(e).some((s) => claims.has(s));

  // Hub keys are matched the way the SDK matches them, so a layout that moves a key agrees on both sides.
  const handsBack = (claims, forward, comboOf, e) => (!!comboOf && forward.has(comboOf(e))) || isClaimed(claims, e);

  function parentOriginOf(hash) {
    const m = /[#&]p=([^&]*)/.exec(hash || '');
    if (!m) return null;
    try {
      return new URL(decodeURIComponent(m[1])).origin;
    } catch (_) {
      return null;
    }
  }

  function tailOf(buf, count) {
    if (!buf) return '';
    const lines = [];
    for (let i = buf.length - 1; i >= 0 && lines.length < count; i--) {
      const text = buf.getLine(i)?.translateToString(true) ?? '';
      if (text.trim() || lines.length) lines.unshift(text);
    }
    return lines.join('\n');
  }

  function oscColor(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    return `rgb:${[0, 2, 4].map((i) => m[1].slice(i, i + 2).repeat(2)).join('/')}`;
  }

  function createTerminalFrame(win) {
    const doc = win.document;
    const parentOrigin = parentOriginOf(win.location.hash);
    const host = doc.getElementById('host');
    const state = {
      term: null,
      fit: null,
      webgl: null,
      ws: null,
      attached: false,
      ackPending: 0,
      ackTimer: null,
      claims: new Set(),
      forward: new Set(),
    };
    const comboOf = win.ClaudeHub?.comboOf;

    function up(t, data) {
      if (parentOrigin) win.parent.postMessage({ ...data, type: MSG + t }, parentOrigin);
    }

    function send(msg) {
      if (state.ws?.readyState === win.WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
    }

    // The WebGL renderer keeps its last frame and glyph atlas while the frame is 0×0, and comes back
    // showing stale cells or backgrounds with no text. xterm does not repaint on its own.
    function repaint() {
      const term = state.term;
      if (!term) return;
      try {
        state.webgl?.clearTextureAtlas();
      } catch (_) {}
      term.refresh(0, term.rows - 1);
    }

    // The fit addon measures 0×0 while the board's pane (or the hub's iframe) is display:none.
    function fit() {
      if (!state.fit || !host.offsetWidth || !host.offsetHeight) return;
      try {
        state.fit.fit();
      } catch (_) {}
    }

    function setBg(options) {
      doc.documentElement.style.setProperty('--bg', options?.theme?.background || '');
    }

    function applyTheme(options) {
      Object.assign(state.term.options, options);
      setBg(options);
      repaint();
    }

    function applyFont(size) {
      const term = state.term;
      term.options.fontSize = size;
      fit();
      doc.fonts
        ?.load(`${size}px ${term.options.fontFamily}`)
        .then(repaint)
        .catch(() => {});
    }

    function forwardClaimed(e) {
      if (!handsBack(state.claims, state.forward, comboOf, e)) return false;
      e.preventDefault();
      up('key', { key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
      return true;
    }

    function keyFilter(e) {
      if (e.type !== 'keydown') return true;
      if (forwardClaimed(e)) return false;
      const ctrlOnly = e.ctrlKey && !e.altKey && !e.metaKey;
      if (ctrlOnly && e.code === 'KeyC' && (e.shiftKey || state.term.hasSelection())) {
        e.preventDefault();
        win.navigator.clipboard?.writeText(state.term.getSelection()).catch(() => {});
        state.term.clearSelection();
        return false;
      }
      // The browser's own paste event reaches xterm's textarea.
      return !(ctrlOnly && e.code === 'KeyV');
    }

    function init(o) {
      if (state.term) return;
      const term = new win.Terminal({
        fontFamily: o.fontFamily,
        fontSize: o.fontSize,
        scrollback: o.scrollback,
        cursorBlink: true,
        allowProposedApi: true,
        ...o.themeOptions,
      });
      state.term = term;
      state.fit = new win.FitAddon.FitAddon();
      term.loadAddon(state.fit);
      term.loadAddon(new win.Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = '11';
      term.open(host);
      try {
        const gl = new win.WebglAddon.WebglAddon();
        gl.onContextLoss(() => {
          gl.dispose();
          state.webgl = null;
          repaint();
        });
        term.loadAddon(gl);
        state.webgl = gl;
      } catch (_) {
        // No WebGL: xterm falls back to its DOM renderer.
      }
      setBg(o.themeOptions);
      applyFont(o.fontSize);
      term.attachCustomKeyEventHandler(keyFilter);
      // After a click on the scrollbar, or before the board's focus message lands, the frame has focus
      // but xterm's textarea does not, and the board's keys must still get out.
      doc.addEventListener('keydown', (e) => {
        if (e.target !== term.textarea) forwardClaimed(e);
      });
      term.textarea.addEventListener('focus', () => up('focused'));
      // xterm leaves OSC 10/11 color queries unanswered, so apps that pick a palette from the
      // background (Claude Code's Auto theme) assume dark even on a light theme.
      for (const [code, key] of [
        [10, 'foreground'],
        [11, 'background'],
      ]) {
        term.parser.registerOscHandler(code, (data) => {
          if (data !== '?') return false;
          const rgb = oscColor(term.options.theme[key]);
          if (rgb) send({ t: 'in', d: `\x1b]${code};${rgb}\x1b\\` });
          return true;
        });
      }
      term.onData((d) => send({ t: 'in', d }));
      term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));
      // One fit per frame while a drag resizes the pane. The atlas is rebuilt only when the frame comes
      // back from 0×0, which is also how a hidden hub iframe or pane shows again.
      let frame = 0;
      let visible = false;
      new win.ResizeObserver(() => {
        if (frame) return;
        frame = win.requestAnimationFrame(() => {
          frame = 0;
          const nowVisible = host.offsetWidth > 0;
          fit();
          if (nowVisible && !visible) repaint();
          visible = nowVisible;
        });
      }).observe(host);
      // Vimium eats Escape inside a text field and only blurs it, so the key never reaches Claude.
      // A blur no click caused, while this frame keeps focus, is that Escape. When the board takes
      // focus back, this document loses it, so that blur is not one.
      let pointerDown = false;
      doc.addEventListener('mousedown', () => (pointerDown = true), true);
      doc.addEventListener('mouseup', () => (pointerDown = false), true);
      term.textarea.addEventListener('blur', () => {
        if (pointerDown) return;
        win.requestAnimationFrame(() => {
          if (!state.attached || !host.offsetWidth) return;
          if (!doc.hasFocus() || doc.activeElement !== doc.body) return;
          send({ t: 'in', d: '\x1b' });
          term.focus();
        });
      });
      up('term');
    }

    function ack(ws, n) {
      if (state.ws !== ws) return;
      state.ackPending += n;
      const flush = () => {
        win.clearTimeout(state.ackTimer);
        state.ackTimer = null;
        if (state.ws === ws && state.ackPending) send({ t: 'ack', n: state.ackPending });
        state.ackPending = 0;
      };
      if (state.ackPending >= ACK_BATCH_BYTES) flush();
      else if (!state.ackTimer) state.ackTimer = win.setTimeout(flush, 50);
    }

    // RIS through the write queue, not term.reset(): reset() runs at once, and output the previous
    // session had already queued would still be drawn after it.
    function clearScreen() {
      state.term.write('\x1bc', repaint);
    }

    function detach() {
      const ws = state.ws;
      state.ws = null;
      state.attached = false;
      win.clearTimeout(state.ackTimer);
      state.ackTimer = null;
      state.ackPending = 0;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    }

    function open({ socketId, hello, reset }) {
      detach();
      up('opening', { socketId });
      const term = state.term;
      let outputSent = false;
      if (reset) clearScreen();
      fit();
      const proto = win.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new win.WebSocket(`${proto}//${win.location.host}/api/terminal/ws`);
      ws.binaryType = 'arraybuffer';
      state.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ ...hello, t: 'hello', cols: term.cols, rows: term.rows }));
      ws.onmessage = (ev) => {
        if (state.ws !== ws) return;
        if (typeof ev.data !== 'string') {
          const bytes = new Uint8Array(ev.data);
          term.write(bytes, () => {
            ack(ws, bytes.length);
            if (!outputSent && state.ws === ws && tailOf(term.buffer.active, 1)) {
              outputSent = true;
              up('output', { socketId });
            }
          });
          return;
        }
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        if (msg.t === 'ready') {
          state.attached = true;
          // A retry keeps the last screen until the replay arrives.
          if (!reset) clearScreen();
          send({ t: 'resize', cols: term.cols, rows: term.rows });
        } else if (msg.t === 'exit') state.attached = false;
        up('ws', { socketId, msg, ...(msg.t === 'exit' && { tail: tailOf(term.buffer.active, 6) }) });
      };
      ws.onclose = (ev) => {
        if (state.ws !== ws) return;
        state.ws = null;
        state.attached = false;
        up('close', { socketId, code: ev.code });
      };
    }

    function onMessage(e) {
      if (e.source !== win.parent || e.origin !== parentOrigin) return;
      const m = e.data;
      if (typeof m?.type !== 'string' || !m.type.startsWith(MSG)) return;
      if (m.type === `${MSG}init`) return init(m);
      if (!state.term) return;
      switch (m.type.slice(MSG.length)) {
        case 'open':
          return open(m);
        case 'detach':
          return detach();
        case 'theme':
          return applyTheme(m.options);
        case 'font':
          return applyFont(m.size);
        case 'claims':
          state.claims = new Set((m.keys || []).map(claimSig));
          state.forward = new Set(m.forward || []);
          return;
        case 'focus':
          return state.term.focus();
        case 'refresh':
          fit();
          return repaint();
      }
    }

    win.addEventListener('message', onMessage);
    up('loaded');
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { createTerminalFrame, claimSig, isClaimed, handsBack, parentOriginOf, tailOf };
  } else {
    createTerminalFrame(root);
  }
})(typeof window === 'undefined' ? globalThis : window);

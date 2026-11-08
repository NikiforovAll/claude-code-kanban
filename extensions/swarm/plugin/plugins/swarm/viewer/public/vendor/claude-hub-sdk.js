// claude-hub-sdk 1.12.0 (sha256 6fb679e4d801). Copied by npm run sdk:sync in claude-code-hub. Do not edit.
// Claude Code Hub SDK: the one rule that names a key press, shared by the hub page, client.js and
// stub.js. The hub serves it to its page as /sdk/keys.js; mount() and sdk:sync put it in front of
// client.js and stub.js, so an app still loads one file.
// var, not const: the hub page and an app page each load it as a classic script, and a second
// const declaration in the same page would throw.
var ClaudeHubKeys = (() => {
  'use strict';

  // Modifiers in ctrl, alt, shift, meta order, joined by '+' to the key. macOS composes
  // Option+<key> into a character (Option+1 is '¡', Option+P is 'π') and holding Control does not
  // undo it, so e.key alone cannot name these presses there. e.code is the physical key, which is
  // wrong for non-US layouts, hence only as a fallback. A letter or punctuation key falls back to its
  // US character only when e.key is not ASCII (a non-Latin layout, or Option on macOS), so AZERTY's
  // ',' on the M key stays ','. The digit row always falls back, so AZERTY's '&' key is 1, as Windows
  // and VS Code treat it. No fallback under AltGraph: Chromium sets it when AltGr types a character, and that
  // press is text. Takes a real KeyboardEvent or a forwarded {key, code} payload; a payload without
  // code degrades to key. A payload needs no AltGraph: the SDK forwards only a press whose key
  // already names a bound combo.
  // Self-contained on purpose, the table too: cck puts its source text into a sandboxed frame.
  // codeOf() lists the same keys the other way round.
  function comboOf(e) {
    const raw = typeof e.key === 'string' ? e.key : '';
    const lower = raw.toLowerCase();
    const code = e.getModifierState?.('AltGraph') ? '' : e.code || '';
    const latin = !/[^\x20-\x7e]/.test(raw);
    const digit = /^Digit([0-9])$/.exec(code)?.[1];
    const us =
      !latin &&
      (/^Key([A-Z])$/.exec(code)?.[1].toLowerCase() ||
        {
          Minus: '-',
          Equal: '=',
          BracketLeft: '[',
          BracketRight: ']',
          Backslash: '\\',
          Semicolon: ';',
          Quote: "'",
          Backquote: '`',
          Comma: ',',
          Period: '.',
          Slash: '/',
        }[code]);
    const key = /^[a-z0-9]$/.test(lower) ? lower : digit || us || (e.key === ' ' ? 'Space' : e.key);
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'];
    return [...mods, key].filter(Boolean).join('+');
  }

  // The physical key (e.code) that types a combo's key on a US layout, or null for a named key.
  function codeOf(key) {
    if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    const codes = {
      '-': 'Minus',
      '=': 'Equal',
      '[': 'BracketLeft',
      ']': 'BracketRight',
      '\\': 'Backslash',
      ';': 'Semicolon',
      "'": 'Quote',
      '`': 'Backquote',
      ',': 'Comma',
      '.': 'Period',
      '/': 'Slash',
    };
    return codes[key] ?? null;
  }

  // The keys of a combo as a help row shows them: ['Ctrl', 'Alt', 'P'], or ['⌃', '⌥', 'P'] on macOS.
  // The {n} of a numbered combo reads 1…9.
  function keyParts(combo, mac) {
    const mods = mac
      ? { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
      : { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };
    const named = { '{n}': '1…9', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
    return combo.split('+').map((k) => mods[k] ?? named[k] ?? (k.length === 1 ? k.toUpperCase() : k));
  }

  // A host claim (protocol §5.2) names a press by its physical code, or by its character when the layout
  // moves the key: {ctrlKey?, altKey?, shiftKey?, metaKey?, code, key: 'Unidentified'} or {…, key, code: ''}.
  // A press matches a claim when one of its two signatures is the claim's first. AltGr types a
  // character, so its press matches by character only. cck's frames use the same format.
  function keySigs(e) {
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta']
      .filter(Boolean)
      .join('+');
    return [
      e.code && !e.getModifierState?.('AltGraph') && `${mods}|c:${e.code}`,
      typeof e.key === 'string' && e.key !== 'Unidentified' && `${mods}|k:${e.key.toLowerCase()}`,
    ].filter(Boolean);
  }

  return { comboOf, codeOf, keyParts, keySigs };
})();

if (typeof module === 'object' && module.exports) module.exports = ClaudeHubKeys;

// Claude Code Hub SDK stub: what an app serves when no hub runs it. Under a hub, the hub hands the
// app its real SDK (client.js) in place of this file. The API must match client.js; a test checks it.
((root) => {
  'use strict';

  // keys.js comes first in the synced file. Required as a module, stub.js loads it itself.
  const { comboOf } = typeof ClaudeHubKeys === 'object' ? ClaudeHubKeys : require('./keys');

  function createClaudeHub(win) {
    let hub = null;
    const off = () => {};

    function connect({ standalone = {} } = {}) {
      if (hub) return hub;
      const standaloneFn = (action) => {
        const fn = (typeof standalone === 'function' ? standalone() : standalone)[action];
        return typeof fn === 'function' ? fn : null;
      };
      hub = {
        status: 'standalone',
        themes: [],
        inHub: false,
        settings: null,
        onSettings: () => off,
        onStatus: () => off,
        onActive: () => off,
        onThemes: () => off,
        subscribe: () => off,
        bindTheme: () => off,
        handle() {},
        publish() {},
        invoke(action, params = {}, opts = {}) {
          const target = standaloneFn(action)?.(params);
          if (!target) return Promise.resolve({ ok: false, reason: 'unhandled' });
          if (opts.open === 'pane') return Promise.resolve({ ok: true, handledBy: 'standalone', url: target });
          win.open(target, '_blank', 'noopener');
          return Promise.resolve({ ok: true, handledBy: 'standalone' });
        },
        can: (action) => !!standaloneFn(action),
        forwards: () => false,
        forwardCombos: () => [],
        onKeys: () => off,
        keyLabel: () => null,
        voiceCommands: () => [],
        closeGuard() {},
        openExternal(url) {
          win.open(url, '_blank', 'noopener');
        },
        terminalToken: () => Promise.resolve(null),
      };
      return hub;
    }

    const mod = { list: [], wrap: () => false, on: () => off, emit() {}, send: () => false };
    return { connect, comboOf, mod };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createClaudeHub, comboOf };
  else root.ClaudeHub = createClaudeHub(root);
})(typeof window !== 'undefined' ? window : globalThis);

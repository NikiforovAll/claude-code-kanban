// claude-hub-sdk 1.3.0 (sha256 f5959e59714a). Copied by npm run sdk:sync in claude-code-hub. Do not edit.
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
  // wrong for non-US layouts, hence only as a fallback. Takes a real KeyboardEvent or a forwarded
  // {key, code} payload; a payload without code degrades to key.
  // Self-contained on purpose: cck puts its source text into a sandboxed frame.
  function comboOf(e) {
    const lower = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    const m = /^(?:Key|Digit)([A-Z1-9])$/.exec(e.code || '');
    const key = /^[a-z1-9]$/.test(lower) ? lower : m ? m[1].toLowerCase() : e.key;
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'];
    return [...mods, key].filter(Boolean).join('+');
  }

  return { comboOf };
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
        onStatus: () => off,
        onActive: () => off,
        onThemes: () => off,
        subscribe: () => off,
        bindTheme: () => off,
        handle() {},
        publish() {},
        invoke(action, params = {}) {
          const target = standaloneFn(action)?.(params);
          if (!target) return Promise.resolve({ ok: false, reason: 'unhandled' });
          win.open(target, '_blank', 'noopener');
          return Promise.resolve({ ok: true, handledBy: 'standalone' });
        },
        can: (action) => !!standaloneFn(action),
        forwards: () => false,
        forwardCombos: () => [],
        closeGuard() {},
        openExternal(url) {
          win.open(url, '_blank', 'noopener');
        },
        terminalToken: () => Promise.resolve(null),
      };
      return hub;
    }

    return { connect, comboOf };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createClaudeHub, comboOf };
  else root.ClaudeHub = createClaudeHub(root);
})(typeof window !== 'undefined' ? window : globalThis);

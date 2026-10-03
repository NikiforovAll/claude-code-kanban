// claude-hub-sdk 1.2.0 (sha256 62c7d9f477b2). Copied by npm run sdk:sync in claude-code-hub. Do not edit.
// Claude Code Hub SDK stub: what an app serves when no hub runs it. Under a hub, the hub hands the
// app its real SDK (client.js) in place of this file. The API must match client.js; a test checks it.
((root) => {
  'use strict';

  // A copy of client.js comboOf(); a test checks they match.
  function comboOf(e) {
    const lower = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    const m = /^(?:Key|Digit)([A-Z1-9])$/.exec(e.code || '');
    const key = /^[a-z1-9]$/.test(lower) ? lower : m ? m[1].toLowerCase() : e.key;
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'];
    return [...mods, key].filter(Boolean).join('+');
  }

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

// claude-hub-sdk 1.2.0 (sha256 0b8540e7ea36). Copied by npm run sdk:sync in claude-code-hub. Do not edit.
// Claude Code Hub SDK stub: what an app serves when no hub runs it. Under a hub, the hub hands the
// app its real SDK (client.js) in place of this file. The API must match client.js; a test checks it.
((root) => {
  'use strict';

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
        closeGuard() {},
        openExternal(url) {
          win.open(url, '_blank', 'noopener');
        },
        terminalToken: () => Promise.resolve(null),
      };
      return hub;
    }

    return { connect };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createClaudeHub };
  else root.ClaudeHub = createClaudeHub(root);
})(typeof window !== 'undefined' ? window : globalThis);

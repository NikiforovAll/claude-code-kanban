'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Runs inside the scratch viewer's page, whose parent is this app's page. The parent sends the presses
// it wants (the hub's combos, and the claims of a cck pane around it); the bridge hands those back,
// so Ctrl+` and the hub keys work while the viewer has focus. The viewer itself is not changed.
function frameSide(K) {
  let combos = new Set();
  let sigs = new Set();
  const FIELDS = 'input, textarea, select, [contenteditable]';
  addEventListener('message', (e) => {
    if (e.source !== parent || e.data?.type !== 'scratchpads:keys') return;
    combos = new Set(e.data.combos);
    sigs = new Set(e.data.sigs);
  });
  addEventListener(
    'keydown',
    (e) => {
      if (e.target?.closest?.(FIELDS)) return;
      if (!combos.has(K.comboOf(e)) && !K.keySigs(e).some((s) => sigs.has(s))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Key names only, so any parent origin may read them.
      parent.postMessage(
        { type: 'scratchpads:key', key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey },
        '*',
      );
    },
    true,
  );
  parent.postMessage({ type: 'scratchpads:ready' }, '*');
}

/** The script added to each viewer page, or '' when the hub's SDK (and so keys.js) is not there. */
function bridgeScript(sdkServer = process.env.HUB_SDK_SERVER) {
  if (!sdkServer) return '';
  let keys;
  try {
    keys = fs.readFileSync(path.join(path.dirname(sdkServer), 'keys.js'), 'utf8');
  } catch {
    return '';
  }
  return `(() => {\n${keys}\n(${frameSide})(ClaudeHubKeys);\n})();`;
}

module.exports = { bridgeScript };

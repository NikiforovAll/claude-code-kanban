// claude-hub-sdk 0.0.0 (sha256 cac2e0ea4af1). Copied by npm run sdk:sync in claude-code-hub. Do not edit.
'use strict';

const path = require('node:path');

// The hub spawns each app with an IPC channel. A loopback connect can fail while the app is fine,
// so before the hub replaces an app it asks over the channel, which does not go through TCP.
function answerHub() {
  if (!process.channel) return;
  process.on('message', (m) => {
    if (m?.type === 'hub:ping') process.send({ type: 'hub:pong', id: m.id });
  });
  process.on('disconnect', () => process.exit(0));
  // Listeners ref the channel. The app's own server keeps it alive, not the hub.
  process.channel.unref();
}

// Mount before express.static: a hub run from its repo passes HUB_SDK_SRC, and that file must win
// over the vendored copy in public/.
function mount(app, { publicDir }) {
  answerHub();
  const sdkFile = process.env.HUB_SDK_SRC || path.join(publicDir, 'vendor', 'claude-hub-sdk.js');
  app.get('/vendor/claude-hub-sdk.js', (_req, res) => res.sendFile(sdkFile));
  app.get('/hub-config', (_req, res) => {
    res.json({ enabled: !!process.env.CLAUDE_HUB, url: process.env.HUB_URL || null });
  });
}

module.exports = { mount };

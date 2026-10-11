'use strict';

// Stands in for the hub's server SDK (claude-hub packages/claude-hub-sdk/src/server.js), which the
// hub hands to each app as HUB_SDK_SERVER. Same contract: answer hub:ping over IPC, serve the hub
// client in place of the app's stub, and serve /hub-config.
const CLIENT = '// claude-hub client (test stand-in)\n';

function mount(app) {
  if (process.channel) {
    process.on('message', (m) => {
      if (m?.type === 'hub:ping') process.send({ type: 'hub:pong', id: m.id });
    });
    process.channel.unref();
  }
  app.get('/vendor/claude-hub-sdk.js', (_req, res) => res.type('js').send(CLIENT));
  app.get('/hub-config', (_req, res) => res.json({ enabled: !!process.env.CLAUDE_HUB, url: process.env.HUB_URL || null }));
}

module.exports = { mount, CLIENT };

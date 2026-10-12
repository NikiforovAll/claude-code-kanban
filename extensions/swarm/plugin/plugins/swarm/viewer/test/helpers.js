'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const STORE = path.join(__dirname, '..', '..', 'scripts', 'store.mjs');

// A config dir with swarms under .cck/swarm, as cck lays it out. The long temp path, so a test
// never runs on a Windows 8.3 short name.
function configDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'swarm-viewer-'));
}

async function buildSwarm(config, id, options = {}) {
  const { build, LIST_ID } = await import(pathToFileURL(path.join(__dirname, 'fixture', 'build.mjs')).href);
  const out = path.join(config, '.cck', 'swarm', id ?? LIST_ID);
  return build({ out, listId: id ?? LIST_ID, ...options });
}

const store = () => import(pathToFileURL(STORE).href);
const registry = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'swarm.json'), 'utf8'));

module.exports = { configDir, buildSwarm, store, registry };

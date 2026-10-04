const fs = require('node:fs');
const { exportSessionCaches, importSessionCaches, sessionCachesDirty } = require('./parsers');
const { exportParentVerdicts, importParentVerdicts, parentVerdictsDirty } = require('./parent-cache');
const { exportTaskCounts, importTaskCounts, taskCountsDirty } = require('./task-counts');

// Bump when an entry's shape or meaning changes: a file with another version is ignored.
const VERSION = 5;
// A cache this large is not one cck wrote for a normal set of transcripts. Rebuild it cold.
const MAX_BYTES = 8 * 1024 * 1024;

function loadSessionCache(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      fs.rmSync(file, { force: true });
      return false;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.version !== VERSION) return false;
    importSessionCaches(data);
    importParentVerdicts(data.parents);
    importTaskCounts(data.taskCounts);
    return true;
  } catch (_) {
    return false;
  }
}

// write(data) must replace the file atomically; server.js passes writeJsonAtomic.
function saveSessionCache(write) {
  if (!sessionCachesDirty() && !parentVerdictsDirty() && !taskCountsDirty()) return;
  write({ version: VERSION, ...exportSessionCaches(), parents: exportParentVerdicts(), taskCounts: exportTaskCounts() });
}

module.exports = { loadSessionCache, saveSessionCache };

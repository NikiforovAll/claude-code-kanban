const fs = require('node:fs');

const fileCache = new Map();

// Parsed Claude Code settings file, or null when it is missing or invalid. Re-read only
// after its mtime changes.
function readSettings(file) {
  const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
  const hit = fileCache.get(file);
  if (hit && hit.mtime === mtime) return hit.data;
  let data = null;
  if (mtime !== null) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }
  fileCache.set(file, { mtime, data });
  return data;
}

module.exports = { readSettings };

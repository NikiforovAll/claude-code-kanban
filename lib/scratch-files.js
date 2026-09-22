'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');
const { isContained } = require('./contain');

// Resolves a folder inside a session's scratchpad dir from the path the client sends
// back — the absolute path a listing handed out, or one relative to the root. Returns
// null when it escapes the root (`..`, another dir, a symlink out), so the endpoint
// never lists anything the root did not hand out.
function resolveScratchSubdir(root, sub) {
  if (!sub) return root;
  if (typeof sub !== 'string') return null;
  const full = path.resolve(root, sub);
  return isContained(full, root) ? full : null;
}

// One level of a scratchpad dir, newest first whatever the kind. Not recursive on
// purpose: sessions drop clones and build output in here, and the client asks for a
// folder's children only when the user opens it.
async function listScratchDir(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const rows = await Promise.all(
    entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .map(async (entry) => {
        const full = path.join(dir, entry.name);
        try {
          const { mtimeMs } = await fs.stat(full);
          return { name: entry.name, path: full, kind: entry.isDirectory() ? 'dir' : 'file', mtimeMs };
        } catch (_) {
          return null;
        }
      }),
  );
  return rows
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ mtimeMs, ...row }) => ({ ...row, modifiedAt: new Date(mtimeMs).toISOString() }));
}

module.exports = { resolveScratchSubdir, listScratchDir };

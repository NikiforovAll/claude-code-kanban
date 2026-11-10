'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = 'scratchpad.json';

/** What the list shows of a pad, from its scratchpad.json. Cached by mtime, so a refresh costs one stat per pad. */
function createManifests() {
  const cache = new Map();

  function summarize(m) {
    const files = Array.isArray(m.files) ? m.files : [];
    const types = {};
    for (const f of files) types[f.type || 'other'] = (types[f.type || 'other'] || 0) + 1;
    const groups = new Set(files.map((f) => f.group).filter(Boolean));
    const lead = files.find((f) => /start/i.test(f.group || '') && f.description) || files.find((f) => f.description);
    const updated = Date.parse(m.updated || m.created || '');
    return {
      files: files.length,
      groups: groups.size,
      types,
      updated: Number.isNaN(updated) ? null : updated,
      description: lead ? lead.description : null,
      internal: files.some((f) => Array.isArray(f.tags) && f.tags.includes('internal-only')),
    };
  }

  function read(dir) {
    const file = path.join(dir, MANIFEST);
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      cache.delete(dir);
      return { missing: true };
    }
    const hit = cache.get(dir);
    if (hit && hit.mtime === mtime) return hit.summary;
    let summary;
    try {
      summary = summarize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      summary = { broken: true };
    }
    cache.set(dir, { mtime, summary });
    return summary;
  }

  return { read };
}

module.exports = { createManifests, MANIFEST };

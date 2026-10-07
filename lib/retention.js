// Expiry of per-session state cck writes. The rule and the sweep: docs/retention.md.

const fs = require('node:fs/promises');
const path = require('node:path');
const { readSettings } = require('./claude-settings');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_DAYS = 30;
// A started session writes its transcript a moment after the record; the sweep must not
// read that gap as a deleted transcript.
const GRACE_MS = 60 * 60 * 1000;
const MAX_DISPATCHED = 500;
const MAX_CONTEXT_STATUS = 2000;

// Only the config dir's settings: retention is per config dir, not per project.
function retentionMs(claudeDir) {
  const days = readSettings(path.join(claudeDir, 'settings.json'))?.cleanupPeriodDays;
  return (Number.isInteger(days) && days > 0 ? days : DEFAULT_CLEANUP_DAYS) * DAY_MS;
}

// `known` is the set of session ids with a transcript, or null when the scan found none,
// so a failed scan never reads as every transcript gone.
function isExpired(id, at, { known, maxAgeMs, now }) {
  const age = now - at;
  if (age < GRACE_MS) return false;
  return (known && !known.has(id)) || age > maxAgeMs;
}

// Deletes the expired entries of a session-keyed map and returns how many went.
function pruneMap(map, atOf, { known, maxAgeMs, now }) {
  let removed = 0;
  for (const [id, entry] of map) {
    if (isExpired(id, atOf(entry), { known, maxAgeMs, now })) {
      map.delete(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Sessions started through `dispatch start`, kept after their terminal ends so the card
 * keeps its marker.
 * @param {object} o
 * @param {() => object|null} o.load returns `{version: 1, sessions: {[id]: {parent, at}}}` or null
 * @param {(data: object) => void} o.save
 */
function createDispatchedStore({ load, save, now = Date.now }) {
  // Insertion order is oldest first, so the cap drops the first key.
  const entries = new Map();
  const saved = load()?.sessions;
  if (saved && typeof saved === 'object') {
    for (const [id, e] of Object.entries(saved)) {
      if (!e || !Number.isFinite(e.at)) continue;
      entries.set(id, { parent: typeof e.parent === 'string' ? e.parent : null, at: e.at });
    }
  }

  const persist = () => save({ version: 1, sessions: Object.fromEntries(entries) });

  function record(id, parent) {
    entries.delete(id);
    entries.set(id, { parent: parent || null, at: now() });
    if (entries.size > MAX_DISPATCHED) entries.delete(entries.keys().next().value);
    persist();
  }

  // Returns how many entries went; writes only when one did.
  function prune({ known, maxAgeMs }) {
    const removed = pruneMap(entries, (e) => e.at, { known, maxAgeMs, now: now() });
    if (removed) persist();
    return removed;
  }

  return { record, prune, get: (id) => entries.get(id) || null, entries: () => entries.entries() };
}

// Names only, no stat or parse: the sweep needs which transcripts exist, not what they hold.
// `ids` are session ids and `dirs` the project dir names holding at least one transcript. Null
// when none is found, so a missing or unreadable projects dir never reads as every transcript gone.
async function scanTranscripts(projectsDir) {
  const ids = new Set();
  const dirs = new Set();
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    try {
      for (const f of await fs.readdir(path.join(projectsDir, d.name))) {
        if (!f.endsWith('.jsonl')) continue;
        ids.add(f.slice(0, -'.jsonl'.length));
        dirs.add(d.name);
      }
    } catch {}
  }
  return ids.size ? { ids, dirs } : null;
}

async function expireFiles(dir, names, idOf, opts) {
  let removed = 0;
  const kept = [];
  for (const f of names) {
    const file = path.join(dir, f);
    try {
      const { mtimeMs } = await fs.stat(file);
      if (isExpired(idOf(f), mtimeMs, opts)) {
        await fs.rm(file, { force: true });
        removed++;
      } else kept.push({ file, mtimeMs });
    } catch {}
  }
  return { removed, kept };
}

// `<dir>/<session id>/<ts>.md`, one folder per session.
async function pruneSessionDirs(dir, { known, maxAgeMs, now = Date.now() }) {
  let removed = 0;
  let sessionDirs;
  try {
    sessionDirs = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of sessionDirs) {
    if (!d.isDirectory()) continue;
    const sessionDir = path.join(dir, d.name);
    try {
      const files = await fs.readdir(sessionDir);
      const res = await expireFiles(sessionDir, files, () => d.name, { known, maxAgeMs, now });
      removed += res.removed;
      // An old mtime means no file was added since the read, so a review written right
      // now cannot lose its folder.
      if (!res.kept.length && now - (await fs.stat(sessionDir)).mtimeMs >= GRACE_MS) await fs.rmdir(sessionDir);
    } catch {}
  }
  return removed;
}

// `<dir>/<session id>.json`, written by the plugin mod. The cap guards users who keep
// transcripts forever; it drops the oldest by mtime.
async function pruneContextStatus(dir, { known, maxAgeMs, now = Date.now(), max = MAX_CONTEXT_STATUS }) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const jsonNames = names.filter((f) => f.endsWith('.json'));
  let { removed, kept } = await expireFiles(dir, jsonNames, (f) => f.slice(0, -'.json'.length), { known, maxAgeMs, now });
  if (kept.length > max) {
    kept.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { file } of kept.slice(max)) {
      try {
        await fs.rm(file, { force: true });
        removed++;
      } catch {}
    }
  }
  return removed;
}

// `<dir>/<task list id>.json` maps session id → `{project, updatedAt}`, written by the plugin mod.
// A file with no sessions left is deleted.
async function pruneTaskMaps(dir, { known, maxAgeMs, now = Date.now() }) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const f of names.filter((n) => n.endsWith('.json'))) {
    const file = path.join(dir, f);
    try {
      const map = new Map(Object.entries(JSON.parse(await fs.readFile(file, 'utf8'))));
      const n = pruneMap(map, (e) => Date.parse(e?.updatedAt), { known, maxAgeMs, now });
      if (!n) continue;
      removed += n;
      if (map.size) await fs.writeFile(file, JSON.stringify(Object.fromEntries(map)));
      else await fs.rm(file, { force: true });
    } catch {}
  }
  return removed;
}

module.exports = {
  pruneMap,
  createDispatchedStore,
  scanTranscripts,
  pruneSessionDirs,
  pruneContextStatus,
  pruneTaskMaps,
  retentionMs,
  GRACE_MS,
  MAX_DISPATCHED,
  DAY_MS,
};

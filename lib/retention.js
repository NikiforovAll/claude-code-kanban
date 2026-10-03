// Expiry of per-session state cck writes. The rule and the sweep: docs/retention.md.

const fs = require('node:fs/promises');
const path = require('node:path');
const { readSettings } = require('./claude-settings');
const { DISPATCH_OUTCOME } = require('./dispatch');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_DAYS = 30;
// A started session writes its transcript a moment after the record; the sweep must not
// read that gap as a deleted transcript.
const GRACE_MS = 60 * 60 * 1000;
const MAX_DISPATCHED = 500;
const OUTCOMES = new Set(Object.keys(DISPATCH_OUTCOME));

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

/**
 * Sessions started through `dispatch start`, kept after the dispatch settles so the card
 * keeps its marker.
 * @param {object} o
 * @param {() => object|null} o.load returns `{version: 1, sessions: {[id]: {parent, status, at}}}` or null
 * @param {(data: object) => void} o.save
 */
function createDispatchedStore({ load, save, now = Date.now }) {
  // Insertion order is oldest first, so the cap drops the first key.
  const entries = new Map();
  const saved = load()?.sessions;
  if (saved && typeof saved === 'object') {
    for (const [id, e] of Object.entries(saved)) {
      if (!e || !Number.isFinite(e.at)) continue;
      // The dispatch registry is in memory: a dispatch that was running when the server
      // stopped can never settle, so it reads as ended.
      const status = OUTCOMES.has(e.status) ? e.status : 'exited';
      entries.set(id, { parent: typeof e.parent === 'string' ? e.parent : null, status, at: e.at });
    }
  }

  const persist = () => save({ version: 1, sessions: Object.fromEntries(entries) });

  function record(id, parent) {
    entries.delete(id);
    entries.set(id, { parent: parent || null, status: 'running', at: now() });
    if (entries.size > MAX_DISPATCHED) entries.delete(entries.keys().next().value);
    persist();
  }

  function settle(id, status) {
    const e = entries.get(id);
    if (!e || e.status !== 'running' || !OUTCOMES.has(status)) return;
    e.status = status;
    persist();
  }

  // Returns how many entries went; writes only when one did.
  function prune({ known, maxAgeMs }) {
    const t = now();
    let removed = 0;
    for (const [id, e] of entries) {
      if (isExpired(id, e.at, { known, maxAgeMs, now: t })) {
        entries.delete(id);
        removed++;
      }
    }
    if (removed) persist();
    return removed;
  }

  return { record, settle, prune, get: (id) => entries.get(id) || null };
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
      let kept = 0;
      for (const f of files) {
        const file = path.join(sessionDir, f);
        const { mtimeMs } = await fs.stat(file);
        if (isExpired(d.name, mtimeMs, { known, maxAgeMs, now })) {
          await fs.rm(file, { force: true });
          removed++;
        } else kept++;
      }
      // An old mtime means no file was added since the read, so a review written right
      // now cannot lose its folder.
      if (!kept && now - (await fs.stat(sessionDir)).mtimeMs >= GRACE_MS) await fs.rmdir(sessionDir);
    } catch {}
  }
  return removed;
}

module.exports = { createDispatchedStore, scanTranscripts, pruneSessionDirs, retentionMs, GRACE_MS, MAX_DISPATCHED, DAY_MS };

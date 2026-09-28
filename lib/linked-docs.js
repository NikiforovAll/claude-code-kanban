// Server copy of each session's linked docs. The browser keeps its own list in localStorage
// and merges this one in when it connects, so a `link-doc` sent while no tab is open is not lost.
// Newest first, capped like the browser list.

const MAX_PER_SESSION = 20;

// Same rule as `canonicalPath` in public/app.js: one Windows file is reached as `C:\a` and `c:/a`.
function canonicalPath(p) {
  const slashed = String(p).replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

/**
 * @param {object} o
 * @param {() => object|null} o.load returns `{sessions: {[id]: string[]}}` or null
 * @param {(data: object) => void} o.save
 */
function createLinkedDocStore({ load, save }) {
  const bySession = new Map();
  const saved = load()?.sessions;
  if (saved && typeof saved === 'object') {
    for (const [id, paths] of Object.entries(saved)) {
      const clean = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
      if (clean.length) bySession.set(id, clean.slice(0, MAX_PER_SESSION));
    }
  }

  const persist = () => save({ version: 1, sessions: Object.fromEntries(bySession) });

  function link(sessionId, filePath) {
    const key = canonicalPath(filePath);
    const rest = (bySession.get(sessionId) || []).filter((p) => canonicalPath(p) !== key);
    bySession.set(sessionId, [filePath, ...rest].slice(0, MAX_PER_SESSION));
    persist();
  }

  // With no path, forgets every doc of the session. Returns whether anything was removed.
  function unlink(sessionId, filePath) {
    const paths = bySession.get(sessionId);
    if (!paths) return false;
    const key = filePath == null ? null : canonicalPath(filePath);
    const rest = key === null ? [] : paths.filter((p) => canonicalPath(p) !== key);
    if (rest.length === paths.length) return false;
    if (rest.length) bySession.set(sessionId, rest);
    else bySession.delete(sessionId);
    persist();
    return true;
  }

  const get = (sessionId) => [...(bySession.get(sessionId) || [])];
  const all = () => Object.fromEntries([...bySession].map(([id, paths]) => [id, [...paths]]));

  return { link, unlink, get, all };
}

module.exports = { createLinkedDocStore, canonicalPath, MAX_PER_SESSION };

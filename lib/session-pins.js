// Session pins: which sessions the sidebar pins, and which of those are sticky. The board, the CLI
// and every board on the same config dir share them through `.cck/pins.json`: a flat
// {sessionId: "pinned"|"sticky"} map plus `pinsMigratedAt`, set by the first board that imported
// browser lists. Each write changes only the sessions it names, so the last write for a session wins.

const { httpError } = require('./http-error');

const MAX_PINS = 1000;
const MAX_REF = 4096;
const MIGRATED_KEY = 'pinsMigratedAt';
const STATES = new Set(['pinned', 'sticky']);

const fail = (status, message) => {
  throw httpError(status, message);
};

const isRef = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_REF && s !== MIGRATED_KEY;

function readPins(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  let n = 0;
  for (const [id, state] of Object.entries(obj)) {
    if (n >= MAX_PINS) break;
    if (isRef(id) && STATES.has(state)) {
      out[id] = state;
      n++;
    }
  }
  return out;
}

/**
 * @param {object} o
 * @param {() => object|null|undefined} o.load `undefined` means the file has not changed since the
 *   last load; throws when the file cannot be read
 * @param {(data: object) => void} o.save throws when the write fails
 */
function createSessionPinStore({ load, save, now = () => new Date().toISOString() }) {
  let pins = {};
  let migratedAt = null;
  // A file that cannot be read keeps the last good pins in memory, and no write replaces it.
  let readError = null;

  // Another board on the same config dir writes the same file. Returns the sessions whose state
  // changed, as [{id, state}] with state 'none' for a removed pin.
  function reload() {
    let saved;
    try {
      saved = load();
    } catch (e) {
      readError = e;
      return [];
    }
    readError = null;
    if (saved === undefined) return [];
    const before = pins;
    const data = saved && typeof saved === 'object' ? saved : {};
    pins = readPins(data);
    migratedAt = typeof data[MIGRATED_KEY] === 'string' ? data[MIGRATED_KEY] : null;
    return diff(before, pins);
  }
  reload();

  const state = () => ({ pins, [MIGRATED_KEY]: migratedAt });

  function commit(next, nextMigratedAt = migratedAt) {
    if (readError) fail(503, `pins.json cannot be read (${readError.message}); fix or delete it`);
    try {
      save(nextMigratedAt ? { ...next, [MIGRATED_KEY]: nextMigratedAt } : next);
    } catch (e) {
      fail(503, `pins not saved (${e.code || e.message})`);
    }
    const changed = diff(pins, next);
    pins = next;
    migratedAt = nextMigratedAt;
    return changed;
  }

  function set(ids, s) {
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length || !list.every(isRef)) fail(400, 'id is required');
    if (list.length > MAX_PINS) fail(422, `at most ${MAX_PINS} ids`);
    if (s !== 'none' && !STATES.has(s)) fail(400, 'state must be none|pinned|sticky');
    const next = { ...pins };
    for (const id of list) {
      if (s === 'none') delete next[id];
      else next[id] = s;
    }
    if (Object.keys(next).length > MAX_PINS) fail(422, `at most ${MAX_PINS} pins`);
    return commit(next);
  }

  // A browser's lists from before the server kept pins. Each origin sends its own once, so every
  // import is merged; a session the server already holds keeps its state.
  function importLocal({ pinned, sticky } = {}) {
    const next = { ...pins };
    const add = (list, s) => {
      for (const id of Array.isArray(list) ? list : []) {
        if (Object.keys(next).length >= MAX_PINS) return;
        if (isRef(id) && !(id in next)) next[id] = s;
      }
    };
    add(sticky, 'sticky');
    add(pinned, 'pinned');
    return { imported: true, changed: commit(next, migratedAt || now()) };
  }

  return { state, reload, set, importLocal };
}

function diff(before, after) {
  const out = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[id] !== after[id]) out.push({ id, state: after[id] || 'none' });
  }
  return out;
}

module.exports = { createSessionPinStore };

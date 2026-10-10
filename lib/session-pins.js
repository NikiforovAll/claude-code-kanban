// Session pins: which sessions the sidebar pins, and which of those are sticky. The board, the CLI
// and every board on the same config dir share them through `.cck/pins.json`: a flat
// {sessionId: "pinned"|"sticky"} map plus `pinsMigratedAt`, set by the first board that imported
// its browser lists. Each write changes one session, so the last write for a session wins.

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
 *   last load
 * @param {(data: object) => void} o.save
 */
function createSessionPinStore({ load, save, now = () => new Date().toISOString() }) {
  let pins = {};
  let migratedAt = null;

  // Another board on the same config dir writes the same file. Returns the sessions whose state
  // changed, as [{id, state}] with state 'none' for a removed pin.
  function reload() {
    const saved = load();
    if (saved === undefined) return [];
    const before = pins;
    const data = saved && typeof saved === 'object' ? saved : {};
    pins = readPins(data);
    migratedAt = typeof data[MIGRATED_KEY] === 'string' ? data[MIGRATED_KEY] : null;
    return diff(before, pins);
  }
  reload();

  const state = () => ({ pins, [MIGRATED_KEY]: migratedAt });

  function commit(next) {
    const changed = diff(pins, next);
    pins = next;
    save(migratedAt ? { ...pins, [MIGRATED_KEY]: migratedAt } : pins);
    return changed;
  }

  function set(id, s) {
    if (!isRef(id)) fail(400, 'id is required');
    if (s !== 'none' && !STATES.has(s)) fail(400, 'state must be none|pinned|sticky');
    const next = { ...pins };
    if (s === 'none') delete next[id];
    else next[id] = s;
    if (Object.keys(next).length > MAX_PINS) fail(422, `at most ${MAX_PINS} pins`);
    return commit(next);
  }

  // The board's lists from before the server kept pins. Only the first import is taken; a later one
  // changes nothing. A session the server already holds keeps its state.
  function importLocal({ pinned, sticky } = {}) {
    if (migratedAt) return { imported: false, changed: [] };
    const next = { ...pins };
    const add = (list, s) => {
      for (const id of Array.isArray(list) ? list : []) {
        if (Object.keys(next).length >= MAX_PINS) return;
        if (isRef(id) && !(id in next)) next[id] = s;
      }
    };
    add(sticky, 'sticky');
    add(pinned, 'pinned');
    migratedAt = now();
    return { imported: true, changed: commit(next) };
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

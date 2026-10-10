// Session pins: which sessions the sidebar pins, and which of those are sticky. The board, the CLI
// and every board on the same config dir share them through `.cck/pins.json`, a flat
// {sessionId: "pinned"|"sticky"} map. Each write changes only the sessions it names, so the last
// write for a session wins.

const { httpError } = require('./http-error');

const MAX_PINS = 1000;
const MAX_REF = 4096;
const STATES = new Set(['pinned', 'sticky']);

const fail = (status, message) => {
  throw httpError(status, message);
};

const isRef = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_REF;

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
 * @param {() => object|null|undefined} o.load `undefined` means keep what is in memory: the file has
 *   not changed since the last load, or cannot be read
 * @param {(data: object) => void} o.save throws when the pins must not or cannot be written
 */
function createSessionPinStore({ load, save }) {
  let pins = {};

  // Another board on the same config dir writes the same file. Returns the sessions whose state
  // changed, as [{id, state}] with state 'none' for a removed pin.
  function reload() {
    const saved = load();
    if (saved === undefined) return [];
    const before = pins;
    pins = readPins(saved);
    return diff(before, pins);
  }
  reload();

  const state = () => ({ pins });

  function commit(next) {
    save(next);
    const changed = diff(pins, next);
    pins = next;
    return changed;
  }

  function set(ids, s) {
    if (!Array.isArray(ids) || !ids.length || !ids.every(isRef)) fail(400, 'ids is required');
    if (s !== 'none' && !STATES.has(s)) fail(400, 'state must be none|pinned|sticky');
    const next = { ...pins };
    for (const id of ids) {
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
    return commit(next);
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

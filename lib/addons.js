// Dock add-ons: web pages on the rail beside the embedded terminal. A global entry shows in every
// session; a session's entries and its param overrides expire with the session (docs/retention.md).
// The file is shared by every board process on the config dir and the CLI, as panes.json is.

const path = require('node:path');
const { httpError } = require('./http-error');
const { isLoopbackAddress } = require('./net-guard');
const { oneLine } = require('./one-line');
const { pruneMap } = require('./retention');

const MAX_ADDONS = 20;
const MAX_TITLE = 100;
const MAX_ICON = 2;
const MAX_PARAM = 500;
const MAX_RUN = 1000;
const BUILTINS = ['sessionId', 'cwd', 'project'];
const PARAM_NAME = /^[A-Za-z][\w-]{0,31}$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;

const placeholders = (url) => [...url.matchAll(PLACEHOLDER)].map((m) => m[1]);
const sampleUrl = (url) => url.replace(PLACEHOLDER, 'x');

// A value of '' in an override drops that key, so the entry's own value applies again.
function cleanParams(raw, { allowEmpty = false } = {}) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'params must be an object', 'bad_param');
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PARAM_NAME.test(k) || BUILTINS.includes(k)) throw httpError(400, `Bad param name: ${k}`, 'bad_param');
    if (typeof v !== 'string' || v.length > MAX_PARAM || (!v && !allowEmpty)) {
      throw httpError(400, `Param ${k} needs a value of at most ${MAX_PARAM} characters`, 'bad_param');
    }
    out[k] = v;
  }
  return out;
}

// Returns the URL with each placeholder filled by `x`, for the syntax and origin checks.
function checkAddonUrl(url, params) {
  if (typeof url !== 'string' || !url) throw httpError(400, 'url is required', 'bad_url');
  for (const name of placeholders(url)) {
    if (!BUILTINS.includes(name) && !(name in params)) {
      throw httpError(400, `No value for {${name}}: pass --param ${name}=<value>, or use {${BUILTINS.join('}, {')}}`, 'missing_param');
    }
  }
  const sample = sampleUrl(url);
  let u;
  try {
    u = new URL(sample);
  } catch {
    throw httpError(400, `Not a URL: ${url}`, 'bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, 'An add-on URL must be http(s)', 'bad_url');
  return sample;
}

// cck starts `run` only for a page on this machine, so the port it checks is the server's own.
function cleanRun(run, cwd, sample, isGlobal) {
  if (run == null || run === '') {
    if (cwd) throw httpError(400, 'cwd needs run', 'bad_run');
    return {};
  }
  if (!isGlobal) throw httpError(400, 'Only a global add-on has a run command', 'bad_run');
  if (typeof run !== 'string' || run.length > MAX_RUN || /[\r\n\0]/.test(run)) {
    throw httpError(400, `run must be one line of at most ${MAX_RUN} characters`, 'bad_run');
  }
  if (cwd != null && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) throw httpError(400, 'cwd must be an absolute path', 'bad_run');
  if (!isLoopbackAddress(new URL(sample).hostname)) throw httpError(400, 'A run command needs a URL on localhost', 'bad_run');
  return { run, ...(cwd && { cwd }) };
}

const emptyData = () => ({ nextId: 1, global: [], sessions: new Map() });

const isEntry = (e) => e && typeof e.id === 'string' && typeof e.url === 'string' && typeof e.title === 'string';

function cleanData(raw) {
  const data = emptyData();
  if (!raw || typeof raw !== 'object') return data;
  const ids = new Set();
  const keep = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((e) => isEntry(e) && !ids.has(e.id) && ids.add(e.id))
      .slice(0, MAX_ADDONS)
      .map((e) => ({ ...e, params: e.params && typeof e.params === 'object' ? e.params : {} }));
  data.global = keep(raw.global);
  for (const [sid, s] of Object.entries(raw.sessions || {})) {
    if (!s || !Number.isFinite(s.updatedAt)) continue;
    data.sessions.set(sid, { addons: keep(s.addons), params: s.params && typeof s.params === 'object' ? s.params : {}, updatedAt: s.updatedAt });
  }
  const maxId = Math.max(0, ...[...ids].map((id) => Number(id.slice(1)) || 0));
  data.nextId = Math.max(Number.isInteger(raw.nextId) ? raw.nextId : 1, maxId + 1);
  return data;
}

const toFile = (data) => ({ version: 1, nextId: data.nextId, global: data.global, sessions: Object.fromEntries(data.sessions) });

/**
 * @param {object} o
 * @param {() => object|null|undefined} o.load the file's JSON, null when there is none, or undefined
 *   when it has not changed since the last load or save
 * @param {(data: object) => void} o.save
 * @param {() => void} [o.onChange] called after a write, and after a reload that changed something
 * @param {(url: string) => boolean} [o.isOwnOrigin] true for a URL on the board's or the hub's origin
 */
function createAddonStore({ load, save, onChange = () => {}, isOwnOrigin = () => false, now = Date.now }) {
  let data = emptyData();
  let saved = '';

  function reload() {
    const raw = load();
    if (raw === undefined) return;
    data = cleanData(raw);
    const next = JSON.stringify(toFile(data));
    if (next === saved) return;
    saved = next;
    onChange();
  }
  reload();

  function write() {
    const file = toFile(data);
    saved = JSON.stringify(file);
    save(file);
    onChange();
  }

  const session = (sid) => data.sessions.get(sid) || { addons: [], params: {}, updatedAt: 0 };

  function touch(sid, s) {
    s.updatedAt = now();
    data.sessions.set(sid, s);
  }

  const copy = (e) => ({ ...e, params: { ...e.params } });

  function list(sid) {
    const s = sid ? session(sid) : null;
    return {
      global: data.global.map(copy),
      session: s ? s.addons.map(copy) : [],
      params: s ? structuredClone(s.params) : {},
    };
  }

  // The same URL added again in the same scope returns its entry, so a repeated add is harmless;
  // a new `run` or `cwd` replaces the entry's. `scope` is 'global' or a session id.
  function add(scope, { url, title, icon, params, run, cwd }) {
    const clean = cleanParams(params);
    const sample = checkAddonUrl(url, clean);
    if (isOwnOrigin(sample)) throw httpError(400, 'An add-on cannot show the board or the hub itself', 'own_origin');
    const isGlobal = scope === 'global';
    const start = cleanRun(run, cwd, sample, isGlobal);
    reload();
    const s = isGlobal ? null : session(scope);
    const addons = isGlobal ? data.global : s.addons;
    const existing = addons.find((e) => e.url === url);
    if (existing) {
      if (start.run && (start.run !== existing.run || start.cwd !== existing.cwd)) {
        Object.assign(existing, start);
        if (!start.cwd) delete existing.cwd;
        write();
      }
      return { addon: { ...existing }, added: false };
    }
    if (addons.length >= MAX_ADDONS) throw httpError(409, `At most ${MAX_ADDONS} add-ons ${isGlobal ? 'are global' : 'per session'}`, 'addon_limit');
    const glyph = [...oneLine(icon, 16)].slice(0, MAX_ICON).join('');
    const addon = {
      id: `a${data.nextId++}`,
      url,
      title: oneLine(title, MAX_TITLE) || new URL(sample).host,
      ...(glyph && { icon: glyph }),
      ...start,
      params: clean,
      addedAt: now(),
    };
    addons.push(addon);
    if (!isGlobal) touch(scope, s);
    write();
    return { addon: { ...addon }, added: true };
  }

  // A global id needs no session. Returns the removed entry with its scope, or null.
  function remove(sid, id) {
    reload();
    const g = data.global.findIndex((e) => e.id === id);
    if (g >= 0) {
      const [addon] = data.global.splice(g, 1);
      for (const s of data.sessions.values()) delete s.params[id];
      write();
      return { addon, scope: 'global' };
    }
    const s = sid && data.sessions.get(sid);
    const i = s ? s.addons.findIndex((e) => e.id === id) : -1;
    if (i < 0) return null;
    const [addon] = s.addons.splice(i, 1);
    delete s.params[id];
    touch(sid, s);
    write();
    return { addon, scope: sid };
  }

  // Sets this session's values for the add-on's params. Returns null when the session sees no such add-on.
  function setParams(sid, id, params) {
    const clean = cleanParams(params, { allowEmpty: true });
    reload();
    const s = session(sid);
    if (!data.global.some((e) => e.id === id) && !s.addons.some((e) => e.id === id)) return null;
    const next = { ...s.params[id], ...clean };
    for (const [k, v] of Object.entries(next)) if (!v) delete next[k];
    if (Object.keys(next).length) s.params[id] = next;
    else delete s.params[id];
    touch(sid, s);
    write();
    return list(sid);
  }

  // Returns how many sessions went; writes only when one did. Global entries never expire.
  function prune({ known, maxAgeMs }) {
    reload();
    const removed = pruneMap(data.sessions, (s) => s.updatedAt, { known, maxAgeMs, now: now() });
    if (removed) write();
    return removed;
  }

  function getGlobal(id) {
    const e = data.global.find((g) => g.id === id);
    return e ? copy(e) : null;
  }

  return { list, getGlobal, add, remove, setParams, prune, reload };
}

module.exports = { createAddonStore, sampleUrl, MAX_ADDONS };

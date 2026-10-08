// Per-session pane layout: the tabs next to Board. The file is the only copy, shared by every
// board process on the config dir, the CLI and the agent. Which tab is on screen is each
// browser tab's own state, not stored here. Expiry: docs/retention.md.

const path = require('node:path');
const { httpError } = require('./http-error');
const { canonicalPath } = require('./linked-docs');
const { isLoopbackAddress } = require('./net-guard');
const { oneLine } = require('./one-line');
const { pruneMap } = require('./retention');

const MAX_PANES = 50;
const MAX_TITLE = 100;
const FILE_KINDS = new Set(['html', 'markdown', 'text', 'image']);
const KINDS = new Set([...FILE_KINDS, 'url', 'message']);
const MAX_MESSAGE_TARGET = 300;
const isFileKind = (kind) => FILE_KINDS.has(kind);

const portOf = (u) => Number(u.port || (u.protocol === 'https:' ? 443 : 80));

// A frame with allow-scripts plus allow-same-origin on the board's origin or the hub's can reach
// into its parent and drop its own sandbox. Every name either one is served under counts.
function isOwnOrigin(url, { boardPort, boardHosts = [], hubUrl }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const port = portOf(u);
  const loopback = isLoopbackAddress(u.hostname);
  if (u.protocol === 'http:' && port === boardPort && (loopback || boardHosts.includes(u.hostname))) return true;
  let hub;
  try {
    hub = new URL(hubUrl);
  } catch {
    return false;
  }
  const hubHost = u.hostname === hub.hostname || (loopback && isLoopbackAddress(hub.hostname));
  return u.protocol === hub.protocol && port === portOf(hub) && hubHost;
}

const emptyLayout = () => ({ rev: 0, nextId: 1, panes: [], updatedAt: null });

const targetKey = (kind, target) => (isFileKind(kind) ? `file:${canonicalPath(target)}` : `${kind}:${target}`);

function defaultTitle(kind, target) {
  if (kind === 'message') return 'Message';
  if (kind !== 'url') return path.basename(target);
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

const paneTitle = (kind, target, title) => oneLine(title, MAX_TITLE) || oneLine(defaultTitle(kind, target), MAX_TITLE);

const idNumber = (id) => Number(id.slice(1)) || 0;

function cleanLayout(raw) {
  if (!raw || !Array.isArray(raw.panes) || !Number.isFinite(raw.updatedAt)) return null;
  const ids = new Set();
  const panes = raw.panes.filter((p) => {
    const ok = p && typeof p.id === 'string' && !ids.has(p.id) && KINDS.has(p.kind) && typeof p.target === 'string' && p.target;
    if (ok) ids.add(p.id);
    return ok;
  });
  const nextId = Math.max(Number.isInteger(raw.nextId) ? raw.nextId : 1, ...panes.map((p) => idNumber(p.id) + 1));
  const rev = Number.isInteger(raw.rev) && raw.rev > 0 ? raw.rev : 1;
  return { rev, nextId, panes: panes.slice(0, MAX_PANES), updatedAt: raw.updatedAt };
}

const publicLayout = (l) => ({ rev: l.rev, panes: l.panes.map((p) => ({ ...p })), updatedAt: l.updatedAt });

/**
 * Every write re-reads the file first, so two boards on one config dir add to each other's
 * layouts instead of overwriting them. The read-to-rename window is left open: both writers
 * are one user's own board tabs and CLI calls.
 *
 * @param {object} o
 * @param {() => object|null|undefined} o.load returns `{version: 2, sessions: {[id]: {rev, nextId, panes, updatedAt}}}`,
 *   null when there is no file, or undefined when the file has not changed since the last load or save
 * @param {(data: object) => void} o.save
 * @param {(sessionId: string, layout: object) => void} [o.onChange] called for each layout whose rev
 *   moved, from this store's writes and from `reload()` alike
 */
function createPaneStore({ load, save, onChange = () => {}, now = Date.now }) {
  let bySession = new Map();

  function reload() {
    const data = load();
    if (data === undefined) return;
    const next = new Map();
    const saved = data?.sessions;
    if (saved && typeof saved === 'object') {
      for (const [id, raw] of Object.entries(saved)) {
        const layout = cleanLayout(raw);
        if (layout) next.set(id, layout);
      }
    }
    const before = bySession;
    bySession = next;
    for (const [id, layout] of next) {
      if (before.get(id)?.rev !== layout.rev) onChange(id, publicLayout(layout));
    }
  }
  reload();

  const persist = () => save({ version: 2, sessions: Object.fromEntries(bySession) });

  function write(sessionId, layout) {
    layout.rev += 1;
    layout.updatedAt = now();
    bySession.set(sessionId, layout);
    persist();
    onChange(sessionId, publicLayout(layout));
    return publicLayout(layout);
  }

  function get(sessionId) {
    const layout = bySession.get(sessionId);
    return publicLayout(layout || emptyLayout());
  }

  // The same target added again returns its pane where it is, so a repeated `pane add` is harmless.
  // `show` marks a show card's file, which the board renders with the card's theme.
  function add(sessionId, { kind, target, title, show }) {
    if (!KINDS.has(kind)) throw httpError(400, `Unknown pane kind: ${kind}`, 'bad_kind');
    if (kind === 'message' && target.length > MAX_MESSAGE_TARGET) {
      throw httpError(400, `A message target holds at most ${MAX_MESSAGE_TARGET} characters`, 'bad_target');
    }
    reload();
    const layout = bySession.get(sessionId) || emptyLayout();
    const key = targetKey(kind, target);
    const existing = layout.panes.find((p) => targetKey(p.kind, p.target) === key);
    if (existing) return { pane: { ...existing }, added: false, layout: publicLayout(layout) };
    if (layout.panes.length >= MAX_PANES) throw httpError(409, `A session holds at most ${MAX_PANES} panes`, 'pane_limit');
    const pane = {
      id: `p${layout.nextId++}`,
      kind,
      target,
      title: paneTitle(kind, target, title),
      ...(show && { show: true }),
      addedAt: now(),
    };
    layout.panes.push(pane);
    return { pane: { ...pane }, added: true, layout: write(sessionId, layout) };
  }

  // Returns the new layout, or null when the session has no such pane. An emptied layout stays
  // until retention drops it, so its ids and rev keep counting up.
  function remove(sessionId, paneId) {
    reload();
    const layout = bySession.get(sessionId);
    const i = layout ? layout.panes.findIndex((p) => p.id === paneId) : -1;
    if (i < 0) return null;
    layout.panes.splice(i, 1);
    return write(sessionId, layout);
  }

  // Drops the show panes of these files; returns the new layout, or null when none matched.
  function removeShow(sessionId, files) {
    reload();
    const layout = bySession.get(sessionId);
    if (!layout) return null;
    const keys = new Set(files.map((f) => targetKey('html', f)));
    const kept = layout.panes.filter((p) => !(p.show && keys.has(targetKey(p.kind, p.target))));
    if (kept.length === layout.panes.length) return null;
    layout.panes = kept;
    return write(sessionId, layout);
  }

  // An empty title gives the pane its default title back. Returns null when the session has no such pane.
  function rename(sessionId, paneId, title) {
    reload();
    const layout = bySession.get(sessionId);
    const pane = layout?.panes.find((p) => p.id === paneId);
    if (!pane) return null;
    const next = paneTitle(pane.kind, pane.target, title);
    if (next === pane.title) return get(sessionId);
    pane.title = next;
    return write(sessionId, layout);
  }

  // `order` is every pane id of the session, in the new tab order.
  function reorder(sessionId, order) {
    reload();
    const layout = bySession.get(sessionId);
    const ids = layout ? layout.panes.map((p) => p.id) : [];
    const valid = Array.isArray(order) && order.length === ids.length && new Set(order).size === ids.length;
    if (!valid || !order.every((id) => ids.includes(id))) throw httpError(400, 'order must list every pane id once', 'bad_order');
    if (!layout || order.every((id, i) => id === ids[i])) return get(sessionId);
    layout.panes = order.map((id) => layout.panes.find((p) => p.id === id));
    return write(sessionId, layout);
  }

  // Returns how many layouts went; writes only when one did.
  function prune({ known, maxAgeMs }) {
    reload();
    const removed = pruneMap(bySession, (l) => l.updatedAt, { known, maxAgeMs, now: now() });
    if (removed) persist();
    return removed;
  }

  function fileTargets() {
    const out = new Set();
    for (const layout of bySession.values()) {
      for (const p of layout.panes) if (isFileKind(p.kind)) out.add(p.target);
    }
    return out;
  }

  return { get, add, remove, removeShow, rename, reorder, prune, reload, fileTargets };
}

module.exports = { createPaneStore, isOwnOrigin, portOf, MAX_PANES, MAX_TITLE };

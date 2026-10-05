// Per-session pane layout: the tabs next to Board. The server holds the only copy, so every
// board tab, the CLI and the agent see the same layout. Expiry: docs/retention.md.

const path = require('node:path');
const { canonicalPath } = require('./linked-docs');
const { isLoopbackAddress } = require('./net-guard');
const { pruneMap } = require('./retention');

const MAX_PANES = 50;
const KINDS = new Set(['url', 'file']);
const BOARD = 'board';

function paneError(status, message) {
  return Object.assign(new Error(message), { status });
}

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

const emptyLayout = () => ({ active: BOARD, panes: [], updatedAt: null });

const targetKey = (kind, target) => `${kind}:${kind === 'url' ? target : canonicalPath(target)}`;

function defaultTitle(kind, target) {
  if (kind !== 'url') return path.basename(target);
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

function cleanLayout(raw) {
  if (!raw || !Array.isArray(raw.panes) || !Number.isFinite(raw.updatedAt)) return null;
  const panes = raw.panes.filter(
    (p) => p && typeof p.id === 'string' && KINDS.has(p.kind) && typeof p.target === 'string' && p.target,
  );
  if (!panes.length) return null;
  const active = panes.some((p) => p.id === raw.active) ? raw.active : BOARD;
  return { active, panes: panes.slice(0, MAX_PANES), updatedAt: raw.updatedAt };
}

const copyLayout = (l) => ({ active: l.active, panes: l.panes.map((p) => ({ ...p })), updatedAt: l.updatedAt });

/**
 * @param {object} o
 * @param {() => object|null} o.load returns `{version: 1, sessions: {[id]: {active, panes, updatedAt}}}` or null
 * @param {(data: object) => void} o.save
 */
function createPaneStore({ load, save, now = Date.now }) {
  const bySession = new Map();
  const saved = load()?.sessions;
  if (saved && typeof saved === 'object') {
    for (const [id, raw] of Object.entries(saved)) {
      const layout = cleanLayout(raw);
      if (layout) bySession.set(id, layout);
    }
  }

  const persist = () => save({ version: 1, sessions: Object.fromEntries(bySession) });

  function get(sessionId) {
    const layout = bySession.get(sessionId);
    return layout ? copyLayout(layout) : emptyLayout();
  }

  function touch(sessionId, layout) {
    layout.updatedAt = now();
    if (layout.panes.length) bySession.set(sessionId, layout);
    else bySession.delete(sessionId);
    persist();
    return copyLayout(layout);
  }

  // The same target added again returns its pane where it is, so a repeated `pane add` is harmless.
  function add(sessionId, { kind, target, title }) {
    if (!KINDS.has(kind)) throw paneError(400, `Unknown pane kind: ${kind}`);
    const layout = bySession.get(sessionId) || emptyLayout();
    const key = targetKey(kind, target);
    const existing = layout.panes.find((p) => targetKey(p.kind, p.target) === key);
    if (existing) return { pane: { ...existing }, added: false, layout: copyLayout(layout) };
    if (layout.panes.length >= MAX_PANES) throw paneError(409, `A session holds at most ${MAX_PANES} panes`);
    const next = Math.max(0, ...layout.panes.map((p) => Number(p.id.slice(1)) || 0)) + 1;
    const pane = { id: `p${next}`, kind, target, title: title || defaultTitle(kind, target), addedAt: now() };
    layout.panes.push(pane);
    return { pane: { ...pane }, added: true, layout: touch(sessionId, layout) };
  }

  // Returns the new layout, or null when the session has no such pane.
  function remove(sessionId, paneId) {
    const layout = bySession.get(sessionId);
    const i = layout ? layout.panes.findIndex((p) => p.id === paneId) : -1;
    if (i < 0) return null;
    layout.panes.splice(i, 1);
    if (layout.active === paneId) layout.active = BOARD;
    return touch(sessionId, layout);
  }

  // `order` is every pane id of the session, in the new tab order.
  function update(sessionId, { active, order } = {}) {
    const layout = bySession.get(sessionId);
    const ids = layout ? layout.panes.map((p) => p.id) : [];
    if (active !== undefined && active !== BOARD && !ids.includes(active)) throw paneError(400, `No pane ${active}`);
    if (order !== undefined) {
      const valid = Array.isArray(order) && order.length === ids.length && new Set(order).size === ids.length;
      if (!valid || !order.every((id) => ids.includes(id))) throw paneError(400, 'order must list every pane id once');
    }
    if (!layout) return { changed: false, layout: emptyLayout() };
    const sameOrder = order === undefined || order.every((id, i) => id === ids[i]);
    if ((active === undefined || active === layout.active) && sameOrder) return { changed: false, layout: copyLayout(layout) };
    if (active !== undefined) layout.active = active;
    if (!sameOrder) layout.panes = order.map((id) => layout.panes.find((p) => p.id === id));
    return { changed: true, layout: touch(sessionId, layout) };
  }

  // Returns how many layouts went; writes only when one did.
  function prune({ known, maxAgeMs }) {
    const removed = pruneMap(bySession, (l) => l.updatedAt, { known, maxAgeMs, now: now() });
    if (removed) persist();
    return removed;
  }

  return { get, add, remove, update, prune };
}

module.exports = { createPaneStore, isOwnOrigin, MAX_PANES };

// Transient session groups: `dispatch start --group` (or the starter's own group) puts
// the started session and its starter together. A group lives while any member's claude
// runs, and for a grace period after; once none runs, only pinned members stay in it.
// The map is on disk so a pinned group outlives a server restart.

const GROUP_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_GROUP = 64;
// Covers a claude that has started but not yet registered, a resume, and registry lag.
const GRACE_MS = 60 * 1000;

function isGroupName(s) {
  return typeof s === 'string' && s.length <= MAX_GROUP && GROUP_RE.test(s);
}

function suggestGroupName(s) {
  return String(s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_GROUP)
    .replace(/-+$/, '');
}

/**
 * @param {object} o
 * @param {() => object|null} o.load returns `{sessions: {[id]: group}}` or null
 * @param {(data: object) => void} o.save
 * @param {(id: string) => boolean} o.isAlive
 * @param {() => Set<string>} o.pinnedIds
 */
function createGroupStore({ load, save, isAlive, pinnedIds, now = Date.now }) {
  const members = new Map();
  const liveAt = new Map();
  const saved = load()?.sessions;
  if (saved && typeof saved === 'object') {
    for (const [id, g] of Object.entries(saved)) if (isGroupName(g)) members.set(id, g);
  }
  for (const g of members.values()) liveAt.set(g, now());

  const persist = () => save({ version: 1, sessions: Object.fromEntries(members) });

  function join(group, ids) {
    let changed = false;
    for (const id of ids) {
      if (!id || members.get(id) === group) continue;
      members.set(id, group);
      changed = true;
    }
    liveAt.set(group, now());
    if (changed) persist();
  }

  function refresh() {
    const t = now();
    const byGroup = new Map();
    for (const [id, g] of members) {
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(id);
    }
    let pinned = null;
    let changed = false;
    for (const [g, ids] of byGroup) {
      if (ids.some(isAlive)) {
        liveAt.set(g, t);
        continue;
      }
      if (t - (liveAt.get(g) ?? 0) <= GRACE_MS) continue;
      pinned ??= pinnedIds();
      for (const id of ids) {
        if (pinned.has(id)) continue;
        members.delete(id);
        changed = true;
      }
      if (!ids.some((id) => pinned.has(id))) liveAt.delete(g);
    }
    if (changed) persist();
  }

  function groupOf(id) {
    refresh();
    return members.get(id) || null;
  }

  function snapshot() {
    refresh();
    return members;
  }

  return { join, groupOf, snapshot };
}

module.exports = { createGroupStore, isGroupName, suggestGroupName, GRACE_MS };

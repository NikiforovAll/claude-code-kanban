// User groups: named groups that hold projects and sessions, and may nest under another group.
// The CLI and plugins change them one operation at a time; the board writes its copy whole with
// `replace`. `groups` is one flat list; its order is the order of siblings. A member is in at
// most one group.

const { randomUUID } = require('node:crypto');
const { httpError } = require('./http-error');
const { oneLine } = require('./one-line');

const MAX_GROUPS = 200;
const MAX_MEMBERS = 500;
const MAX_RELEASED = 500;
const MAX_DEPTH = 8;
const MAX_NAME = 120;
const MAX_REF = 4096;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TYPES = new Set(['project', 'session']);

const fail = (status, message) => {
  throw httpError(status, message);
};

const isRef = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_REF;
const cleanName = (name) => (typeof name === 'string' && oneLine(name, MAX_NAME)) || null;
const memberKey = (m) => `${m.type}\0${m.ref}`;

function cleanMember(m) {
  if (!m || !TYPES.has(m.type) || !isRef(m.ref)) return null;
  const out = { type: m.type, ref: m.ref };
  if (m.type === 'session' && isRef(m.under)) out.under = m.under;
  else if (m.type === 'session' && m.loose === true) out.loose = true;
  if (m.type === 'session' && isRef(m.parent) && m.parent !== m.ref) out.parent = m.parent;
  return out;
}

const sameMember = (a, b) => a.type === b.type && a.ref === b.ref;

function wouldCycle(list, id, parent) {
  let depth = 0;
  for (let p = parent; p; p = list.find((g) => g.id === p)?.parent ?? null) {
    if (p === id || ++depth >= MAX_DEPTH) return true;
  }
  return false;
}

// `taken` holds member keys already placed; a member found again is dropped, so the first group
// that lists it keeps it.
function readGroups(list, taken = new Set()) {
  const out = [];
  const seen = new Set();
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || !ID_RE.test(g.id) || seen.has(g.id) || out.length >= MAX_GROUPS) continue;
    seen.add(g.id);
    const members = [];
    for (const m of Array.isArray(g.members) ? g.members : []) {
      const clean = cleanMember(m);
      if (!clean || members.length >= MAX_MEMBERS || taken.has(memberKey(clean))) continue;
      taken.add(memberKey(clean));
      members.push(clean);
    }
    out.push({ id: g.id, name: cleanName(g.name) || 'Group', parent: typeof g.parent === 'string' ? g.parent : null, members });
  }
  for (const g of out) {
    if (g.parent && (!seen.has(g.parent) || g.parent === g.id)) g.parent = null;
  }
  for (const g of out) if (wouldCycle(out, g.id, g.parent)) g.parent = null;
  return out;
}

const readReleased = (list) => [...new Set((Array.isArray(list) ? list : []).filter(isRef))].slice(-MAX_RELEASED);

/**
 * @param {object} o
 * @param {() => object|null|undefined} o.load `undefined` means the file has not changed since the
 *   last load
 * @param {(data: object) => void} o.save
 */
function createUserGroupStore({ load, save, now = () => new Date().toISOString(), newId = randomUUID }) {
  let groups = [];
  let released = [];
  let rev = 0;
  let migratedAt = null;

  // Another board on the same config dir writes the same file. Returns whether the rev moved.
  function reload() {
    const saved = load();
    if (saved === undefined) return false;
    const before = rev;
    const data = saved && typeof saved === 'object' ? saved : {};
    rev = Number.isSafeInteger(data.rev) && data.rev >= 0 ? data.rev : 0;
    migratedAt = typeof data.groupsMigratedAt === 'string' ? data.groupsMigratedAt : null;
    groups = readGroups(data.groups);
    released = readReleased(data.released);
    return rev !== before;
  }
  reload();

  const byId = (id) => groups.find((g) => g.id === id) || null;
  const mustGet = (id) => byId(id) || fail(404, `no group ${id}`);
  const groupOf = (member) => groups.find((g) => g.members.some((m) => sameMember(m, member)));
  const byName = (name) => groups.filter((g) => g.name.toLowerCase() === name.toLowerCase());

  const state = () => ({ version: 2, rev, groupsMigratedAt: migratedAt, groups, released });

  function commit() {
    rev++;
    save(state());
    return state();
  }

  function checkParent(id, parent) {
    if (parent == null) return null;
    if (typeof parent !== 'string' || !byId(parent)) fail(400, `no parent group ${parent}`);
    if (wouldCycle(groups, id, parent)) fail(400, 'parent would make a cycle or nest too deep');
    return parent;
  }

  function moveBefore(list, item, before, same) {
    const from = list.indexOf(item);
    if (from >= 0) list.splice(from, 1);
    const to = before == null ? -1 : list.findIndex((x) => same(x, before));
    if (to >= 0) list.splice(to, 0, item);
    else list.push(item);
  }

  function detach(keys) {
    for (const g of groups) g.members = g.members.filter((m) => !keys.has(memberKey(m)));
  }

  function addGroup({ id, name, parent = null, before = null, members = [] }) {
    if (groups.length >= MAX_GROUPS) fail(422, `at most ${MAX_GROUPS} groups`);
    if (id != null && (!ID_RE.test(id) || byId(id))) fail(400, 'id must be unique, 1-64 of [A-Za-z0-9_-]');
    const gid = id ?? newGroupId();
    const clean = readGroups([{ id: gid, members }])[0].members;
    const group = { id: gid, name: cleanName(name) || `Group ${groups.length + 1}`, parent: checkParent(gid, parent), members: clean };
    detach(new Set(clean.map(memberKey)));
    groups.push(group);
    moveBefore(groups, group, before, (g, id) => g.id === id);
    return group;
  }

  function create(opts = {}) {
    const group = addGroup(opts);
    return { group: group.id, ...commit() };
  }

  const pathOf = (group) => {
    const names = [];
    for (let g = group; g; g = byId(g.parent)) names.unshift(g.name);
    return names.join('/');
  };

  // A path names a top-level group, then a child at each step. `make` adds the missing steps.
  function findPath(path, make) {
    const steps = path.split('/').map(cleanName);
    if (steps.some((s) => !s)) fail(400, `group path "${path}" has an empty step`);
    if (steps.length > MAX_DEPTH) fail(400, `a group path has at most ${MAX_DEPTH} steps`);
    let parent = null;
    let created = false;
    for (const step of steps) {
      const named = byName(step).filter((g) => g.parent === (parent?.id ?? null));
      if (named.length > 1) fail(400, `${named.length} groups are named "${pathOf(named[0])}"; pass one id: ${named.map((g) => g.id).join(', ')}`);
      if (named.length) parent = named[0];
      else if (make) [parent, created] = [addGroup({ name: step, parent: parent?.id ?? null }), true];
      else return fail(404, `no group "${parent ? `${pathOf(parent)}/` : ''}${step}"; pass --create to make it, or see \`group list\``);
    }
    return { group: parent, created };
  }

  // The CLI names a group the way the user sees it: by id, by name ignoring case, or by path.
  function findGroup(key, make) {
    if (!isRef(key) || !key.trim()) fail(400, 'group must be a group id, name or path');
    const hit = byId(key);
    if (hit) return { group: hit, created: false };
    const name = cleanName(key);
    const named = byName(name);
    if (!named.length && key.includes('/')) return findPath(key, make);
    if (named.length > 1) fail(400, `${named.length} groups are named "${name}"; pass one id: ${named.map((g) => g.id).join(', ')}`);
    if (named.length) return { group: named[0], created: false };
    if (make) return { group: addGroup({ name }), created: true };
    const known = groups.map((g) => g.name).join(', ');
    return fail(404, `no group "${name}"${known ? ` (groups: ${known})` : ''}; pass --create to make it, or see \`group list\``);
  }

  // The group the board shows `peer` in: its own placement, its project's, or a user group named
  // like its dispatch group. A new group holds `peer` too.
  function peerGroup({ ref, project, dispatchGroup, name }, make) {
    const dispatch = dispatchGroup && !released.includes(ref) ? dispatchGroup : null;
    const hit =
      groupOf({ type: 'session', ref }) ||
      (project && groupOf({ type: 'project', ref: project })) ||
      (dispatch && byName(dispatch)[0]);
    if (hit) return { group: hit, created: false };
    if (!make) return fail(404, `session ${ref.slice(0, 8)} is in no group; pass --create to make one`);
    return { group: addGroup({ name: dispatch || name, members: [{ type: 'session', ref }] }), created: true };
  }

  // A session placed with no `under` or `loose` shows in its project's block when the group holds
  // its project, else on the group's own level, as the board's context menu places it.
  // `peer` ({ref, project, dispatchGroup, name}) puts the session in the group of that session.
  // `parent` names the session the board shows it under; null clears it.
  function groupSession(ref, { group, peer, parent, create: make = false } = {}) {
    // Checked before findGroup, which may add the group.
    if (!isRef(ref)) fail(400, 'session id is required');
    if (parent != null && (!isRef(parent) || parent === ref)) fail(400, 'parent must be a different session');
    const member = { type: 'session', ref, parent };
    const left = groupOf(member)?.name ?? null;
    if (peer) {
      if (!isRef(peer.ref) || peer.ref === ref) fail(400, 'the other session must be a different session');
    } else if (group == null) {
      if (left === null && released.includes(ref)) return { group: null, left, ...state() };
      return { group: null, left, ...ungroup({ ...member, release: true }) };
    }
    const { group: target, created } = peer ? peerGroup(peer, make) : findGroup(group, make);
    return { group: target.id, name: target.name, path: pathOf(target), created, left, ...place(target.id, member) };
  }

  function update(id, { name, parent, before } = {}) {
    const group = mustGet(id);
    const nextName = name === undefined ? group.name : cleanName(name) || fail(400, 'name must be a non-empty string');
    const nextParent = parent === undefined ? group.parent : checkParent(id, parent);
    if (before != null && !byId(before)) fail(400, `no group ${before}`);
    group.name = nextName;
    group.parent = nextParent;
    if (before !== undefined) moveBefore(groups, group, before, (g, id) => g.id === id);
    return commit();
  }

  function remove(id) {
    const group = mustGet(id);
    for (const g of groups) if (g.parent === id) g.parent = group.parent;
    groups = groups.filter((g) => g !== group);
    return commit();
  }

  // `supersede` names session members to drop with the move: the sessions of a project being
  // moved, which only the caller can list. With no `parent`, a move inside the group keeps it.
  function place(id, { type, ref, under, loose, parent, before = null, supersede = [] } = {}) {
    const group = mustGet(id);
    const kept = parent === undefined ? group.members.find((m) => sameMember(m, { type, ref }))?.parent : parent;
    const member = cleanMember({ type, ref, under, loose, parent: kept }) || fail(400, 'type must be project or session, with a ref');
    if (group.members.filter((m) => !sameMember(m, member)).length >= MAX_MEMBERS) fail(422, `at most ${MAX_MEMBERS} members`);
    const keys = new Set([memberKey(member)]);
    for (const sid of Array.isArray(supersede) ? supersede : []) if (isRef(sid)) keys.add(memberKey({ type: 'session', ref: sid }));
    detach(keys);
    moveBefore(group.members, member, before, sameMember);
    return commit();
  }

  function ungroup({ type, ref, release = false } = {}) {
    const member = cleanMember({ type, ref }) || fail(400, 'type must be project or session, with a ref');
    detach(new Set([memberKey(member)]));
    if (release && type === 'session') addReleased([ref]);
    return commit();
  }

  function addReleased(ids) {
    released = readReleased([...released.filter((x) => !ids.includes(x)), ...ids]);
  }

  function release(ids) {
    if (!Array.isArray(ids)) fail(400, 'ids must be an array');
    addReleased(ids);
    return commit();
  }

  // The board edits its own copy and writes it whole; `rev` must be the one it last read.
  function replace({ rev: base, groups: list, released: rel } = {}) {
    if (base !== rev) fail(409, 'groups changed since rev; read them again');
    groups = readGroups(list);
    released = readReleased(rel);
    return commit();
  }

  // The board's groups from before the server kept them. Only the first import is taken; a later
  // one changes nothing. A member the server already holds stays where it is.
  function importLocal({ groups: list, released: rel } = {}) {
    if (migratedAt) return { imported: false, ...state() };
    const taken = new Set(groups.flatMap((g) => g.members.map(memberKey)));
    for (const g of readGroups(list, taken)) {
      if (groups.length >= MAX_GROUPS) break;
      groups.push({ ...g, id: byId(g.id) ? newGroupId() : g.id, parent: null });
    }
    addReleased(readReleased(rel));
    migratedAt = now();
    return { imported: true, ...commit() };
  }

  function newGroupId() {
    let id;
    do id = newId();
    while (byId(id));
    return id;
  }

  return { state, reload, create, update, remove, place, ungroup, release, replace, importLocal, groupSession };
}

module.exports = { createUserGroupStore };

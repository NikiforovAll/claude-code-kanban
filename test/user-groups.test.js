const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createUserGroupStore } = require('../lib/user-groups');

function harness(initial = null) {
  const disk = { data: initial, saves: 0 };
  let n = 0;
  const store = () =>
    createUserGroupStore({
      load: () => disk.data,
      save: (data) => {
        disk.data = JSON.parse(JSON.stringify(data));
        disk.saves++;
      },
      now: () => '2026-10-09T00:00:00.000Z',
      newId: () => `g${++n}`,
    });
  return { disk, store };
}

const status = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e.status, e.message);
    return e.status;
  }
  assert.fail('expected a GroupError');
};

describe('user groups', () => {
  it('creates, renames and survives a restart', () => {
    const { disk, store } = harness();
    const s = store();
    const out = s.create({ name: 'Work' });
    assert.equal(out.group, 'g1');
    assert.equal(out.rev, 1);
    s.update('g1', { name: '  Home ' });
    const again = store().state();
    assert.equal(again.rev, 2);
    assert.deepEqual(again.groups, [{ id: 'g1', name: 'Home', parent: null, members: [] }]);
    assert.equal(disk.saves, 2);
  });

  it('nests and moves groups, and refuses a cycle', () => {
    const s = harness().store();
    s.create({ id: 'a', name: 'A' });
    s.create({ id: 'b', name: 'B', parent: 'a' });
    s.create({ id: 'c', name: 'C', parent: 'b' });
    assert.equal(status(() => s.update('a', { parent: 'c' })), 400);
    assert.equal(status(() => s.update('a', { parent: 'a' })), 400);
    assert.equal(status(() => s.create({ name: 'x', parent: 'nope' })), 400);
    s.update('c', { parent: null, before: 'a' });
    assert.deepEqual(
      s.state().groups.map((g) => [g.id, g.parent]),
      [['c', null], ['a', null], ['b', 'a']],
    );
  });

  it('lifts children to the parent of a deleted group', () => {
    const s = harness().store();
    s.create({ id: 'a', name: 'A' });
    s.create({ id: 'b', name: 'B', parent: 'a' });
    s.create({ id: 'c', name: 'C', parent: 'b' });
    s.remove('b');
    assert.deepEqual(s.state().groups.map((g) => [g.id, g.parent]), [['a', null], ['c', 'a']]);
    assert.equal(status(() => s.remove('b')), 404);
  });

  it('places a member in one group only, in order, and drops superseded sessions', () => {
    const s = harness().store();
    s.create({ id: 'a', name: 'A' });
    s.create({ id: 'b', name: 'B' });
    s.place('a', { type: 'session', ref: 's1' });
    s.place('a', { type: 'session', ref: 's2', loose: true });
    s.place('a', { type: 'session', ref: 's2', loose: true, before: { type: 'session', ref: 's1' } });
    assert.deepEqual(s.state().groups[0].members, [{ type: 'session', ref: 's2', loose: true }, { type: 'session', ref: 's1' }]);
    s.place('b', { type: 'session', ref: 's1', under: 'C:/p' });
    s.place('b', { type: 'project', ref: 'C:/q', supersede: ['s2'] });
    const [a, b] = s.state().groups;
    assert.deepEqual(a.members, []);
    assert.deepEqual(b.members, [{ type: 'session', ref: 's1', under: 'C:/p' }, { type: 'project', ref: 'C:/q' }]);
    assert.equal(status(() => s.place('a', { type: 'task', ref: 'x' })), 400);
  });

  it('ungroups and releases a session', () => {
    const s = harness().store();
    s.create({ id: 'a', members: [{ type: 'session', ref: 's1' }] });
    s.ungroup({ type: 'session', ref: 's1', release: true });
    s.release(['s2', 's1']);
    const st = s.state();
    assert.deepEqual(st.groups[0].members, []);
    assert.deepEqual(st.released, ['s2', 's1']);
  });

  it('imports the board groups once and keeps members the server holds', () => {
    const { store } = harness();
    const s = store();
    s.create({ id: 'srv', name: 'Server', members: [{ type: 'session', ref: 's1' }] });
    const local = {
      version: 1,
      groups: [
        { id: 'g_x', name: 'Local', members: [{ type: 'session', ref: 's1' }, { type: 'project', ref: 'C:/p' }, { type: 'bad' }] },
        { id: 'srv', name: 'Clash', members: [] },
      ],
      released: ['r1', 7],
    };
    const out = s.importLocal(local);
    assert.equal(out.groupsMigratedAt, '2026-10-09T00:00:00.000Z');
    assert.deepEqual(
      out.groups.map((g) => [g.id, g.name, g.members.map((m) => m.ref)]),
      [['srv', 'Server', ['s1']], ['g_x', 'Local', ['C:/p']], ['g1', 'Clash', []]],
    );
    assert.deepEqual(out.released, ['r1']);
    assert.equal(out.imported, true);
    const again = store().importLocal(local);
    assert.equal(again.imported, false);
    assert.equal(again.rev, out.rev);
  });

  it('keeps a member in the first group that lists it', () => {
    const s = harness().store();
    const out = s.replace({
      rev: 0,
      groups: [
        { id: 'a', members: [{ type: 'session', ref: 's1' }] },
        { id: 'b', members: [{ type: 'session', ref: 's1' }, { type: 'session', ref: 's2' }] },
      ],
    });
    assert.deepEqual(out.groups.map((g) => g.members.map((m) => m.ref)), [['s1'], ['s2']]);
  });

  it('strips control characters from names and caps groups with 422', () => {
    const s = harness().store();
    s.create({ id: 'a', name: 'two\nlines' });
    assert.equal(s.state().groups[0].name, 'two lines');
    for (let i = 1; i < 200; i++) s.create({ name: `g${i}` });
    assert.equal(status(() => s.create({ name: 'over' })), 422);
  });

  it('replaces the whole document only at the current rev', () => {
    const s = harness().store();
    s.create({ id: 'a', name: 'A' });
    const out = s.replace({ rev: 1, groups: [{ id: 'b', name: 'B', parent: null, members: [] }, { id: 'c', name: 'C', parent: 'b' }], released: ['r'] });
    assert.equal(out.rev, 2);
    assert.deepEqual(out.groups.map((g) => [g.id, g.parent]), [['b', null], ['c', 'b']]);
    assert.equal(status(() => s.replace({ rev: 1, groups: [] })), 409);
    assert.equal(s.state().groups.length, 2);
  });

  it('changes nothing when an update fails', () => {
    const s = harness().store();
    s.create({ id: 'a', name: 'A' });
    assert.equal(status(() => s.update('a', { name: 'New', before: 'missing' })), 400);
    assert.equal(status(() => s.update('a', { name: 'New', parent: 'missing' })), 400);
    assert.deepEqual([s.state().rev, s.state().groups[0].name], [1, 'A']);
  });

  it('reloads a write made by another board', () => {
    const { disk, store } = harness();
    const a = store();
    const b = store();
    a.create({ id: 'x', name: 'X' });
    assert.equal(b.reload(), true);
    assert.deepEqual(b.state().groups.map((g) => g.id), ['x']);
    b.create({ id: 'y', name: 'Y' });
    assert.deepEqual(disk.data.groups.map((g) => g.id), ['x', 'y']);
    assert.equal(disk.data.rev, 2);
  });

  it('groups a session by group name or id, and ungroups it', () => {
    const s = harness().store();
    s.create({ id: 'a', name: 'Auth Work' });
    s.create({ id: 'b', name: 'B' });
    const moved = s.groupSession('s1', { group: 'auth work' });
    assert.deepEqual([moved.group, moved.name, moved.created, moved.left], ['a', 'Auth Work', false, null]);
    const again = s.groupSession('s1', { group: 'b' });
    assert.equal(again.left, 'Auth Work');
    assert.deepEqual(again.groups.map((g) => g.members.map((m) => m.ref)), [[], ['s1']]);
    const out = s.groupSession('s1', { group: null });
    assert.deepEqual([out.group, out.left, out.released], [null, 'B', ['s1']]);
    assert.deepEqual(out.groups.map((g) => g.members.length), [0, 0]);
  });

  it('refuses an unknown or ambiguous group name unless asked to create it', () => {
    const s = harness().store();
    s.create({ id: 'a', name: 'Dup' });
    s.create({ id: 'b', name: 'dup' });
    assert.equal(status(() => s.groupSession('s1', { group: 'Dup' })), 400);
    assert.equal(status(() => s.groupSession('s1', { group: 'Nope' })), 404);
    assert.equal(status(() => s.groupSession('s1', { group: ' ' })), 400);
    assert.equal(s.state().rev, 2);
    const made = s.groupSession('s1', { group: 'Nope', create: true });
    assert.deepEqual([made.created, made.name, made.rev], [true, 'Nope', 3]);
    assert.deepEqual(made.groups.at(-1).members, [{ type: 'session', ref: 's1' }]);
  });

  it('puts a session in the group another session shows in', () => {
    const s = harness().store();
    s.create({ id: 'a', name: 'A', members: [{ type: 'session', ref: 'p1' }] });
    s.create({ id: 'b', name: 'B', members: [{ type: 'project', ref: 'C:/repo' }] });
    s.create({ id: 'c', name: 'api-work' });
    assert.equal(s.groupSession('s1', { peer: { ref: 'p1', project: 'C:/repo' } }).group, 'a');
    assert.equal(s.groupSession('s1', { peer: { ref: 'p2', project: 'C:/repo' } }).group, 'b');
    assert.equal(s.groupSession('s1', { peer: { ref: 'p3', dispatchGroup: 'api-work' } }).group, 'c');
    assert.equal(status(() => s.groupSession('s1', { peer: { ref: 'p4' } })), 404);
    assert.equal(status(() => s.groupSession('s1', { peer: { ref: 's1' } })), 400);
    const made = s.groupSession('s1', { peer: { ref: 'p4', name: 'Fix login' }, create: true });
    assert.deepEqual([made.created, made.name], [true, 'Fix login']);
    assert.deepEqual(made.groups.at(-1).members.map((m) => m.ref), ['p4', 's1']);
  });

  it('drops malformed data on load', () => {
    const { store } = harness({
      rev: 4,
      groups: [
        { id: 'a', name: '', parent: 'b', members: [{ type: 'session', ref: 's' }, { type: 'session', ref: 's' }] },
        { id: 'b', name: 'B', parent: 'a' },
        { id: 'bad id' },
        { id: 'c', name: 'C', parent: 'missing' },
      ],
    });
    const st = store().state();
    assert.equal(st.rev, 4);
    assert.equal(st.groupsMigratedAt, null);
    assert.deepEqual(
      st.groups.map((g) => [g.id, g.name, g.parent, g.members.length]),
      [['a', 'Group', null, 1], ['b', 'B', 'a', 0], ['c', 'C', null, 0]],
    );
  });
});

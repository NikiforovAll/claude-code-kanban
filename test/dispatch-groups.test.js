const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createGroupStore, isGroupName, suggestGroupName, GRACE_MS } = require('../lib/dispatch-groups');

function harness(initial = null) {
  const state = { t: 1000, alive: new Set(), pinned: new Set(), disk: initial };
  const store = () =>
    createGroupStore({
      load: () => state.disk,
      save: (data) => { state.disk = JSON.parse(JSON.stringify(data)); },
      isAlive: (id) => state.alive.has(id),
      pinnedIds: () => state.pinned,
      now: () => state.t,
    });
  return { state, store };
}

describe('group names', () => {
  it('accepts kebab-case only', () => {
    for (const ok of ['auth', 'auth-refactor', 'v2-api-3']) assert.ok(isGroupName(ok), ok);
    for (const bad of ['', 'Auth', 'auth_refactor', 'auth--x', '-auth', 'auth-', 'a b', 'x'.repeat(65), null]) {
      assert.ok(!isGroupName(bad), String(bad));
    }
  });

  it('suggests the kebab form', () => {
    assert.equal(suggestGroupName('Auth Refactor'), 'auth-refactor');
    assert.equal(suggestGroupName('authRefactor_v2'), 'auth-refactor-v2');
    assert.equal(suggestGroupName('--'), '');
  });
});

describe('transient groups', () => {
  const groupOf = (groups, id) => groups.snapshot().get(id) ?? null;

  it('keeps members while one runs, then dissolves after the grace', () => {
    const { state, store } = harness();
    const groups = store();
    groups.join('auth', ['a', 'b']);
    state.alive.add('b');
    state.t += GRACE_MS * 5;
    assert.equal(groupOf(groups, 'a'), 'auth');
    state.alive.clear();
    state.t += GRACE_MS - 1;
    assert.equal(groupOf(groups, 'b'), 'auth');
    state.t += 2;
    assert.equal(groupOf(groups, 'a'), null);
    assert.equal(groupOf(groups, 'b'), null);
    assert.deepEqual(state.disk.sessions, {});
  });

  it('counts a fresh join as live before its session registers', () => {
    const { state, store } = harness();
    const groups = store();
    groups.join('auth', ['child']);
    state.t += GRACE_MS / 2;
    assert.equal(groupOf(groups, 'child'), 'auth');
  });

  it('keeps only pinned members once none runs, and they survive a restart', () => {
    const { state, store } = harness();
    store().join('auth', ['starter', 'child']);
    state.pinned.add('starter');
    state.t += GRACE_MS + 1;
    const restarted = store();
    state.t += GRACE_MS + 1;
    assert.deepEqual([...restarted.snapshot()], [['starter', 'auth']]);
    assert.deepEqual(state.disk.sessions, { starter: 'auth' });
  });

  it('ignores malformed entries and old starter links on disk', () => {
    const { state, store } = harness({ sessions: { a: 'Bad Name', b: 'ok' }, starters: { b: 'starter' } });
    const groups = store();
    assert.deepEqual([...groups.snapshot()], [['b', 'ok']]);
    groups.join('ok', ['c']);
    assert.deepEqual(state.disk, { version: 1, sessions: { b: 'ok', c: 'ok' } });
  });
});

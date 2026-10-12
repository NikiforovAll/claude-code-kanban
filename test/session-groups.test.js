const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];

const { sgHostOf } = vm.runInNewContext(`${fn('sgHostOf')}\n({ sgHostOf })`, {
  sessionProjectKey: (s) => s.project,
});

describe('sgHostOf', () => {
  const session = { id: 's1', project: 'C:/repo/.claude/worktrees/w' };

  it('gives the project block a user group holds the session under', () => {
    const group = {
      id: 'g1',
      members: [
        { type: 'project', ref: 'C:/repo' },
        { type: 'session', ref: 's1', under: 'C:/repo' },
      ],
    };
    assert.equal(sgHostOf(group, session), 'C:/repo');
  });
});

describe('expandActiveGroups', () => {
  function setup() {
    const ctx = {
      sessions: [],
      calls: [],
      persisted: 0,
      console: { error() {} },
      isSessionActive: () => true,
      persistCollapsedGroups() {
        ctx.persisted++;
      },
      uncollapseFor(s) {
        ctx.calls.push(s.id);
        if (s.id === 'bad') throw new Error('boom');
        return true;
      },
    };
    vm.runInNewContext(`let prevActiveSessionIds = null;\n${fn('expandActiveGroups')}\nthis.expandActiveGroups = expandActiveGroups;`, ctx);
    return ctx;
  }

  it('skips a session whose uncollapse throws and does not retry it on the next render', () => {
    const ctx = setup();
    ctx.expandActiveGroups({ onlyNew: true });
    ctx.sessions = [{ id: 'bad' }, { id: 'good' }];
    assert.doesNotThrow(() => ctx.expandActiveGroups({ onlyNew: true }));
    assert.deepEqual(ctx.calls, ['bad', 'good']);
    assert.equal(ctx.persisted, 1);
    ctx.expandActiveGroups({ onlyNew: true });
    assert.deepEqual(ctx.calls, ['bad', 'good']);
  });
});

describe('sgSweepTransient', () => {
  const sweep = (groups, { shown = [], running = [], specs = [], dismissed = [], ...state } = {}) => {
    const ctx = {
      sgRev: 1,
      sessionGroups: groups,
      zenGroup: null,
      zenMode: false,
      sessionFilter: 'active',
      sessionsHasMore: false,
      searchQuery: '',
      activityFilter: new Set(),
      filterProject: '',
      getFilteredSessions: () => shown.map((id) => ({ id })),
      dismissedSessionIds: new Set(dismissed),
      runningTerminals: new Set(running),
      dispatchSpecs: new Map(specs.map((id) => [id, {}])),
      collapsedProjectGroups: new Set(['user-group:t1']),
      sgKey: (id) => `user-group:${id}`,
      persisted: 0,
      persistSessionGroups() { ctx.persisted++; },
      collapsedSaved: 0,
      persistCollapsedGroups() { ctx.collapsedSaved++; },
      groupTree: require('../public/group-tree'),
      ...state,
    };
    vm.runInNewContext(`${fn('sgListFiltered')}\n${fn('sgSweepTransient')}\nsgSweepTransient()`, ctx);
    return ctx;
  };
  const member = (ref) => ({ type: 'session', ref });

  it('deletes a transient group the Active view shows none of, and drops its collapse key', () => {
    const ctx = sweep([
      { id: 't1', parent: null, transient: true, members: [member('a')] },
      { id: 'u1', parent: null, members: [] },
    ]);
    assert.deepEqual(ctx.sessionGroups.map((g) => g.id), ['u1']);
    assert.equal(ctx.collapsedProjectGroups.size, 0);
    assert.equal(ctx.collapsedSaved, 1);
    assert.equal(ctx.persisted, 1);
  });

  it('keeps one with a shown, running or starting session, but not a dismissed one', () => {
    const groups = () => [
      { id: 'shown', parent: null, transient: true, members: [member('a')] },
      { id: 'running', parent: null, transient: true, members: [member('b')] },
      { id: 'starting', parent: null, transient: true, members: [member('c')] },
      { id: 'dismissed', parent: null, transient: true, members: [member('d')] },
    ];
    const ctx = sweep(groups(), { shown: ['a'], running: ['b', 'd'], specs: ['c'], dismissed: ['d'] });
    assert.deepEqual(ctx.sessionGroups.map((g) => g.id), ['shown', 'running', 'starting']);
  });

  it('keeps a transient parent while a child stays, and deletes both when the child goes', () => {
    const tree = () => [
      { id: 'p', parent: null, transient: true, members: [] },
      { id: 'c', parent: 'p', transient: true, members: [member('a')] },
      { id: 'k', parent: 'p', members: [] },
    ];
    assert.deepEqual(sweep(tree()).sessionGroups.map((g) => g.id), ['p', 'k'], 'a kept child holds its parent');
    const all = tree().filter((g) => g.id !== 'k');
    assert.deepEqual(sweep(all).sessionGroups.map((g) => g.id), []);
    assert.deepEqual(sweep(tree().filter((g) => g.id !== 'k'), { shown: ['a'] }).sessionGroups.map((g) => g.id), ['p', 'c']);
  });

  it('does nothing on a list that cannot prove a session left', () => {
    const one = () => [{ id: 't1', parent: null, transient: true, members: [member('a')] }];
    for (const state of [{ sessionsHasMore: true }, { searchQuery: 'x' }, { sessionFilter: 'all' }, { filterProject: '/p' }, { sgRev: null }, { zenMode: true }]) {
      const ctx = sweep(one(), state);
      assert.equal(ctx.sessionGroups.length, 1, JSON.stringify(state));
      assert.equal(ctx.persisted, 0);
    }
    assert.equal(sweep(one(), { filterProject: '__recent__' }).sessionGroups.length, 0, 'Recent is the full list');
  });
});

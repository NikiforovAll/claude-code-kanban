const { describe, it } = require('node:test');
const assert = require('node:assert');
const { projectMatcher, isExactProjectFilter, sessionProjectKey } = require('../public/project-match');

describe('projectMatcher', () => {
  it('selects one project for an absolute path', () => {
    const m = projectMatcher('C:\\dev\\app\\');
    assert.equal(m('c:/dev/app'), true);
    assert.equal(m('C:\\Dev\\App'), true);
    assert.equal(m('C:/dev/app-2'), false);
    assert.equal(m('C:/dev/app/sub'), false);
  });

  it('selects one project for a POSIX path', () => {
    const m = projectMatcher('/home/me/app');
    assert.equal(m('/home/me/app/'), true);
    assert.equal(m('/home/me/app-2'), false);
  });

  it('selects the linked worktrees of a repo path', () => {
    const m = projectMatcher('C:\\dev\\app');
    assert.equal(m('C:\\dev\\app\\.claude\\worktrees\\squid', 'C:\\dev\\app'), true);
    assert.equal(m('C:\\dev\\app-feature', 'c:/dev/app'), true);
    assert.equal(m('C:\\dev\\other-feature', 'C:\\dev\\other'), false);
    assert.equal(projectMatcher('C:\\dev\\app-feature')('C:\\dev\\app', undefined), false);
  });

  it('matches a part of the path for other text', () => {
    const m = projectMatcher(' dev\\ap ');
    assert.equal(m('C:/dev/app'), true);
    assert.equal(m('C:/dev/app-2'), true);
    assert.equal(m('C:/src/app'), false);
  });

  it('never matches a session with no project', () => {
    assert.equal(projectMatcher('app')(null), false);
    assert.equal(projectMatcher('app')(''), false);
  });

  it('tells an exact filter from a partial one', () => {
    assert.equal(isExactProjectFilter('C:/dev/app'), true);
    assert.equal(isExactProjectFilter('/srv'), true);
    assert.equal(isExactProjectFilter('app'), false);
  });
});

describe('sessionProjectKey', () => {
  it('lists worktree sessions under their repo, next to its own sessions', () => {
    const repo = 'C:\\dev\\app';
    const list = [
      { id: 'main', project: repo, worktree: null },
      { id: 'a', project: `${repo}\\.claude\\worktrees\\fix-a`, worktree: { repo, name: 'fix-a' } },
      { id: 'b', project: 'C:\\dev\\app-fix-b', worktree: { repo, name: 'app-fix-b' } },
    ];
    assert.deepEqual([...new Set(list.map(sessionProjectKey))], [repo]);
  });

  it('falls back to the project, then to null', () => {
    assert.equal(sessionProjectKey({ project: '/srv/app' }), '/srv/app');
    assert.equal(sessionProjectKey({ project: null }), null);
    assert.equal(sessionProjectKey(undefined), null);
  });
});

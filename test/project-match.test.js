const { describe, it } = require('node:test');
const assert = require('node:assert');
const { projectMatcher, isExactProjectFilter } = require('../public/project-match');

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

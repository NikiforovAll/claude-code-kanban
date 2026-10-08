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

  it('gives no host in a transient dispatch group', () => {
    const { sgTransientGroup } = vm.runInNewContext(`${fn('sgTransientGroup')}\n({ sgTransientGroup })`, {
      transientGroups: new Map(),
    });
    assert.equal(sgHostOf(sgTransientGroup('run'), session), null);
  });

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

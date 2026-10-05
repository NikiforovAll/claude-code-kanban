const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { COMMANDS } = require('../cli');

const SKILL = path.join(__dirname, '..', 'plugin', 'plugins', 'claude-code-kanban', 'skills', 'kanban', 'SKILL.md');

function skillTable() {
  const rows = {};
  for (const line of fs.readFileSync(SKILL, 'utf8').split(/\r?\n/)) {
    const m = /^\| `([a-z]+)` \| (.*) \|$/.exec(line);
    if (!m) continue;
    rows[m[1]] = [...m[2].matchAll(/`([a-z]+)[^`]*`/g)].map((v) => v[1]);
  }
  return rows;
}

describe('kanban skill', () => {
  it('lists every board command and its subcommands', () => {
    const rows = skillTable();
    const nouns = Object.keys(COMMANDS).filter((n) => n !== 'skills');
    assert.deepEqual(Object.keys(rows).sort(), nouns.sort());
    for (const noun of nouns) assert.deepEqual(rows[noun].sort(), Object.keys(COMMANDS[noun].verbs).sort(), noun);
  });
});

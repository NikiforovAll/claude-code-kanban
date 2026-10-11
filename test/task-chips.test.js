const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function appFunction(name, globals = {}) {
  const src = new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(app)[0];
  const context = vm.createContext(globals);
  vm.runInContext(src, context);
  return context[name];
}

const taskChips = appFunction('taskChips');
const plain = (v) => JSON.parse(JSON.stringify(v));
const chips = (list) => plain(taskChips({ metadata: { chips: list } }));

describe('taskChips', () => {
  it('reads label, title and tone', () => {
    assert.deepEqual(chips([{ label: 'closed', title: 'Closed by the supervisor', tone: 'warn' }]), [
      { label: 'closed', title: 'Closed by the supervisor', tone: 'warn' },
    ]);
  });

  it('is empty without metadata or with a chips value that is not a list', () => {
    assert.deepEqual(plain(taskChips({})), []);
    assert.deepEqual(chips('closed'), []);
    assert.deepEqual(chips({ label: 'closed' }), []);
  });

  it('drops entries without a label and keeps the first 4', () => {
    const list = [null, { label: '' }, { label: '  ' }, { title: 'x' }, ...'abcdef'.split('').map((label) => ({ label }))];
    assert.deepEqual(
      chips(list).map((c) => c.label),
      ['a', 'b', 'c', 'd'],
    );
  });

  it('caps the label and the title, and falls back to muted for an unknown tone', () => {
    const [c] = chips([{ label: 'x'.repeat(40), title: 'y'.repeat(300), tone: 'red' }]);
    assert.deepEqual([c.label.length, c.title.length, c.tone], [24, 200, 'muted']);
  });

  it('ignores a title that is not a string', () => {
    assert.equal(chips([{ label: 'a', title: 5 }])[0].title, '');
  });
});

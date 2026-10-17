const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];
const one = (name) => new RegExp(`^const ${name} = .*;$`, 'm').exec(src)[0];

const ctx = { panePairs: {}, paneGroups: {}, panes: [] };
ctx.paneLayout = () => ({ panes: ctx.panes.map((id) => ({ id })) });
vm.runInNewContext(
  [
    one('PANE_GROUP_COLORS'),
    one('paneTabIds'),
    one('splitSideOf'),
    fn('getPanePairs'),
    fn('getPaneGroups'),
    fn('groupOfTabs'),
    fn('paneStripStops'),
    one('paneStripItems'),
    one('isOpenItem'),
    one('openStripItems'),
    'Object.assign(this, { paneStripItems, openStripItems, paneStripStops, getPaneGroups });',
  ].join('\n'),
  ctx,
);

function setup({ panes, pairs = [], groups = [] }) {
  ctx.panes = panes;
  ctx.panePairs = { s: pairs };
  ctx.paneGroups = { s: groups };
}
const strip = (items) => Array.from(items, (it) => `${it.ids.join('|')}${it.group ? `@${it.group.id}` : ''}`);
const group = (id, ids, extra) => ({ id, name: id, color: 'blue', ids, ...extra });

describe('pane groups in the strip', () => {
  it('a group shows its tabs together, at the place of its first tab', () => {
    setup({ panes: ['p1', 'p2', 'p3', 'p4'], groups: [group('g', ['p2', 'p4'])] });
    assert.deepEqual(strip(ctx.paneStripItems('s')), ['board', 'p1', 'p2@g', 'p4@g', 'p3']);
  });

  it('a split is in the group of either side, and the board is in none', () => {
    setup({
      panes: ['p1', 'p2', 'p3'],
      pairs: [{ l: 'p2', r: 'p3' }, { l: 'board', r: 'p1' }],
      groups: [group('g', ['p3', 'p1'])],
    });
    assert.deepEqual(strip(ctx.paneStripItems('s')), ['board|p1', 'p2|p3@g']);
  });

  it('a collapsed group hides its tabs from [ and ]', () => {
    setup({ panes: ['p1', 'p2', 'p3'], groups: [group('g', ['p1', 'p2'], { closed: true })] });
    assert.deepEqual(strip(ctx.openStripItems('s')), ['board', 'p3']);
    assert.equal(ctx.paneStripItems('s').length, 4);
  });

  it('the number keys count a group as one stop, open or collapsed', () => {
    setup({ panes: ['p1', 'p2', 'p3', 'p4'], groups: [group('g', ['p2', 'p3']), group('h', ['p4'], { closed: true })] });
    const stops = Array.from(ctx.paneStripStops('s'), (s) => `${s.group?.id ?? '-'}:${strip(s.items).join(',')}`);
    assert.deepEqual(stops, ['-:board', '-:p1', 'g:p2@g,p3@g', 'h:p4@h']);
  });

  it('closed panes leave their group, an empty group goes, and a tab is in one group only', () => {
    setup({ panes: ['p1', 'p2'], groups: [group('a', ['p9']), group('b', ['p1', 'p9']), group('c', ['p1', 'p2'])] });
    assert.deepEqual(
      Array.from(ctx.getPaneGroups('s'), (g) => [g.id, [...g.ids]]),
      [
        ['b', ['p1']],
        ['c', ['p2']],
      ],
    );
  });

  it('a stored color that is not in the palette falls back to the first one', () => {
    setup({ panes: ['p1'], groups: [group('g', ['p1'], { color: 'red;background:url(x)' })] });
    assert.equal(ctx.getPaneGroups('s')[0].color, 'blue');
  });
});

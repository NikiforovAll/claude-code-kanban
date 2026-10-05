const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPaneStore, isOwnOrigin, MAX_PANES } = require('../lib/panes');
const { GRACE_MS, DAY_MS } = require('../lib/retention');

function memoryStore() {
  const clock = { t: 1_000_000 };
  let disk = null;
  const open = () =>
    createPaneStore({
      load: () => (disk ? JSON.parse(disk) : null),
      save: (data) => {
        disk = JSON.stringify(data);
      },
      now: () => clock.t,
    });
  return { open, clock, disk: () => (disk ? JSON.parse(disk) : null) };
}

const url = (n) => ({ kind: 'url', target: `http://localhost:${8000 + n}/` });

describe('pane store', () => {
  it('adds panes in tab order with ids, titles and a time, and keeps them on disk', () => {
    const { open, clock } = memoryStore();
    const panes = open();
    const a = panes.add('s1', url(1));
    const b = panes.add('s1', { kind: 'file', target: 'C:\\repo\\report.html', title: 'Report' });
    assert.deepEqual(a.pane, { id: 'p1', kind: 'url', target: 'http://localhost:8001/', title: 'localhost:8001', addedAt: clock.t });
    assert.equal(b.pane.id, 'p2');
    assert.equal(b.pane.title, 'Report');
    assert.deepEqual(open().get('s1').panes.map((p) => p.id), ['p1', 'p2']);
    assert.equal(open().get('s1').active, 'board');
  });

  it('returns the existing pane for the same target', () => {
    const panes = memoryStore().open();
    panes.add('s1', { kind: 'file', target: 'C:\\repo\\a.html' });
    const again = panes.add('s1', { kind: 'file', target: 'c:/repo/a.html' });
    assert.equal(again.added, false);
    assert.equal(again.pane.id, 'p1');
    assert.equal(panes.get('s1').panes.length, 1);
  });

  it(`refuses a pane past ${MAX_PANES}`, () => {
    const panes = memoryStore().open();
    for (let i = 0; i < MAX_PANES; i++) panes.add('s1', url(i));
    assert.throws(() => panes.add('s1', url(MAX_PANES)), (e) => e.status === 409);
    assert.equal(panes.get('s1').panes.length, MAX_PANES);
  });

  it('refuses an unknown kind', () => {
    assert.throws(() => memoryStore().open().add('s1', { kind: 'pdf', target: 'x' }), (e) => e.status === 400);
  });

  it('sets the active tab and the order, and reports a no-op as unchanged', () => {
    const panes = memoryStore().open();
    panes.add('s1', url(1));
    panes.add('s1', url(2));
    assert.equal(panes.update('s1', { active: 'p2' }).layout.active, 'p2');
    const same = panes.update('s1', { active: 'p2' });
    assert.equal(same.changed, false);
    assert.equal(same.layout.active, 'p2');
    assert.deepEqual(panes.update('s1', { order: ['p2', 'p1'] }).layout.panes.map((p) => p.id), ['p2', 'p1']);
    assert.throws(() => panes.update('s1', { active: 'p9' }), (e) => e.status === 400);
    assert.throws(() => panes.update('s1', { order: ['p1'] }), (e) => e.status === 400);
    assert.throws(() => panes.update('s1', { order: ['p1', 'p1'] }), (e) => e.status === 400);
  });

  it('falls back to Board when the active pane is removed, and drops an empty layout', () => {
    const { open, disk } = memoryStore();
    const panes = open();
    panes.add('s1', url(1));
    panes.update('s1', { active: 'p1' });
    assert.equal(panes.remove('s1', 'p9'), null);
    assert.equal(panes.update('s9', {}).changed, false);
    assert.deepEqual(panes.remove('s1', 'p1').active, 'board');
    assert.deepEqual(disk().sessions, {});
  });

  it('does not reuse the id of the newest pane after a remove', () => {
    const panes = memoryStore().open();
    panes.add('s1', url(1));
    panes.add('s1', url(2));
    panes.remove('s1', 'p1');
    assert.equal(panes.add('s1', url(3)).pane.id, 'p3');
  });
});

describe('isOwnOrigin', () => {
  const opts = { boardPort: 3541, boardHosts: ['box.lan'], hubUrl: 'http://localhost:3540' };

  it('matches every name of the board and the hub', () => {
    for (const u of ['http://localhost:3541/x', 'http://127.0.0.1:3541', 'http://[::1]:3541/', 'http://box.lan:3541', 'http://127.0.0.1:3540/']) {
      assert.equal(isOwnOrigin(u, opts), true, u);
    }
  });

  it('passes another port, scheme or host', () => {
    for (const u of ['http://localhost:8228', 'https://localhost:3541', 'http://other.lan:3541', 'https://example.com', 'not a url']) {
      assert.equal(isOwnOrigin(u, opts), false, u);
    }
    assert.equal(isOwnOrigin('http://localhost:3540', { boardPort: 3541 }), false);
  });
});

describe('pane retention', () => {
  const maxAgeMs = 30 * DAY_MS;

  it('drops a layout whose transcript is gone, after the grace period', () => {
    const { open, clock } = memoryStore();
    const panes = open();
    panes.add('gone', url(1));
    panes.add('kept', url(1));
    assert.equal(panes.prune({ known: new Set(['kept']), maxAgeMs }), 0);
    clock.t += GRACE_MS;
    assert.equal(panes.prune({ known: new Set(['kept']), maxAgeMs }), 1);
    assert.equal(open().get('gone').panes.length, 0);
    assert.equal(open().get('kept').panes.length, 1);
  });

  it('drops a layout older than the retention period, and a write keeps it alive', () => {
    const { open, clock } = memoryStore();
    const panes = open();
    panes.add('old', url(1));
    panes.add('busy', url(1));
    clock.t += maxAgeMs;
    panes.update('busy', { active: 'p1' });
    clock.t += 1;
    assert.equal(panes.prune({ known: null, maxAgeMs }), 1);
    assert.equal(panes.get('old').panes.length, 0);
    assert.equal(panes.get('busy').panes.length, 1);
  });
});

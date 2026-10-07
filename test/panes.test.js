const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPaneStore, isOwnOrigin, MAX_PANES, MAX_TITLE } = require('../lib/panes');
const { GRACE_MS, DAY_MS } = require('../lib/retention');

function memoryStore() {
  const clock = { t: 1_000_000 };
  let disk = null;
  const open = (onChange) =>
    createPaneStore({
      load: () => (disk ? JSON.parse(disk) : null),
      save: (data) => {
        disk = JSON.stringify(data);
      },
      onChange,
      now: () => clock.t,
    });
  return {
    open,
    clock,
    disk: () => (disk ? JSON.parse(disk) : null),
    setDisk: (data) => {
      disk = JSON.stringify(data);
    },
  };
}

const url = (n) => ({ kind: 'url', target: `http://localhost:${8000 + n}/` });
const ids = (layout) => layout.panes.map((p) => p.id);

describe('pane store', () => {
  it('adds panes in tab order with ids, titles, a time and a rising rev, and keeps them on disk', () => {
    const { open, clock } = memoryStore();
    const panes = open();
    const a = panes.add('s1', url(1));
    const b = panes.add('s1', { kind: 'html', target: 'C:\\repo\\report.html', title: 'Report' });
    assert.deepEqual(a.pane, { id: 'p1', kind: 'url', target: 'http://localhost:8001/', title: 'localhost:8001', addedAt: clock.t });
    assert.equal(b.pane.id, 'p2');
    assert.equal(b.pane.title, 'Report');
    assert.deepEqual(b.layout, { rev: 2, panes: [a.pane, b.pane], updatedAt: clock.t });
    assert.deepEqual(open().get('s1'), b.layout);
    assert.deepEqual(panes.get('s9'), { rev: 0, panes: [], updatedAt: null });
  });

  it('lists the file targets of every session, without URLs', () => {
    const panes = memoryStore().open();
    panes.add('s1', url(1));
    panes.add('s1', { kind: 'markdown', target: 'C:\\repo\\a.md' });
    panes.add('s2', { kind: 'html', target: 'C:\\repo\\b.html' });
    panes.add('s2', { kind: 'html', target: 'C:\\repo\\a.md' });
    assert.deepEqual([...panes.fileTargets()], ['C:\\repo\\a.md', 'C:\\repo\\b.html']);
  });

  it('keeps a message pane by its id, apart from files, and refuses a long id', () => {
    const panes = memoryStore().open();
    const target = 'assistant|2026-10-07T10:00:00.000Z|Done.';
    const a = panes.add('s1', { kind: 'message', target, title: 'Claude 10:00' });
    assert.equal(a.pane.title, 'Claude 10:00');
    assert.equal(panes.add('s1', { kind: 'message', target }).added, false);
    assert.equal(panes.add('s1', { kind: 'message', target: `${target}!` }).pane.id, 'p2');
    assert.equal(panes.add('s1', { kind: 'message', target: 'user|t|x' }).pane.title, 'Message');
    assert.deepEqual([...panes.fileTargets()], []);
    assert.throws(() => panes.add('s1', { kind: 'message', target: 'x'.repeat(301) }), { code: 'bad_target' });
  });

  it('returns the existing pane for the same file, whatever its kind or spelling', () => {
    const panes = memoryStore().open();
    panes.add('s1', { kind: 'html', target: 'C:\\repo\\a.html' });
    const again = panes.add('s1', { kind: 'text', target: 'c:/repo/a.html' });
    assert.equal(again.added, false);
    assert.equal(again.pane.id, 'p1');
    assert.equal(again.layout.rev, 1);
  });

  it(`refuses a pane past ${MAX_PANES}, an unknown kind, and cuts a long title`, () => {
    const panes = memoryStore().open();
    for (let i = 0; i < MAX_PANES; i++) panes.add('s1', url(i));
    assert.throws(() => panes.add('s1', url(MAX_PANES)), (e) => e.status === 409 && e.code === 'pane_limit');
    assert.throws(() => panes.add('s2', { kind: 'pdf', target: 'x' }), (e) => e.status === 400 && e.code === 'bad_kind');
    assert.equal(panes.add('s2', { ...url(1), title: 'x'.repeat(500) }).pane.title.length, MAX_TITLE);
    assert.equal(panes.add('s2', { ...url(2), title: ' a\nb\x1b ' }).pane.title, 'a b');
    assert.equal(panes.add('s2', { ...url(3), title: '\n' }).pane.title, 'localhost:8003');
  });

  it('renames a pane, gives an empty title the default back, and reports a no-op as unchanged', () => {
    const panes = memoryStore().open();
    panes.add('s1', url(1));
    assert.equal(panes.rename('s1', 'p1', ' Dev\nserver ').panes[0].title, 'Dev server');
    assert.equal(panes.rename('s1', 'p1', 'Dev server').rev, 2);
    assert.equal(panes.rename('s1', 'p1', '').panes[0].title, 'localhost:8001');
    assert.equal(panes.rename('s1', 'p9', 'x'), null);
    assert.equal(panes.rename('s9', 'p1', 'x'), null);
  });

  it('reorders, and reports a no-op as unchanged', () => {
    const panes = memoryStore().open();
    panes.add('s1', url(1));
    panes.add('s1', url(2));
    const moved = panes.reorder('s1', ['p2', 'p1']);
    assert.deepEqual([ids(moved), moved.rev], [['p2', 'p1'], 3]);
    assert.equal(panes.reorder('s1', ['p2', 'p1']).rev, 3);
    assert.equal(panes.reorder('s9', []).rev, 0);
    for (const order of [['p1'], ['p1', 'p1'], ['p1', 'p9'], 'p1']) {
      assert.throws(() => panes.reorder('s1', order), (e) => e.code === 'bad_order', String(order));
    }
  });

  it('keeps an emptied layout, so ids and rev keep counting up', () => {
    const { open, disk } = memoryStore();
    const panes = open();
    panes.add('s1', url(1));
    panes.add('s1', url(2));
    assert.equal(panes.remove('s1', 'p9'), null);
    assert.equal(panes.remove('s9', 'p1'), null);
    panes.remove('s1', 'p2');
    assert.deepEqual(panes.remove('s1', 'p1'), { rev: 4, panes: [], updatedAt: disk().sessions.s1.updatedAt });
    assert.equal(panes.add('s1', url(3)).pane.id, 'p3');
  });

  it('merges the writes of two stores on one file and reports each change once', () => {
    const { open } = memoryStore();
    const seen = [];
    const a = open((sid, l) => seen.push(`a ${sid} ${l.rev}`));
    const b = open((sid, l) => seen.push(`b ${sid} ${l.rev}`));
    a.add('s1', url(1));
    b.add('s1', url(2));
    assert.deepEqual(ids(a.get('s1')), ['p1']);
    a.reload();
    a.reload();
    assert.deepEqual(ids(a.get('s1')), ['p1', 'p2']);
    a.add('s2', url(1));
    assert.deepEqual(seen, ['a s1 1', 'b s1 1', 'b s1 2', 'a s1 2', 'a s2 1']);
  });

  it('cleans a hand-edited file: drops bad and duplicate panes, never reuses a live id', () => {
    const { open, setDisk } = memoryStore();
    setDisk({
      sessions: {
        s1: { updatedAt: 1, panes: [{ id: 'p4', kind: 'url', target: 'http://a/' }, { id: 'p4', kind: 'url', target: 'http://b/' }, { id: 'p5', kind: 'pdf', target: 'x' }] },
        s2: { panes: [] },
      },
    });
    const panes = open();
    assert.deepEqual(panes.get('s1'), { rev: 1, panes: [{ id: 'p4', kind: 'url', target: 'http://a/' }], updatedAt: 1 });
    assert.equal(panes.get('s2').rev, 0);
    assert.equal(panes.add('s1', url(1)).pane.id, 'p5');
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
    panes.add('busy', url(2));
    clock.t += 1;
    assert.equal(panes.prune({ known: null, maxAgeMs }), 1);
    assert.equal(panes.get('old').panes.length, 0);
    assert.equal(panes.get('busy').panes.length, 2);
  });
});

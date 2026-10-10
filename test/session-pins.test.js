const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSessionPinStore } = require('../lib/session-pins');

function harness(initial = null) {
  const disk = { data: initial, saves: 0, changed: true };
  const store = () =>
    createSessionPinStore({
      load: () => {
        if (!disk.changed) return undefined;
        disk.changed = false;
        return disk.data;
      },
      save: (data) => {
        disk.data = JSON.parse(JSON.stringify(data));
        disk.saves++;
      },
      now: () => '2026-10-10T00:00:00.000Z',
    });
  const write = (data) => {
    disk.data = data;
    disk.changed = true;
  };
  return { disk, store, write };
}

const status = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e.status, e.message);
    return e.status;
  }
  assert.fail('expected an error with a status');
};

describe('session pin store', () => {
  it('keeps a flat map on disk and survives a restart', () => {
    const { disk, store } = harness();
    const s = store();
    assert.deepEqual(s.set('a', 'pinned'), [{ id: 'a', state: 'pinned' }]);
    s.set('b', 'sticky');
    assert.deepEqual(s.set('a', 'none'), [{ id: 'a', state: 'none' }]);
    assert.deepEqual(disk.data, { b: 'sticky' });
    assert.deepEqual(harness(disk.data).store().state(), { pins: { b: 'sticky' }, pinsMigratedAt: null });
  });

  it('refuses a bad change', () => {
    const s = harness().store();
    assert.equal(status(() => s.set('a', 'up')), 400);
    assert.equal(status(() => s.set('', 'pinned')), 400);
    assert.equal(status(() => s.set('pinsMigratedAt', 'pinned')), 400);
  });

  it('imports the browser lists once and keeps what the server holds', () => {
    const { disk, store } = harness({ a: 'pinned' });
    const s = store();
    const first = s.importLocal({ pinned: ['a', 'b', 'c'], sticky: ['a', 'c'] });
    assert.equal(first.imported, true);
    assert.deepEqual(first.changed, [
      { id: 'c', state: 'sticky' },
      { id: 'b', state: 'pinned' },
    ]);
    assert.deepEqual(disk.data, { a: 'pinned', c: 'sticky', b: 'pinned', pinsMigratedAt: '2026-10-10T00:00:00.000Z' });
    const second = harness(disk.data).store().importLocal({ pinned: ['d'] });
    assert.deepEqual(second, { imported: false, changed: [] });
    assert.equal(s.state().pins.d, undefined);
  });

  it('marks the import even when the browser had no pins', () => {
    const { disk, store } = harness();
    assert.equal(store().importLocal({}).imported, true);
    assert.deepEqual(disk.data, { pinsMigratedAt: '2026-10-10T00:00:00.000Z' });
  });

  it('reloads after another board writes the file and names what changed', () => {
    const { store, write } = harness({ a: 'pinned', b: 'pinned' });
    const s = store();
    assert.deepEqual(s.reload(), []);
    write({ a: 'sticky', c: 'pinned', pinsMigratedAt: 'x' });
    assert.deepEqual(s.reload(), [
      { id: 'a', state: 'sticky' },
      { id: 'b', state: 'none' },
      { id: 'c', state: 'pinned' },
    ]);
    assert.deepEqual(s.state(), { pins: { a: 'sticky', c: 'pinned' }, pinsMigratedAt: 'x' });
  });
});

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// The board's pin code against a fake server and a fake localStorage.
function makePage(local = {}) {
  const server = { pins: {}, pinsMigratedAt: null, imports: 0, failPost: false };
  const ls = new Map(Object.entries(local).map(([k, v]) => [k, JSON.stringify(v)]));
  const ctx = {
    console: { warn() {} },
    JSON,
    Object,
    Set,
    Error,
    toasts: [],
    fetched: 0,
    rendered: 0,
    sessions: [{ id: 'a' }, { id: 'b' }],
    deferredPinPlacement: new Set(),
    openedStickyIds: new Set(),
    store: { removeItem: (k) => ls.delete(k) },
    readStoredList: (k) => (ls.has(k) ? JSON.parse(ls.get(k)) : []),
    showToast: (msg, kind) => ctx.toasts.push([msg, kind]),
    expandPinnedFor() {},
    fetchSessions: () => ctx.fetched++,
    renderSessions: () => ctx.rendered++,
    api: async (url, opts = {}) => {
      if (url === '/api/session/pins') return json({ pins: server.pins, pinsMigratedAt: server.pinsMigratedAt });
      if (url === '/api/session/pins/import') {
        server.imports++;
        if (!server.pinsMigratedAt) {
          for (const id of opts.body.sticky) server.pins[id] ??= 'sticky';
          for (const id of opts.body.pinned) server.pins[id] ??= 'pinned';
          server.pinsMigratedAt = 'now';
        }
        return json({ pins: server.pins, pinsMigratedAt: server.pinsMigratedAt });
      }
      if (url === '/api/session/pin') {
        if (server.failPost) return json({ error: 'disk full' }, 500);
        const { id, state } = opts.body;
        if (state === 'none') delete server.pins[id];
        else server.pins[id] = state;
        return json({ success: true });
      }
      throw new Error(`no reply for ${url}`);
    },
  };
  vm.runInNewContext(
    [
      "const PINNED_SESSIONS_KEY = 'pinned-sessions', STICKY_SESSIONS_KEY = 'sticky-sessions';",
      'var pinnedSessionIds = new Set(), stickySessionIds = new Set(), currentSessionId = null;',
      ...[
        'syncSessionPins',
        'applyServerPins',
        'showPinnedSessions',
        'sendPinChange',
        'clearSessionPin',
        'toggleSessionPin',
        'unpinSession',
        'handleSessionPinEvent',
        'getSessionPinState',
        'isAnyPinned',
      ].map(fn),
      'this.pinsJson = () => JSON.stringify({ pinned: [...pinnedSessionIds].sort(), sticky: [...stickySessionIds].sort() });',
    ].join('\n'),
    ctx,
  );
  ctx.pins = () => JSON.parse(ctx.pinsJson());
  return { ctx, server, ls };
}

describe('board pins', () => {
  it('imports the browser lists once, then deletes them', async () => {
    const page = makePage({ 'pinned-sessions': ['a', 'z'], 'sticky-sessions': ['a'] });
    await page.ctx.syncSessionPins();
    assert.equal(page.server.imports, 1);
    assert.deepEqual(page.server.pins, { a: 'sticky', z: 'pinned' });
    assert.deepEqual(page.ctx.pins(), { pinned: ['a', 'z'], sticky: ['a'] });
    assert.equal(page.ls.size, 0);
    assert.equal(page.ctx.fetched, 1, 'z is not in the list, so the sessions are fetched with it');

    const other = makePage({ 'pinned-sessions': ['b'] });
    Object.assign(other.server, page.server, { imports: 0 });
    await other.ctx.syncSessionPins();
    assert.equal(other.server.imports, 0);
    assert.equal(other.server.pins.b, undefined);
    assert.equal(other.ls.size, 0, 'a board that loads after the import deletes its lists too');
  });

  it('reads pins from the server only', async () => {
    const page = makePage();
    Object.assign(page.server, { pins: { b: 'pinned' }, pinsMigratedAt: 'then' });
    await page.ctx.syncSessionPins();
    assert.deepEqual(page.ctx.pins(), { pinned: ['b'], sticky: [] });
    assert.equal(page.server.imports, 0);
  });

  it('saves a pin and an unpin, one session per request', async () => {
    const page = makePage();
    page.server.pinsMigratedAt = 'then';
    await page.ctx.syncSessionPins();
    page.ctx.toggleSessionPin('a');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(page.server.pins, { a: 'pinned' });
    page.ctx.toggleSessionPin('a');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(page.server.pins, {});
    assert.equal(page.ctx.toasts.length, 0);
  });

  it('shows a failed save and re-reads the server', async () => {
    const page = makePage();
    Object.assign(page.server, { pins: { b: 'pinned' }, pinsMigratedAt: 'then', failPost: true });
    await page.ctx.syncSessionPins();
    page.ctx.pinnedSessionIds.add('x');
    await page.ctx.sendPinChange('a');
    assert.equal(page.ctx.toasts.length, 1);
    assert.match(page.ctx.toasts[0][0], /disk full/);
    assert.equal(page.ctx.toasts[0][1], 'error');
    assert.deepEqual(page.ctx.pins(), { pinned: ['b'], sticky: [] });
  });

  it('applies a pushed change from another tab or board', async () => {
    const page = makePage();
    page.server.pinsMigratedAt = 'then';
    await page.ctx.syncSessionPins();
    page.ctx.handleSessionPinEvent({ id: 'b', state: 'sticky' });
    assert.deepEqual(page.ctx.pins(), { pinned: ['b'], sticky: ['b'] });
    page.ctx.handleSessionPinEvent({ id: 'b', state: 'none' });
    assert.deepEqual(page.ctx.pins(), { pinned: [], sticky: [] });
  });
});

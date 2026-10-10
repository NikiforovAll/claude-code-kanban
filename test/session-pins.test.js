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

  it('merges every import and keeps what the server holds', () => {
    const { disk, store } = harness({ a: 'pinned' });
    const s = store();
    const first = s.importLocal({ pinned: ['a', 'b', 'c'], sticky: ['a', 'c'] });
    assert.equal(first.imported, true);
    assert.deepEqual(first.changed, [
      { id: 'c', state: 'sticky' },
      { id: 'b', state: 'pinned' },
    ]);
    assert.deepEqual(disk.data, { a: 'pinned', c: 'sticky', b: 'pinned', pinsMigratedAt: '2026-10-10T00:00:00.000Z' });
    const other = harness({ ...disk.data, pinsMigratedAt: 'then' }).store();
    const second = other.importLocal({ pinned: ['d', 'c'] });
    assert.deepEqual(second, { imported: true, changed: [{ id: 'd', state: 'pinned' }] });
    assert.deepEqual(other.state(), { pins: { a: 'pinned', c: 'sticky', b: 'pinned', d: 'pinned' }, pinsMigratedAt: 'then' });
  });

  it('changes several sessions in one write', () => {
    const { disk, store } = harness({ a: 'pinned', b: 'sticky', c: 'pinned' });
    const s = store();
    assert.deepEqual(s.set(['a', 'b', 'z'], 'none'), [
      { id: 'a', state: 'none' },
      { id: 'b', state: 'none' },
    ]);
    assert.deepEqual(disk.data, { c: 'pinned' });
    assert.equal(disk.saves, 1);
    assert.equal(status(() => s.set([], 'none')), 400);
    assert.equal(status(() => s.set(['a', ''], 'none')), 400);
  });

  it('keeps the last good pins and writes nothing while the file cannot be read', () => {
    const { disk, write } = harness({ a: 'pinned', pinsMigratedAt: 'then' });
    let broken = new SyntaxError('Unexpected token } in JSON');
    const flaky = createSessionPinStore({
      load: () => {
        if (broken) throw broken;
        return disk.data;
      },
      save: (data) => {
        disk.data = data;
        disk.saves++;
      },
    });
    assert.deepEqual(flaky.state().pins, {});
    broken = null;
    assert.deepEqual(flaky.reload(), [{ id: 'a', state: 'pinned' }]);
    broken = new Error('EBUSY: resource busy or locked');
    assert.deepEqual(flaky.reload(), [], 'a failed read changes nothing');
    assert.deepEqual(flaky.state(), { pins: { a: 'pinned' }, pinsMigratedAt: 'then' });
    assert.equal(status(() => flaky.set('b', 'pinned')), 503);
    assert.equal(status(() => flaky.importLocal({ pinned: ['b'] })), 503);
    assert.equal(disk.saves, 0);
    assert.deepEqual(flaky.state().pins, { a: 'pinned' });
    broken = null;
    write({ a: 'pinned', c: 'sticky', pinsMigratedAt: 'then' });
    assert.deepEqual(flaky.reload(), [{ id: 'c', state: 'sticky' }], 'the next read takes the fixed file');
    flaky.set('b', 'pinned');
    assert.deepEqual(disk.data, { a: 'pinned', c: 'sticky', b: 'pinned', pinsMigratedAt: 'then' });
  });

  it('a failed save answers 503 and leaves memory as it was', () => {
    let fail = false;
    const flaky = createSessionPinStore({
      load: () => null,
      save: () => {
        if (fail) throw new Error('EPERM: operation not permitted');
      },
    });
    flaky.set('a', 'pinned');
    fail = true;
    assert.equal(status(() => flaky.set('a', 'none')), 503);
    assert.equal(status(() => flaky.importLocal({ pinned: ['b'] })), 503);
    assert.deepEqual(flaky.state(), { pins: { a: 'pinned' }, pinsMigratedAt: null });
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
  const server = { pins: {}, pinsMigratedAt: null, imports: 0, posts: [], failPost: false };
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
        for (const id of opts.body.sticky) server.pins[id] ??= 'sticky';
        for (const id of opts.body.pinned) server.pins[id] ??= 'pinned';
        server.pinsMigratedAt ??= 'now';
        return json({ pins: server.pins, pinsMigratedAt: server.pinsMigratedAt });
      }
      if (url === '/api/session/pin') {
        server.posts.push(opts.body);
        if (server.failPost) return json({ error: 'disk full' }, 500);
        const { id, ids, state } = opts.body;
        for (const x of ids ?? [id]) {
          if (state === 'none') delete server.pins[x];
          else server.pins[x] = state;
        }
        return json({ success: true });
      }
      throw new Error(`no reply for ${url}`);
    },
  };
  vm.runInNewContext(
    [
      "const PINNED_SESSIONS_KEY = 'pinned-sessions', STICKY_SESSIONS_KEY = 'sticky-sessions';",
      'var pinnedSessionIds = new Set(), stickySessionIds = new Set(), currentSessionId = null, pinsApplied = false;',
      ...[
        'syncSessionPins',
        'applyServerPins',
        'showPinnedSessions',
        'savedPinState',
        'sendPinChange',
        'postPins',
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
  it('each origin merges its browser lists once, then deletes them', async () => {
    const page = makePage({ 'pinned-sessions': ['a', 'z'], 'sticky-sessions': ['a'] });
    await page.ctx.syncSessionPins();
    assert.equal(page.server.imports, 1);
    assert.deepEqual(page.server.pins, { a: 'sticky', z: 'pinned' });
    assert.deepEqual(page.ctx.pins(), { pinned: ['a', 'z'], sticky: ['a'] });
    assert.equal(page.ls.size, 0);
    assert.equal(page.ctx.fetched, 0, 'the first session list brings the pinned sessions itself');
    assert.equal(page.ctx.rendered, 1);
    await page.ctx.syncSessionPins();
    assert.equal(page.server.imports, 1, 'the same origin does not import again');

    const other = makePage({ 'pinned-sessions': ['b', 'a'] });
    other.server.pins = page.server.pins;
    other.server.pinsMigratedAt = page.server.pinsMigratedAt;
    await other.ctx.syncSessionPins();
    assert.equal(other.server.imports, 1, 'a second origin merges its own lists');
    assert.deepEqual(other.server.pins, { a: 'sticky', z: 'pinned', b: 'pinned' });
    assert.equal(other.ls.size, 0);
  });

  it('keeps the browser lists when the import fails', async () => {
    const page = makePage({ 'pinned-sessions': ['a'] });
    const api = page.ctx.api;
    page.ctx.api = async (url, opts) => (url === '/api/session/pins/import' ? json({ error: 'pins.json cannot be read' }, 503) : api(url, opts));
    await page.ctx.syncSessionPins();
    assert.equal(page.ls.size, 1);
  });

  it('saves what the user set, not the sticky that session open added', async () => {
    const page = makePage();
    await page.ctx.syncSessionPins();
    page.ctx.openedStickyIds.add('a');
    page.ctx.stickySessionIds.add('a');
    page.ctx.toggleSessionPin('a');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(JSON.parse(JSON.stringify(page.server.posts)), [{ id: 'a', state: 'pinned' }]);
    assert.equal(page.ctx.getSessionPinState('a'), 'sticky', 'the page still shows it sticky');
  });

  it("the echo of the page's own change keeps the selected session in place", async () => {
    const page = makePage();
    await page.ctx.syncSessionPins();
    page.ctx.currentSessionId = 'a';
    page.ctx.toggleSessionPin('a');
    assert.ok(page.ctx.deferredPinPlacement.has('a'));
    const rendered = page.ctx.rendered;
    page.ctx.handleSessionPinEvent({ id: 'a', state: 'pinned' });
    assert.ok(page.ctx.deferredPinPlacement.has('a'));
    assert.equal(page.ctx.rendered, rendered);
    page.ctx.handleSessionPinEvent({ id: 'a', state: 'sticky' });
    assert.ok(!page.ctx.deferredPinPlacement.has('a'), 'a change from elsewhere still applies');
  });

  it('reads pins from the server only', async () => {
    const page = makePage();
    Object.assign(page.server, { pins: { b: 'pinned' }, pinsMigratedAt: 'then' });
    await page.ctx.syncSessionPins();
    assert.deepEqual(page.ctx.pins(), { pinned: ['b'], sticky: [] });
    assert.equal(page.server.imports, 0);
  });

  it('a re-read renders only when the pins changed, and fetches a pinned session it lacks', async () => {
    const page = makePage();
    Object.assign(page.server, { pins: { a: 'pinned' }, pinsMigratedAt: 'then' });
    await page.ctx.syncSessionPins();
    await page.ctx.syncSessionPins();
    assert.equal(page.ctx.rendered, 1);
    page.server.pins.a = 'sticky';
    await page.ctx.syncSessionPins();
    assert.equal(page.ctx.rendered, 2);
    page.server.pins.z = 'pinned';
    await page.ctx.syncSessionPins();
    assert.equal(page.ctx.fetched, 1);
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

  it('a pin event for a session that session open showed keeps it shown', async () => {
    const page = makePage();
    await page.ctx.syncSessionPins();
    page.ctx.openedStickyIds.add('a');
    page.ctx.stickySessionIds.add('a');
    page.ctx.handleSessionPinEvent({ id: 'a', state: 'none' });
    assert.ok(page.ctx.openedStickyIds.has('a'));
  });

  it('Clean Orphaned unpins every orphan in one request', async () => {
    const page = makePage();
    Object.assign(page.server, { pins: { a: 'pinned', x: 'pinned', y: 'sticky' }, pinsMigratedAt: 'then' });
    await page.ctx.syncSessionPins();
    vm.runInNewContext(
      [
        "const PINNED_MESSAGES_PREFIX = 'pm-', PAD_EMOJI_PREFIX = 'pe-', PREVIEW_STORAGE_PREFIX = 'pp-', PAD_LINKED_PREFIX = 'pl-';",
        fn('_findOrphanedKeys'),
        fn('cleanupOrphanedStorage'),
      ].join('\n'),
      Object.assign(page.ctx, {
        sgRev: null,
        _fetchKnownSessions: async () => new Set(['a', 'b']),
        _parsePadKey: () => null,
        _renderStorageTab() {},
        _updateStorageTotal() {},
        _updateOrphanedCount() {},
      }),
    );
    page.ctx.store.keys = () => [];
    await page.ctx.cleanupOrphanedStorage();
    await new Promise((r) => setImmediate(r));
    assert.equal(page.server.posts.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(page.server.posts[0])), { ids: ['x', 'y'], state: 'none' });
    assert.deepEqual(page.server.pins, { a: 'pinned' });
    assert.deepEqual(page.ctx.pins(), { pinned: ['a'], sticky: [] });
  });
});

describe('board session list request', () => {
  it('asks for the sessions that session open showed', async () => {
    let query;
    const ctx = {
      console: { error() {} },
      JSON,
      currentSessionId: 'focus',
      revealedPlanSessionId: null,
      revealedStorageSessionId: null,
      openedStickyIds: new Set(['opened']),
      filterProject: null,
      sessionLimit: 20,
      sessionFilter: 'active',
      RECENT_PROJECT_HOURS: 24,
      api: async (_url, opts) => {
        query = opts.query;
        throw new Error('stop');
      },
    };
    vm.runInNewContext(fn('fetchSessions'), ctx);
    await ctx.fetchSessions();
    assert.equal(query.include, 'focus,opened');
    assert.equal(query.filter, 'active');
  });
});

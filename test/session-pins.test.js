const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createSessionPinStore } = require('../lib/session-pins');
const { stampedJsonFile } = require('../lib/stamped-json-file');
const { httpError } = require('../lib/http-error');

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
    assert.deepEqual(s.set(['a'], 'pinned'), [{ id: 'a', state: 'pinned' }]);
    s.set(['b'], 'sticky');
    assert.deepEqual(s.set(['a'], 'none'), [{ id: 'a', state: 'none' }]);
    assert.deepEqual(disk.data, { b: 'sticky' });
    assert.deepEqual(harness(disk.data).store().state(), { pins: { b: 'sticky' } });
  });

  it('refuses a bad change', () => {
    const s = harness().store();
    assert.equal(status(() => s.set(['a'], 'up')), 400);
    assert.equal(status(() => s.set([''], 'pinned')), 400);
    assert.equal(status(() => s.set('a', 'pinned')), 400, 'ids is a list');
  });

  it('merges every import and keeps what the server holds', () => {
    const { disk, store } = harness({ a: 'pinned', pinsMigratedAt: '2026-10-01' });
    const s = store();
    assert.deepEqual(s.importLocal({ pinned: ['a', 'b', 'c'], sticky: ['a', 'c'] }), [
      { id: 'c', state: 'sticky' },
      { id: 'b', state: 'pinned' },
    ]);
    assert.deepEqual(disk.data, { a: 'pinned', c: 'sticky', b: 'pinned' }, 'an old file key is dropped');
    const other = harness(disk.data).store();
    assert.deepEqual(other.importLocal({ pinned: ['d', 'c'] }), [{ id: 'd', state: 'pinned' }]);
    assert.deepEqual(other.state(), { pins: { a: 'pinned', c: 'sticky', b: 'pinned', d: 'pinned' } });
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

  it('a refused save leaves memory as it was and passes the error on', () => {
    let fail = false;
    const flaky = createSessionPinStore({
      load: () => null,
      save: () => {
        if (fail) throw httpError(503, 'pins.json not saved (EPERM)');
      },
    });
    flaky.set(['a'], 'pinned');
    fail = true;
    assert.equal(status(() => flaky.set(['a'], 'none')), 503);
    assert.equal(status(() => flaky.importLocal({ pinned: ['b'] })), 503);
    assert.deepEqual(flaky.state(), { pins: { a: 'pinned' } });
  });

  it('reloads after another board writes the file and names what changed', () => {
    const { store, write } = harness({ a: 'pinned', b: 'pinned' });
    const s = store();
    assert.deepEqual(s.reload(), []);
    write({ a: 'sticky', c: 'pinned' });
    assert.deepEqual(s.reload(), [
      { id: 'a', state: 'sticky' },
      { id: 'b', state: 'none' },
      { id: 'c', state: 'pinned' },
    ]);
    assert.deepEqual(s.state(), { pins: { a: 'sticky', c: 'pinned' } });
  });
});

describe('stamped JSON file', () => {
  const tmp = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cck-stamped-'));
    return path.join(dir, 'pins.json');
  };
  const atomic = (file, data) => writeFileSync(file, JSON.stringify(data));

  it('keeps memory and refuses a write while the file cannot be read, then takes the fixed file', () => {
    const file = tmp();
    const store = createSessionPinStore(stampedJsonFile(file, atomic));
    store.set(['a'], 'pinned');
    writeFileSync(file, '{"a":"pinned", "b":');
    assert.deepEqual(store.reload(), [], 'a failed read changes nothing');
    assert.deepEqual(store.state().pins, { a: 'pinned' });
    const err = (() => {
      try {
        store.set(['b'], 'pinned');
      } catch (e) {
        return e;
      }
    })();
    assert.equal(err.status, 503);
    assert.equal(err.expose, true);
    assert.match(err.message, /pins\.json cannot be read .*fix or delete it/);
    assert.equal(status(() => store.importLocal({ pinned: ['b'] })), 503);
    assert.equal(readFileSync(file, 'utf8'), '{"a":"pinned", "b":', 'the broken file is left for the user');
    writeFileSync(file, '{"a":"pinned","c":"sticky"}');
    assert.deepEqual(store.reload(), [{ id: 'c', state: 'sticky' }]);
    store.set(['b'], 'pinned');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 'pinned', c: 'sticky', b: 'pinned' });
  });

  it('starts empty on a broken file and answers a failed write with 503', () => {
    const file = tmp();
    writeFileSync(file, 'nope');
    const store = createSessionPinStore(stampedJsonFile(file, atomic));
    assert.deepEqual(store.state().pins, {});
    assert.equal(status(() => store.set(['a'], 'pinned')), 503);
    writeFileSync(file, '{}');
    store.reload();
    const failing = createSessionPinStore(stampedJsonFile(file, () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }));
    assert.throws(() => failing.set(['a'], 'pinned'), { status: 503, message: 'pins.json not saved (EPERM)' });
    assert.deepEqual(failing.state().pins, {});
  });
});

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// The board's pin code against a fake server and a fake localStorage.
function makePage(local = {}) {
  const server = { pins: {}, imports: 0, posts: [], failPost: false };
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
      if (url === '/api/session/pins') return json({ pins: server.pins });
      if (url === '/api/session/pins/import') {
        server.imports++;
        for (const id of opts.body.sticky) server.pins[id] ??= 'sticky';
        for (const id of opts.body.pinned) server.pins[id] ??= 'pinned';
        return json({ pins: server.pins });
      }
      if (url === '/api/session/pin') {
        server.posts.push(opts.body);
        if (server.failPost) return json({ error: 'disk full' }, 500);
        const { ids, state } = opts.body;
        for (const x of ids) {
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
    assert.deepEqual(JSON.parse(JSON.stringify(page.server.posts)), [{ ids: ['a'], state: 'pinned' }]);
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
    page.server.pins = { b: 'pinned' };
    await page.ctx.syncSessionPins();
    assert.deepEqual(page.ctx.pins(), { pinned: ['b'], sticky: [] });
    assert.equal(page.server.imports, 0);
  });

  it('a re-read renders only when the pins changed, and fetches a pinned session it lacks', async () => {
    const page = makePage();
    page.server.pins = { a: 'pinned' };
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
    Object.assign(page.server, { pins: { b: 'pinned' }, failPost: true });
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
    page.server.pins = { a: 'pinned', x: 'pinned', y: 'sticky' };
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

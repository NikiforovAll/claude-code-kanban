const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAddonStore, MAX_ADDONS } = require('../lib/addons');
const { GRACE_MS, DAY_MS } = require('../lib/retention');

function memoryStore() {
  const clock = { t: 1_000_000 };
  let disk = null;
  const open = (onChange) =>
    createAddonStore({
      load: () => (disk ? JSON.parse(disk) : null),
      save: (data) => {
        disk = JSON.stringify(data);
      },
      onChange,
      now: () => clock.t,
    });
  return { open, clock, disk: () => JSON.parse(disk) };
}

const code = (c) => (e) => e.code === c;

describe('add-on store', () => {
  it('adds a session add-on and a global one, with ids unique across scopes, and keeps them on disk', () => {
    const { open, clock } = memoryStore();
    const addons = open();
    const s = addons.add('s1', { url: 'http://localhost:4100/?cwd={cwd}', title: 'Changes', icon: '±' });
    const g = addons.add('global', { url: 'http://localhost:4200/{sessionId}' });
    assert.deepEqual(s, {
      added: true,
      addon: { id: 'a1', url: 'http://localhost:4100/?cwd={cwd}', title: 'Changes', icon: '±', params: {}, addedAt: clock.t },
    });
    assert.equal(g.addon.id, 'a2');
    assert.equal(g.addon.title, 'localhost:4200');
    assert.deepEqual(open().list('s1'), { global: [g.addon], session: [s.addon], params: {} });
    assert.deepEqual(open().list('s2').session, []);
  });

  it('returns the existing entry for the same URL in the same scope', () => {
    const { open } = memoryStore();
    const addons = open();
    const a = addons.add('s1', { url: 'http://localhost:4100/' });
    assert.deepEqual(addons.add('s1', { url: 'http://localhost:4100/', title: 'Other' }), { added: false, addon: a.addon });
    assert.equal(addons.add('s2', { url: 'http://localhost:4100/' }).addon.id, 'a2');
  });

  it('refuses a bad URL, a placeholder with no value and a bad param', () => {
    const addons = memoryStore().open();
    assert.throws(() => addons.add('s1', { url: 'not a url' }), code('bad_url'));
    assert.throws(() => addons.add('s1', { url: 'file:///C:/x.html' }), code('bad_url'));
    assert.throws(() => addons.add('s1', { url: 'http://localhost:1/{repo}' }), code('missing_param'));
    const own = createAddonStore({ load: () => null, save: () => {}, isOwnOrigin: (u) => u.startsWith('http://localhost:3541/') });
    assert.throws(() => own.add('s1', { url: 'http://localhost:3541/{sessionId}' }), code('own_origin'));
    assert.throws(() => addons.add('s1', { url: 'http://localhost:1/', params: { cwd: 'x' } }), code('bad_param'));
    assert.throws(() => addons.add('s1', { url: 'http://localhost:1/', params: { a: '' } }), code('bad_param'));
    assert.equal(addons.add('s1', { url: 'http://localhost:1/{repo}', params: { repo: 'cck' } }).addon.params.repo, 'cck');
  });

  it('caps each scope at the limit', () => {
    const addons = memoryStore().open();
    for (let i = 0; i < MAX_ADDONS; i++) addons.add('s1', { url: `http://localhost:${5000 + i}/` });
    assert.throws(() => addons.add('s1', { url: 'http://localhost:6000/' }), code('addon_limit'));
    assert.equal(addons.add('global', { url: 'http://localhost:6000/' }).added, true);
  });

  it('removes a global add-on with no session, and a session one only in its session', () => {
    const { open } = memoryStore();
    const addons = open();
    const g = addons.add('global', { url: 'http://localhost:1/{q}', params: { q: 'a' } }).addon;
    const s = addons.add('s1', { url: 'http://localhost:2/' }).addon;
    addons.setParams('s1', g.id, { q: 'b' });
    assert.equal(addons.remove('s2', s.id), null);
    assert.equal(addons.remove(null, g.id).scope, 'global');
    assert.deepEqual(addons.list('s1').params, {});
    assert.equal(addons.remove('s1', s.id).scope, 's1');
    assert.deepEqual(open().list('s1'), { global: [], session: [], params: {} });
  });

  it('sets per-session params, and an empty value drops the override', () => {
    const addons = memoryStore().open();
    const g = addons.add('global', { url: 'http://localhost:1/{q}', params: { q: 'a' } }).addon;
    assert.deepEqual(addons.setParams('s1', g.id, { q: 'b' }).params, { [g.id]: { q: 'b' } });
    assert.deepEqual(addons.list('s2').params, {});
    assert.deepEqual(addons.setParams('s1', g.id, { q: '' }).params, {});
    assert.equal(addons.setParams('s1', 'a99', { q: 'x' }), null);
  });

  it('prunes expired sessions and keeps the global entries', () => {
    const { open, clock } = memoryStore();
    const addons = open();
    addons.add('global', { url: 'http://localhost:1/' });
    addons.add('s1', { url: 'http://localhost:2/' });
    addons.add('s2', { url: 'http://localhost:3/' });
    clock.t += GRACE_MS + 1;
    assert.equal(addons.prune({ known: new Set(['s2']), maxAgeMs: 30 * DAY_MS }), 1);
    assert.equal(addons.list('s1').session.length, 0);
    assert.equal(addons.list('s2').session.length, 1);
    assert.equal(addons.list('s1').global.length, 1);
  });

  it('reads a change another process wrote, and keeps ids rising past the ones on disk', () => {
    const { open } = memoryStore();
    const a = open();
    const b = open();
    a.add('s1', { url: 'http://localhost:1/' });
    let changed = 0;
    const c = open(() => changed++);
    assert.equal(b.add('s1', { url: 'http://localhost:2/' }).addon.id, 'a2');
    c.reload();
    assert.equal(changed, 2);
    assert.deepEqual(
      c.list('s1').session.map((e) => e.id),
      ['a1', 'a2'],
    );
  });

  it('keeps a run command on a global localhost add-on only, and takes a new one on a repeat add', () => {
    const { open } = memoryStore();
    const addons = open();
    const url = 'http://localhost:4117/?cwd={cwd}';
    const cwd = process.cwd();
    assert.throws(() => addons.add('s1', { url, run: 'node a.js' }), code('bad_run'));
    assert.throws(() => addons.add('global', { url: 'https://example.com/', run: 'node a.js' }), code('bad_run'));
    assert.throws(() => addons.add('global', { url, run: 'node a.js\nrm -rf x' }), code('bad_run'));
    assert.throws(() => addons.add('global', { url, run: 'node a.js', cwd: 'rel/dir' }), code('bad_run'));
    assert.throws(() => addons.add('global', { url, cwd }), code('bad_run'));
    const first = addons.add('global', { url, run: 'node a.js', cwd });
    assert.equal(first.addon.run, 'node a.js');
    assert.equal(first.addon.cwd, cwd);
    const again = addons.add('global', { url, run: 'node b.js' });
    assert.equal(again.added, false);
    assert.equal(open().list(null).global[0].run, 'node b.js');
    assert.equal(open().list(null).global[0].cwd, undefined);
    assert.equal(addons.add('global', { url }).addon.run, 'node b.js');
  });
});

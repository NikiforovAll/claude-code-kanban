const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];
const line = (start) => new RegExp(`^${start}.*$`, 'm').exec(src)[0];

class FakeStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

// Values built inside the vm context have that context's prototypes, which strict deepEqual rejects.
const plain = (v) => JSON.parse(JSON.stringify(v));

const blocked = () => {
  throw new Error('SecurityError');
};

function wrap(window, ns = 'cfg-1:') {
  return vm.runInNewContext(
    `const STORAGE_NS = ${JSON.stringify(ns)};
     ${line('const THEME_KEY = ')}
     ${line('const COLOR_THEME_KEY = ')}
     ${line('const FOCUS_ZONE_KEY = ')}
     ${line('const GLOBAL_KEYS = ')}
     ${line('const nsKey = ')}
     ${fn('namespacedStorage')}
     namespacedStorage('localStorage')`,
    { window },
  );
}

describe('namespacedStorage', () => {
  it('prefixes keys with the namespace, except global keys', () => {
    const s = new FakeStorage();
    const store = wrap({ localStorage: s });
    assert.equal(store.setItem('a', '1'), true);
    store.setItem('theme', 'dark');
    store.setItem('color-theme', 'nord');
    store.setItem('focus-zone', 'terminal');
    assert.deepEqual([...s.map.keys()], ['cfg-1:a', 'theme', 'color-theme', 'focus-zone']);
    assert.equal(store.getItem('a'), '1');
    store.removeItem('a');
    assert.equal(s.getItem('cfg-1:a'), null);
  });

  it('lists only keys in its namespace, without the prefix', () => {
    const store = wrap({ localStorage: new FakeStorage({ 'cfg-1:a': '1', 'cfg-2:b': '2', theme: 'x' }) });
    assert.deepEqual(plain(store.keys()), ['a']);
  });

  it('reads JSON and falls back on a missing key or bad JSON', () => {
    const store = wrap({ localStorage: new FakeStorage({ 'cfg-1:ok': '[1,2]', 'cfg-1:bad': '{' }) });
    assert.deepEqual(plain(store.readJson('ok')), [1, 2]);
    assert.deepEqual(store.readJson('bad', []), []);
    assert.deepEqual(store.readJson('missing', {}), {});
    assert.equal(store.readJson('missing'), null);
  });

  it('writes JSON and reports success', () => {
    const s = new FakeStorage();
    assert.equal(wrap({ localStorage: s }).writeJson('k', { a: 1 }), true);
    assert.equal(s.getItem('cfg-1:k'), '{"a":1}');
  });

  it('gives safe values when the browser blocks storage', () => {
    const window = {};
    Object.defineProperty(window, 'localStorage', { get: blocked });
    const store = wrap(window);
    assert.equal(store.getItem('a'), null);
    assert.equal(store.setItem('a', '1'), false);
    assert.equal(store.writeJson('a', 1), false);
    assert.deepEqual(store.readJson('a', []), []);
    assert.deepEqual(plain(store.keys()), []);
    assert.doesNotThrow(() => store.removeItem('a'));
  });

  it('reports a failed write when the quota is full', () => {
    const s = new FakeStorage();
    s.setItem = blocked;
    assert.equal(wrap({ localStorage: s }).writeJson('a', [1]), false);
  });

  it('keeps stored names as they are when there is no namespace', () => {
    const s = new FakeStorage();
    const store = wrap({ localStorage: s }, '');
    store.setItem('a', '1');
    assert.deepEqual([...s.map.keys()], ['a']);
    assert.deepEqual(plain(store.keys()), ['a']);
  });
});

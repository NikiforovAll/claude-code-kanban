const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const HUB = 'http://localhost:3540';
const read = (file) => readFileSync(path.join(__dirname, '..', file), 'utf8');

// Runs the vendored SDK and the page's HUB_INTEGRATION region against stub browser globals.
async function loadShim({ enabled = true, costUrl = null, marketplaceUrl = null, memoryUrl = null } = {}) {
  const region = /\/\/ #region HUB_INTEGRATION\n([\s\S]*?)\/\/ #endregion/.exec(read('public/app.js'))[1];
  const listeners = { keydown: [], message: [], click: [], load: [] };
  const on = (type, fn) => listeners[type]?.push(fn);
  const posted = [];
  const opened = [];
  const timers = [];
  const parent = { postMessage: (message, origin) => posted.push({ message, origin }) };
  const context = vm.createContext({
    parent,
    top: parent,
    URL,
    URLSearchParams,
    console,
    __HUB__: enabled ? { enabled: true, url: HUB } : undefined,
    document: {
      readyState: 'complete',
      addEventListener: on,
      body: { classList: { contains: () => false }, dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    },
    addEventListener: on,
    fetch: async () => ({ json: async () => ({ enabled, url: enabled ? HUB : null }) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (fn) => timers.push(fn),
    open: (...args) => opened.push(args),
    appConfig: { costUrl, marketplaceUrl, memoryUrl },
    CCK_CTRL_ALT_KEYS: new Set(['KeyN', 'KeyR', 'KeyS']),
    MutationObserver: class {
      observe() {}
    },
  });
  context.window = context;
  vm.runInContext(read('public/vendor/claude-hub-sdk.js'), context);
  vm.runInContext(region, context);
  const filter = /^function terminalKeyFilter\(e\) \{[\s\S]*?^\}/m.exec(read('public/app.js'))[0];
  vm.runInContext(`const terminalShortcut = () => false;\n${filter}`, context);
  await new Promise((r) => setImmediate(r));

  return {
    hub: vm.runInContext('hub', context),
    terminalKeeps: (init) =>
      context.terminalKeyFilter({ type: 'keydown', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init }),
    opened,
    endWait: () => {
      for (const fn of timers.splice(0)) fn();
    },
    sent: () => posted.map((p) => p.message),
    press(init) {
      const before = posted.length;
      let prevented = false;
      const e = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: '', ...init };
      e.preventDefault = () => {
        prevented = true;
      };
      for (const fn of listeners.keydown) fn(e);
      const sent = posted.slice(before).filter((p) => p.message.type === 'hub:keydown');
      return sent.length === 1 && prevented;
    },
    receive(data, { source = parent, origin = HUB } = {}) {
      for (const fn of listeners.message) fn({ data, source, origin });
    },
  };
}

const KEYS = ['ctrl+alt+p', 'ctrl+alt+w', 'ctrl+alt+ArrowLeft', 'ctrl+alt+ArrowRight', 'alt+1', 'alt+2'];
const welcome = (actions) => ({ type: 'hub:welcome', protocol: 1, forward: KEYS, themes: [], actions });

describe('hub key forwarding', () => {
  it('forwards the old set, minus N, R and S, until the hub sends its keys', async () => {
    const shim = await loadShim();
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), true);
    assert.equal(shim.press({ altKey: true, key: '7', code: 'Digit7' }), true);
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'ArrowLeft', code: 'ArrowLeft' }), true);
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'n', code: 'KeyN' }), false);
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 's', code: 'KeyS' }), false);
    assert.equal(shim.press({ ctrlKey: true, key: 'q', code: 'KeyQ' }), false);
  });

  for (const [label, message] of [
    ['hub:keys', { type: 'hub:keys', keys: KEYS }],
    ['welcome.forward', welcome([])],
  ]) {
    it(`forwards only the listed combos after ${label}`, async () => {
      const shim = await loadShim();
      shim.receive(message);
      assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' }), true);
      assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'ArrowRight', code: 'ArrowRight' }), true);
      assert.equal(shim.press({ altKey: true, key: '2', code: 'Digit2' }), true);
      assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), false);
      assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'n', code: 'KeyN' }), false);
      assert.equal(shim.press({ altKey: true, key: '3', code: 'Digit3' }), false);
      assert.equal(shim.press({ ctrlKey: true, altKey: true, shiftKey: true, key: 'P', code: 'KeyP' }), false);
    });
  }

  it('names macOS composed characters by the physical key', async () => {
    const shim = await loadShim();
    shim.receive({ type: 'hub:keys', keys: KEYS });
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'π', code: 'KeyP' }), true);
    assert.equal(shim.press({ altKey: true, key: '¡', code: 'Digit1' }), true);
  });

  it('ignores hub:keys from another origin or frame', async () => {
    const shim = await loadShim();
    shim.receive({ type: 'hub:keys', keys: [] }, { origin: 'http://evil.example' });
    shim.receive({ type: 'hub:keys', keys: [] }, { source: {} });
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), true);
  });

  it('hands the terminal back only the keys the hub gets', async () => {
    const shim = await loadShim();
    shim.receive({ type: 'hub:keys', keys: KEYS });
    assert.equal(shim.terminalKeeps({ ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' }), false);
    assert.equal(shim.terminalKeeps({ ctrlKey: true, altKey: true, key: 'n', code: 'KeyN' }), true);
    assert.equal(shim.terminalKeeps({ ctrlKey: true, key: 'l', code: 'KeyL' }), true);
    const alone = await loadShim({ enabled: false });
    assert.equal(alone.terminalKeeps({ ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' }), true);
  });

  it('forwards nothing standalone', async () => {
    const shim = await loadShim({ enabled: false });
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), false);
  });
});

describe('session.cost', () => {
  it('invokes the action when the hub lists it, and cannot when it does not', async () => {
    const shim = await loadShim();
    shim.receive(welcome(['session.cost']));
    assert.equal(shim.hub.can('session.cost'), true);
    shim.hub.invoke('session.cost', { session: 's1' });
    const call = shim.sent().find((m) => m.type === 'hub:invoke');
    assert.deepEqual({ ...call, id: 0 }, { type: 'hub:invoke', id: 0, action: 'session.cost', params: { session: 's1' } });

    const off = await loadShim();
    off.receive(welcome([]));
    assert.equal(off.hub.can('session.cost'), false);
  });

  it('falls back to hub:navigate when the hub sends no welcome', async () => {
    const shim = await loadShim();
    shim.hub.invoke('session.cost', { session: 'a b' });
    shim.endWait();
    await shim.hub.invoke('session.cost', {});
    const navs = shim.sent().filter((m) => m.type === 'hub:navigate');
    assert.equal(shim.hub.can('session.cost'), true);
    assert.deepEqual(
      navs.map((m) => ({ ...m })),
      [
        { type: 'hub:navigate', app: 'cost', url: '?view=detail&session=a%20b' },
        { type: 'hub:navigate', app: 'cost', url: undefined },
      ],
    );
  });

  it('opens --cost-url standalone, and cannot without it', async () => {
    const shim = await loadShim({ enabled: false, costUrl: 'http://localhost:3543/' });
    assert.equal(shim.hub.can('session.cost'), true);
    await shim.hub.invoke('session.cost', { session: 's1' });
    assert.equal(shim.opened[0][0], 'http://localhost:3543/?view=detail&session=s1');
    const bare = await loadShim({ enabled: false });
    assert.equal(bare.hub.can('session.cost'), false);
  });
});

describe('project.plugins and project.memory', () => {
  it('invokes each action only when the hub lists it', async () => {
    const shim = await loadShim();
    shim.receive(welcome(['project.plugins']));
    assert.equal(shim.hub.can('project.plugins'), true);
    assert.equal(shim.hub.can('project.memory'), false);
    shim.hub.invoke('project.plugins', { project: 'C:/p' });
    const call = shim.sent().find((m) => m.type === 'hub:invoke');
    assert.deepEqual({ ...call, id: 0 }, { type: 'hub:invoke', id: 0, action: 'project.plugins', params: { project: 'C:/p' } });
  });

  it('falls back to hub:navigate when the hub sends no welcome', async () => {
    const shim = await loadShim();
    shim.endWait();
    await shim.hub.invoke('project.plugins', { project: 'C:/a b' });
    await shim.hub.invoke('project.memory', {});
    const navs = shim.sent().filter((m) => m.type === 'hub:navigate');
    assert.deepEqual(
      navs.map((m) => ({ ...m })),
      [
        { type: 'hub:navigate', app: 'marketplace', url: '?project=C%3A%2Fa+b' },
        { type: 'hub:navigate', app: 'memory', url: undefined },
      ],
    );
  });

  it('opens the --*-url flags standalone, and cannot without them', async () => {
    const shim = await loadShim({
      enabled: false,
      marketplaceUrl: 'http://localhost:3542/',
      memoryUrl: 'http://localhost:3544/?x=1',
    });
    await shim.hub.invoke('project.plugins', { project: 'C:/p' });
    await shim.hub.invoke('project.memory', { project: 'C:/p' });
    await shim.hub.invoke('project.memory', {});
    assert.deepEqual(
      shim.opened.map((a) => a[0]),
      ['http://localhost:3542/?project=C%3A%2Fp', 'http://localhost:3544/?project=C%3A%2Fp'],
    );
    const bare = await loadShim({ enabled: false });
    assert.equal(bare.hub.can('project.plugins'), false);
    assert.equal(bare.hub.can('project.memory'), false);
  });
});

// claude-hub-sdk 1.4.0 (sha256 7d559a8888ce). Copied by npm run sdk:sync in claude-code-hub. Do not edit.
// Claude Code Hub SDK: the one rule that names a key press, shared by the hub page, client.js and
// stub.js. The hub serves it to its page as /sdk/keys.js; mount() and sdk:sync put it in front of
// client.js and stub.js, so an app still loads one file.
// var, not const: the hub page and an app page each load it as a classic script, and a second
// const declaration in the same page would throw.
var ClaudeHubKeys = (() => {
  'use strict';

  // Modifiers in ctrl, alt, shift, meta order, joined by '+' to the key. macOS composes
  // Option+<key> into a character (Option+1 is '¡', Option+P is 'π') and holding Control does not
  // undo it, so e.key alone cannot name these presses there. e.code is the physical key, which is
  // wrong for non-US layouts, hence only as a fallback. No fallback under AltGraph: Chromium sets it
  // when AltGr types a character, and that press is text. Takes a real KeyboardEvent or a forwarded
  // {key, code} payload; a payload without code degrades to key. A payload needs no AltGraph: the
  // SDK forwards only a press whose key already names a bound combo.
  // Self-contained on purpose: cck puts its source text into a sandboxed frame.
  function comboOf(e) {
    const lower = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    const m = !e.getModifierState?.('AltGraph') && /^(?:Key|Digit)([A-Z1-9])$/.exec(e.code || '');
    const key = /^[a-z1-9]$/.test(lower) ? lower : m ? m[1].toLowerCase() : e.key;
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'];
    return [...mods, key].filter(Boolean).join('+');
  }

  // The keys of a combo as a help row shows them: ['Ctrl', 'Alt', 'P'], or ['⌃', '⌥', 'P'] on macOS.
  // The {n} of a numbered combo reads 1…9.
  function keyParts(combo, mac) {
    const mods = mac
      ? { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
      : { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };
    const named = { '{n}': '1…9', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
    return combo.split('+').map((k) => mods[k] ?? named[k] ?? (k.length === 1 ? k.toUpperCase() : k));
  }

  return { comboOf, keyParts };
})();

if (typeof module === 'object' && module.exports) module.exports = ClaudeHubKeys;

// Claude Code Hub SDK: the app side of the hub protocol v1.
// A classic script. Load it as the first element in <body>, with no defer or async,
// so the cached theme is on the page before the first paint (protocol section 6, rule 3).
((root) => {
  'use strict';

  const VARS_KEY = 'claude-hub:vars';
  const WELCOME_WAIT_MS = 2000;

  // keys.js comes first in the served file. Required as a module, client.js loads it itself.
  const { comboOf, keyParts } = typeof ClaudeHubKeys === 'object' ? ClaudeHubKeys : require('./keys');

  function isVars(v) {
    return (
      !!v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.entries(v).every(([k, val]) => k.startsWith('--') && typeof val === 'string')
    );
  }

  function sameVars(a, b) {
    if (!a || !b) return a === b;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
  }

  const strings = (list) => new Set(Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);

  const isMac = (win) => /^Mac/i.test(win.navigator?.userAgentData?.platform || win.navigator?.platform || '');

  const comboMap = (keys) =>
    new Map(
      keys && typeof keys === 'object' && !Array.isArray(keys)
        ? Object.entries(keys).filter(([, c]) => c === null || (typeof c === 'string' && c))
        : [],
    );

  function createClaudeHub(win) {
    const doc = win.document;
    const framed = win.top !== win;
    let appliedVars = null;
    let hub = null;

    function setVars(vars) {
      const body = doc.body;
      if (!body || sameVars(vars, appliedVars)) return false;
      for (const k of Object.keys(appliedVars || {})) if (!vars || !(k in vars)) body.style.removeProperty(k);
      for (const [k, v] of Object.entries(vars || {})) body.style.setProperty(k, v);
      appliedVars = vars;
      return true;
    }

    function adoptVars(vars) {
      if (!setVars(vars) && vars) return;
      try {
        if (vars) win.localStorage.setItem(VARS_KEY, JSON.stringify(vars));
        else win.localStorage.removeItem(VARS_KEY);
      } catch (_) {}
    }

    function readVars() {
      try {
        const v = JSON.parse(win.localStorage.getItem(VARS_KEY));
        return isVars(v) ? v : null;
      } catch (_) {
        return null;
      }
    }

    if (framed) setVars(readVars());

    function connect({ standalone = {} } = {}) {
      if (hub) return hub;
      const topics = new Map();
      const activeFns = new Set();
      const statusFns = new Set();
      const handlers = new Map();
      const pending = new Map();
      const tokenWaiters = new Set();
      const themesFns = new Set();
      const queued = [];
      // Topic → payload: the latest publish before welcome.
      const outbox = new Map();
      let status = 'connecting';
      let origin = null;
      let welcome = null;
      let forward = null;
      let themeBinding = null;
      let lastTheme = null;
      let swatchesPainted = false;
      let nextId = 0;

      const waiting = () => status === 'connecting' || status === 'waiting';
      const standaloneFn = (action) => {
        if (status !== 'standalone') return null;
        const fn = (typeof standalone === 'function' ? standalone() : standalone)[action];
        return typeof fn === 'function' ? fn : null;
      };

      function post(msg) {
        if (origin) win.parent.postMessage(msg, origin);
      }

      function setStatus(next) {
        status = next;
        for (const fn of statusFns) fn(next);
        if (waiting()) return;
        for (const run of queued.splice(0)) run();
        for (const [topic, payload] of outbox) hub.publish(topic, payload);
        outbox.clear();
      }

      function emit(topic, payload) {
        for (const fn of topics.get(topic) || []) fn(payload);
      }

      function themeKey(t) {
        return `${t.theme}|${t.colorTheme}`;
      }

      function applyMode(p) {
        if (!themeBinding || typeof p.theme !== 'string') return;
        const cur = themeBinding.get();
        const colorTheme = typeof p.colorTheme === 'string' ? p.colorTheme : cur.colorTheme;
        if (cur.theme !== p.theme || cur.colorTheme !== colorTheme) themeBinding.set({ theme: p.theme, colorTheme });
        themeBinding.last = themeKey(themeBinding.get());
      }

      function themeIn(p) {
        if (!p || typeof p !== 'object') return;
        if (isVars(p.vars)) adoptVars(p.vars);
        else if (!waiting()) adoptVars(null);
        lastTheme = p;
        applyMode(p);
        emit('theme.changed', p);
      }

      // The rules have the form scripts/generate-themes.mjs writes into each app's themes.css, so a
      // built-in id gets the hub's swatch, which carries the user's change to that theme.
      function pickerThemes() {
        if (!swatchesPainted) {
          swatchesPainted = true;
          const vars = (s) =>
            ['bg', 'accent', 'ink', 'border']
              .filter((k) => typeof s?.[k] === 'string')
              .map((k) => `--sw-${k}: ${s[k]};`)
              .join(' ');
          const style = doc.createElement('style');
          style.textContent = welcome.themes
            .map(
              (t) =>
                `.theme-swatch-${t.id} { ${vars(t.swatch?.dark)} }\nbody.light .theme-swatch-${t.id} { ${vars(t.swatch?.light)} }`,
            )
            .join('\n');
          doc.head.appendChild(style);
        }
        return welcome.themes.map(({ id, label }) => ({ id, label }));
      }

      function onWelcome(m) {
        if (m.protocol !== 1 || welcome) return;
        welcome = {
          actions: strings(m.actions),
          keys: comboMap(m.keys),
          themes: Array.isArray(m.themes) ? m.themes : [],
        };
        forward = strings(m.forward);
        setStatus('live');
        if (welcome.themes.length) for (const fn of themesFns) fn(pickerThemes());
        themesFns.clear();
      }

      function onMessage(e) {
        if (!origin || e.source !== win.parent || e.origin !== origin) return;
        const m = e.data;
        if (!m || typeof m.type !== 'string') return;
        switch (m.type) {
          case 'hub:welcome':
            return onWelcome(m);
          case 'hub:event':
            if (typeof m.topic !== 'string') return;
            if (m.topic === 'theme.changed') return themeIn(m.payload);
            return emit(m.topic, m.payload);
          case 'hub:active':
            for (const fn of activeFns) fn(!!m.active);
            return;
          case 'hub:action': {
            const fn = handlers.get(m.action);
            if (fn) fn(m.params || {}, { id: m.id });
            else console.warn(`[claude-hub] no handler for action ${m.action}`);
            return;
          }
          case 'hub:result': {
            const resolve = pending.get(m.id);
            if (!resolve) return;
            pending.delete(m.id);
            const { type, ...result } = m;
            return resolve(result);
          }
          case 'hub:terminalToken':
            for (const done of [...tokenWaiters]) done(typeof m.token === 'string' ? m.token : null);
            return;
        }
      }

      function forwards(e) {
        return !!forward && forward.has(comboOf(e));
      }

      function onKeydown(e) {
        if (!forwards(e)) return;
        e.preventDefault();
        post({
          type: 'hub:keydown',
          key: e.key,
          code: e.code,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          shift: e.shiftKey,
          meta: e.metaKey,
        });
      }

      function run(action, params, resolve) {
        if (status === 'live') {
          const id = String(++nextId);
          pending.set(id, resolve);
          return post({ type: 'hub:invoke', id, action, params });
        }
        const target = standaloneFn(action)?.(params);
        if (!target) return resolve({ ok: false, reason: 'unhandled' });
        win.open(target, '_blank', 'noopener');
        resolve({ ok: true, handledBy: 'standalone' });
      }

      win.addEventListener('message', onMessage);
      doc.addEventListener('keydown', onKeydown);

      const loaded =
        doc.readyState === 'complete'
          ? Promise.resolve()
          : new Promise((r) => win.addEventListener('load', r, { once: true }));
      const config = win
        .fetch('/hub-config')
        .then((r) => r.json())
        .catch(() => ({}))
        .then((cfg) => {
          try {
            if (framed && cfg?.enabled === true) origin = new URL(cfg.url).origin;
          } catch (_) {}
          if (!origin) {
            setVars(null);
            setStatus('standalone');
          }
        });

      Promise.all([config, loaded]).then(() => {
        if (!origin) return;
        post({ type: 'hub:hello', protocol: [1], subscribes: [...topics.keys()] });
        setStatus('waiting');
        // A hub older than protocol v1 never answers. The app then runs as if alone, with no hub calls.
        win.setTimeout(() => {
          if (welcome) return;
          adoptVars(null);
          setStatus('unanswered');
        }, WELCOME_WAIT_MS);
      });

      const topicFns = (topic) => {
        if (!topics.has(topic)) topics.set(topic, new Set());
        return topics.get(topic);
      };

      hub = {
        get status() {
          return status;
        },
        get themes() {
          return welcome ? welcome.themes : [];
        },
        // True once /hub-config says a hub frames this page, whether or not it answers hello.
        get inHub() {
          return !!origin;
        },
        onStatus(fn) {
          statusFns.add(fn);
          return () => statusFns.delete(fn);
        },
        onActive(fn) {
          activeFns.add(fn);
          return () => activeFns.delete(fn);
        },
        // Calls fn once with the hub's themes as [{id, label}], after it paints their picker swatches
        // (protocol section 6, rule 5). Never when standalone, with no welcome, or when the hub has no themes.
        onThemes(fn) {
          if (!welcome) {
            themesFns.add(fn);
            return () => themesFns.delete(fn);
          }
          if (welcome.themes.length) fn(pickerThemes());
          return () => {};
        },
        subscribe(topic, fn) {
          const fns = topicFns(topic);
          fns.add(fn);
          return () => fns.delete(fn);
        },
        bindTheme({ get, set }) {
          topicFns('theme.changed');
          themeBinding = { get, set, last: themeKey(get()) };
          if (lastTheme) applyMode(lastTheme);
          return function report() {
            const cur = get();
            const key = themeKey(cur);
            if (key === themeBinding.last) return;
            themeBinding.last = key;
            // The inline vars are the old pick's and outrank the app's own themes.css. Until the hub
            // echoes the new pick's vars, a script that reads computed colors now would get the old ones.
            setVars(null);
            post({ type: 'hub:theme', theme: cur.theme, colorTheme: cur.colorTheme });
          };
        },
        handle(action, fn) {
          handlers.set(action, fn);
        },
        // The topic must be in the app's manifest `publishes`. Before welcome, only the latest payload per topic waits.
        publish(topic, payload) {
          if (status === 'live') post({ type: 'hub:publish', topic, payload });
          else if (waiting()) outbox.set(topic, payload);
        },
        invoke(action, params = {}) {
          return new Promise((resolve) => {
            if (waiting()) queued.push(() => run(action, params, resolve));
            else run(action, params, resolve);
          });
        },
        can(action) {
          if (status === 'live') return welcome.actions.has(action);
          return !!standaloneFn(action);
        },
        // For an element that eats keys before the document sees them, like a terminal.
        forwards,
        // The combos forwards() matches, for a frame that tests keys with ClaudeHub.comboOf on its own.
        forwardCombos: () => (forward ? [...forward] : []),
        // The keys of a hub action for a help row, in this system's names. A list of actions shares one
        // row: ['Ctrl', 'Alt', '←/→']. [] when no key runs them; null before welcome, standalone, or
        // for an action the hub did not list.
        keyLabel(action) {
          const ids = Array.isArray(action) ? action : [action];
          if (!welcome || !ids.every((id) => welcome.keys.has(id))) return null;
          const all = ids
            .map((id) => welcome.keys.get(id))
            .filter(Boolean)
            .map((c) => keyParts(c, isMac(win)));
          if (all.length < 2) return all[0] ?? [];
          let n = 0;
          while (n < all[0].length - 1 && all.every((p) => p.length - 1 > n && p[n] === all[0][n])) n++;
          return [...all[0].slice(0, n), all.map((p) => p.slice(n).join('+')).join('/')];
        },
        closeGuard(on) {
          post({ type: 'hub:closeGuard', on: !!on });
        },
        // In the hub's installed PWA window, a framed page's own _blank open does nothing.
        openExternal(url) {
          if (origin) post({ type: 'hub:openExternal', url });
          else win.open(url, '_blank', 'noopener');
        },
        // Resolves the hub's answer, or null standalone or after 3 s. The hub answers only its terminal provider.
        terminalToken() {
          return config.then(
            () =>
              origin &&
              new Promise((resolve) => {
                const done = (token) => {
                  tokenWaiters.delete(done);
                  win.clearTimeout(timer);
                  resolve(token);
                };
                const timer = win.setTimeout(() => done(null), 3000);
                tokenWaiters.add(done);
                post({ type: 'hub:terminalToken' });
              }),
          );
        },
      };
      return hub;
    }

    return { connect, comboOf };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createClaudeHub, comboOf };
  else root.ClaudeHub = createClaudeHub(root);
})(typeof window !== 'undefined' ? window : globalThis);

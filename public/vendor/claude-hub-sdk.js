// claude-hub-sdk 0.0.0 (sha256 8ff4c950d349). Copied by npm run sdk:sync in claude-code-hub. Do not edit.
// Claude Code Hub SDK: the app side of the hub protocol v1, with the v0 fallback.
// A classic script. Load it as the first element in <body>, with no defer or async,
// so the cached theme is on the page before the first paint (protocol section 6, rule 3).
((root) => {
  'use strict';

  const VARS_KEY = 'claude-hub:vars';
  const WELCOME_WAIT_MS = 2000;

  // The hub's comboOf(). macOS turns Option+<key> into another character, so e.code is the fallback.
  function comboOf(e) {
    const lower = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    const m = /^(?:Key|Digit)([A-Z1-9])$/.exec(e.code || '');
    const key = /^[a-z1-9]$/.test(lower) ? lower : m ? m[1].toLowerCase() : e.key;
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'];
    return [...mods, key].filter(Boolean).join('+');
  }

  // What a hub with no key list expects (protocol section 11, legacy filter).
  const LEGACY_COMBO = /^(?:ctrl\+alt\+(?:shift\+)?(?:meta\+)?Arrow(?:Left|Right)|ctrl\+alt\+[a-z]|alt\+[1-9])$/;

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

    function connect({ standalone = {}, legacy = {}, reserved = [] } = {}) {
      if (hub) return hub;
      const reservedCombos = new Set(reserved);
      const topics = new Map();
      const activeFns = new Set();
      const statusFns = new Set();
      const handlers = new Map();
      const pending = new Map();
      const tokenWaiters = new Set();
      const queued = [];
      let status = 'connecting';
      let origin = null;
      let welcome = null;
      let helloTopics = new Set();
      let forward = null;
      let themeBinding = null;
      let lastTheme = null;
      let nextId = 0;

      const waiting = () => status === 'connecting' || status === 'waiting';
      const fallback = () => {
        if (status !== 'standalone') return legacy;
        return typeof standalone === 'function' ? standalone() : standalone;
      };

      function post(msg) {
        if (origin) win.parent.postMessage(msg, origin);
      }

      function setStatus(next) {
        status = next;
        for (const fn of statusFns) fn(next);
        if (!waiting()) for (const run of queued.splice(0)) run();
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

      function onWelcome(m) {
        if (m.protocol !== 1 || welcome) return;
        welcome = { actions: strings(m.actions), themes: Array.isArray(m.themes) ? m.themes : [] };
        forward = strings(m.forward);
        setStatus('live');
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
          case 'hub:theme':
            if (welcome && helloTopics.has('theme.changed')) return;
            if (welcome && !m.vars && welcome.themes.length) return;
            return themeIn({ theme: m.theme, colorTheme: m.colorTheme, ...(m.vars ? { vars: m.vars } : {}) });
          case 'hub:project':
            if (welcome && helloTopics.has('project.changed')) return;
            if (typeof m.encoded !== 'string' || !m.encoded) return;
            return emit('project.changed', { project: m.project, encoded: m.encoded, name: m.name });
          case 'hub:keys':
            if (!welcome && Array.isArray(m.keys)) forward = strings(m.keys);
            return;
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
        if (!origin) return false;
        const combo = comboOf(e);
        if (forward) return forward.has(combo);
        return !reservedCombos.has(combo) && LEGACY_COMBO.test(combo);
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
        const table = fallback();
        const target = typeof table[action] === 'function' ? table[action](params) : null;
        if (!target) return resolve({ ok: false, reason: 'unhandled' });
        if (status === 'standalone') {
          win.open(target, '_blank', 'noopener');
          return resolve({ ok: true, handledBy: 'standalone' });
        }
        post({ type: 'hub:navigate', app: target.app, url: target.url });
        resolve({ ok: true, handledBy: target.app });
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
        helloTopics = new Set(topics.keys());
        post({ type: 'hub:hello', protocol: [1], subscribes: [...helloTopics] });
        setStatus('waiting');
        win.setTimeout(() => {
          if (welcome) return;
          adoptVars(null);
          setStatus('legacy');
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
        invoke(action, params = {}) {
          return new Promise((resolve) => {
            if (waiting()) queued.push(() => run(action, params, resolve));
            else run(action, params, resolve);
          });
        },
        can(action) {
          if (status === 'live') return welcome.actions.has(action);
          if (status === 'connecting') return false;
          return typeof fallback()[action] === 'function';
        },
        // For an element that eats keys before the document sees them, like a terminal.
        forwards,
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

    return { connect };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createClaudeHub, comboOf };
  else root.ClaudeHub = createClaudeHub(root);
})(typeof window !== 'undefined' ? window : globalThis);

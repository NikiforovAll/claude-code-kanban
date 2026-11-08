// claude-hub-sdk 1.12.0 (sha256 6fb679e4d801). Copied by npm run sdk:sync in claude-code-hub. Do not edit.
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
  // wrong for non-US layouts, hence only as a fallback. A letter or punctuation key falls back to its
  // US character only when e.key is not ASCII (a non-Latin layout, or Option on macOS), so AZERTY's
  // ',' on the M key stays ','. The digit row always falls back, so AZERTY's '&' key is 1, as Windows
  // and VS Code treat it. No fallback under AltGraph: Chromium sets it when AltGr types a character, and that
  // press is text. Takes a real KeyboardEvent or a forwarded {key, code} payload; a payload without
  // code degrades to key. A payload needs no AltGraph: the SDK forwards only a press whose key
  // already names a bound combo.
  // Self-contained on purpose, the table too: cck puts its source text into a sandboxed frame.
  // codeOf() lists the same keys the other way round.
  function comboOf(e) {
    const raw = typeof e.key === 'string' ? e.key : '';
    const lower = raw.toLowerCase();
    const code = e.getModifierState?.('AltGraph') ? '' : e.code || '';
    const latin = !/[^\x20-\x7e]/.test(raw);
    const digit = /^Digit([0-9])$/.exec(code)?.[1];
    const us =
      !latin &&
      (/^Key([A-Z])$/.exec(code)?.[1].toLowerCase() ||
        {
          Minus: '-',
          Equal: '=',
          BracketLeft: '[',
          BracketRight: ']',
          Backslash: '\\',
          Semicolon: ';',
          Quote: "'",
          Backquote: '`',
          Comma: ',',
          Period: '.',
          Slash: '/',
        }[code]);
    const key = /^[a-z0-9]$/.test(lower) ? lower : digit || us || (e.key === ' ' ? 'Space' : e.key);
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'];
    return [...mods, key].filter(Boolean).join('+');
  }

  // The physical key (e.code) that types a combo's key on a US layout, or null for a named key.
  function codeOf(key) {
    if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    const codes = {
      '-': 'Minus',
      '=': 'Equal',
      '[': 'BracketLeft',
      ']': 'BracketRight',
      '\\': 'Backslash',
      ';': 'Semicolon',
      "'": 'Quote',
      '`': 'Backquote',
      ',': 'Comma',
      '.': 'Period',
      '/': 'Slash',
    };
    return codes[key] ?? null;
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

  // A host claim (protocol §5.2) names a press by its physical code, or by its character when the layout
  // moves the key: {ctrlKey?, altKey?, shiftKey?, metaKey?, code, key: 'Unidentified'} or {…, key, code: ''}.
  // A press matches a claim when one of its two signatures is the claim's first. AltGr types a
  // character, so its press matches by character only. cck's frames use the same format.
  function keySigs(e) {
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta']
      .filter(Boolean)
      .join('+');
    return [
      e.code && !e.getModifierState?.('AltGraph') && `${mods}|c:${e.code}`,
      typeof e.key === 'string' && e.key !== 'Unidentified' && `${mods}|k:${e.key.toLowerCase()}`,
    ].filter(Boolean);
  }

  return { comboOf, codeOf, keyParts, keySigs };
})();

if (typeof module === 'object' && module.exports) module.exports = ClaudeHubKeys;

// Claude Code Hub SDK: the runtime of hub mods, shared by client.js and the hub page. mount() and
// sdk:sync put it in front of client.js; the hub page gets it inside /mods/hub.js.
// var, not const: the hub page and an app page each load it as a classic script.
var ClaudeHubModKit = (() => {
  'use strict';

  // "<mod id>:<name>". The id must be an installed mod's, so two mods cannot share a topic.
  const TOPIC_RE = /^([a-z0-9-]+):[\w.-]+$/;

  // The page's mod list is in win.ClaudeHubMods, ahead of this file. Each CSS file loads after the
  // page's own styles; each JS file is a deferred script, so it runs after a deferred app.js, in
  // list order. ?nomods in the page URL loads none: the safe mode for a mod that breaks the page.
  function createMods(win) {
    const doc = win.document;
    const off = /[?&]nomods(?:[=&]|$)/.test(win.location?.search ?? '');
    // Only an app's own tab, or the page on its own. A page nested in an app's page (cck's terminal,
    // a pane) is not what the mod was written for, and ?nomods reaches only the tabs.
    const nested = win.parent !== win.top;
    const assets = off || nested ? null : win.ClaudeHubMods;
    const list = assets?.mods ?? [];
    const ids = new Set(list.map((m) => m.id));
    const listeners = new Map();
    const wrappedNames = new Set();
    const outbox = new Map();
    let sender = null;
    const report = (what, err) => win.console?.error?.(`[hub mod] ${what}:`, err);

    function load() {
      if (!assets || !doc) return;
      const js = assets.js ?? [];
      // Mod code runs with the page's rights. connect-src stops fetch, XHR, WebSocket and beacons to
      // other hosts; it does not stop image or script loads or navigation, so it guards against a
      // careless mod, not a hostile one. Consent at install is the real boundary. A wider policy
      // (script-src, img-src) would break the apps' own inline scripts and remote images.
      if (js.length) {
        doc.head.appendChild(
          Object.assign(doc.createElement('meta'), {
            httpEquiv: 'Content-Security-Policy',
            content: "connect-src 'self'",
          }),
        );
      }
      const tags = [
        ...(assets.css ?? []).map((href) => Object.assign(doc.createElement('link'), { rel: 'stylesheet', href })),
        ...js.map((src) => Object.assign(doc.createElement('script'), { src, defer: true })),
      ];
      // document.write keeps a parser-inserted script deferred and in order; appendChild needs async off for that.
      if (!tags.length) return;
      if (doc.readyState === 'loading') doc.write(tags.map((t) => t.outerHTML).join(''));
      else
        for (const t of tags) {
          if (t.tagName === 'SCRIPT') t.async = false;
          (t.tagName === 'LINK' ? doc.head : doc.body).appendChild(t);
        }
    }

    // fn(original, ...args). When fn throws, the wrapper returns what original returned, and runs
    // original first if fn had not called it yet, so a broken mod leaves the app as it was.
    function wrap(name, fn) {
      const original = win[name];
      if (typeof original !== 'function') {
        report(`wrap(${name})`, new Error('the app has no such global function'));
        return false;
      }
      if (wrappedNames.has(name))
        win.console?.warn?.(`[hub mod] wrap(${name}): two mods wrap it; the later one runs outside the earlier`);
      wrappedNames.add(name);
      win[name] = function wrapped(...args) {
        let called = false;
        let result;
        const next = (...a) => {
          called = true;
          result = original.apply(this, a.length ? a : args);
          return result;
        };
        try {
          return fn.call(this, next, ...args);
        } catch (err) {
          report(`wrap(${name})`, err);
          return called ? result : original.apply(this, args);
        }
      };
      return true;
    }

    function on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    }

    function emit(event, detail) {
      for (const fn of listeners.get(event) ?? []) {
        try {
          fn(detail);
        } catch (err) {
          report(`on(${event})`, err);
        }
      }
    }

    // To the same mod's code on the hub page, as mod.on(topic) there with {app, data}. Before the
    // hub answers, only the latest data per topic waits.
    function send(topic, data) {
      const m = TOPIC_RE.exec(typeof topic === 'string' ? topic : '');
      if (!m || !ids.has(m[1])) {
        report(`send(${topic})`, new Error('the topic must be "<mod id>:<name>", with the id of an installed mod'));
        return false;
      }
      if (sender) sender({ type: 'hub:mod', topic, data });
      else outbox.set(topic, data);
      return true;
    }

    function connectSender(fn) {
      sender = fn;
      for (const [topic, data] of outbox) fn({ type: 'hub:mod', topic, data });
      outbox.clear();
    }

    load();
    return { mod: { list, wrap, on, emit, send }, connectSender };
  }

  return { createMods, TOPIC_RE };
})();

if (typeof module === 'object' && module.exports) module.exports = ClaudeHubModKit;

// Claude Code Hub SDK: the app side of the hub protocol v1.
// A classic script. Load it as the first element in <body>, with no defer or async,
// so the cached theme is on the page before the first paint (protocol section 6, rule 3).
((root) => {
  'use strict';

  // Holds {origin, vars}: the hub origin that sent the cached vars. Every config dir's app shares the
  // hub's proxy port, so a page framed by something other than the hub would otherwise paint the hub's last theme.
  const VARS_KEY = 'claude-hub:vars';
  const WELCOME_WAIT_MS = 2000;
  // A press in one of these types text, so the host never gets it.
  const FIELDS =
    'input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=range], [type=color], [type=file], [type=image]), textarea, select, [contenteditable]';

  // keys.js comes first in the served file. Required as a module, client.js loads it itself.
  const { comboOf, keyParts, keySigs } = typeof ClaudeHubKeys === 'object' ? ClaudeHubKeys : require('./keys');
  const { createMods } = typeof ClaudeHubModKit === 'object' ? ClaudeHubModKit : require('./mods');

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

  // The page's light or dark, for mod CSS: [data-hub-mode="light"]. Cached so it is set before the hub answers.
  const MODE_KEY = 'claude-hub:mode';

  function createClaudeHub(win) {
    const doc = win.document;
    const framed = win.top !== win;
    let appliedVars = null;
    let hub = null;
    const mods = createMods(win);
    const { mod } = mods;

    function setMode(mode) {
      if (mode !== 'light' && mode !== 'dark') return;
      if (doc.documentElement) doc.documentElement.dataset.hubMode = mode;
      try {
        win.localStorage.setItem(MODE_KEY, mode);
      } catch (_) {}
    }

    function setVars(vars) {
      const body = doc.body;
      if (!body || sameVars(vars, appliedVars)) return false;
      for (const k of Object.keys(appliedVars || {})) if (!vars || !(k in vars)) body.style.removeProperty(k);
      for (const [k, v] of Object.entries(vars || {})) body.style.setProperty(k, v);
      appliedVars = vars;
      return true;
    }

    function adoptVars(vars, from) {
      if (!setVars(vars) && vars) return;
      try {
        if (vars) win.localStorage.setItem(VARS_KEY, JSON.stringify({ origin: from, vars }));
        else win.localStorage.removeItem(VARS_KEY);
      } catch (_) {}
    }

    function readCache() {
      try {
        const c = JSON.parse(win.localStorage.getItem(VARS_KEY));
        return c && isVars(c.vars) ? c : null;
      } catch (_) {
        return null;
      }
    }

    // The hub is the top window, also for a page framed inside another app's page, such as a cck
    // pane. Firefox does not list the ancestors, so there any origin passes.
    const ancestors = win.location?.ancestorOrigins;
    const topOrigin = ancestors?.length ? ancestors[ancestors.length - 1] : undefined;
    const hubOnTop = (o) => topOrigin === undefined || topOrigin === o;

    if (framed) {
      const cache = readCache();
      if (cache && hubOnTop(cache.origin)) setVars(cache.vars);
      try {
        setMode(win.localStorage.getItem(MODE_KEY));
      } catch (_) {}
    }

    function connect({ standalone = {} } = {}) {
      if (hub) return hub;
      const topics = new Map();
      const activeFns = new Set();
      const statusFns = new Set();
      const handlers = new Map();
      const pending = new Map();
      const tokenWaiters = new Set();
      const themesFns = new Set();
      const settingsFns = new Set();
      const keysFns = new Set();
      const queued = [];
      // Topic → payload: the latest publish before welcome.
      const outbox = new Map();
      let status = 'connecting';
      let origin = null;
      let welcome = null;
      let forward = null;
      let appOrigins = new Set();
      let linkOpened = null;
      let themeBinding = null;
      let lastTheme = null;
      let settings = null;
      let swatchesPainted = false;
      let nextId = 0;

      const waiting = () => status === 'connecting' || status === 'waiting';
      const standaloneFn = (action) => {
        if (status !== 'standalone') return null;
        const fn = (typeof standalone === 'function' ? standalone() : standalone)[action];
        return typeof fn === 'function' ? fn : null;
      };

      // The top window, not the parent: a page nested inside another app's page talks to the hub itself.
      function post(msg) {
        if (origin) win.top.postMessage(msg, origin);
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
        if (isVars(p.vars)) adoptVars(p.vars, origin);
        else if (!waiting()) adoptVars(null);
        lastTheme = p;
        setMode(p.theme);
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

      function setSettings(s) {
        settings = Object.freeze(s && typeof s === 'object' && !Array.isArray(s) ? { ...s } : {});
        for (const fn of settingsFns) fn(settings);
      }

      function onWelcome(m) {
        if (m.protocol !== 1 || welcome) return;
        welcome = {
          actions: strings(m.actions),
          keys: comboMap(m.keys),
          themes: Array.isArray(m.themes) ? m.themes : [],
          voice: Array.isArray(m.voice)
            ? m.voice
                .filter((c) => typeof c?.say === 'string' && typeof c?.help === 'string')
                .map(({ say, help }) => ({ say, help }))
            : [],
        };
        forward = strings(m.forward);
        appOrigins = strings(m.origins);
        setSettings(m.settings);
        setStatus('live');
        if (welcome.themes.length) for (const fn of themesFns) fn(pickerThemes());
        themesFns.clear();
      }

      function onMessage(e) {
        if (!origin || e.source !== win.top || e.origin !== origin) return;
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
          case 'hub:settings':
            if (welcome) setSettings(m.settings);
            return;
          case 'hub:keys':
            if (!welcome) return;
            welcome.keys = comboMap(m.keys);
            forward = strings(m.forward);
            for (const fn of keysFns) fn();
            return;
        }
      }

      function forwards(e) {
        return !!forward && forward.has(comboOf(e));
      }

      // Protocol §5.2. The app page that frames this one, such as a cck pane, claims the presses it acts on.
      let hostKeys = null;
      let hostOrigin = null;

      function onHostMessage(e) {
        const m = e.data;
        if (!framed || e.source !== win.parent || win.parent === win.top) return;
        if (m?.type !== 'hub:hostKeys' || !Array.isArray(m.keys)) return;
        if (!hostKeys) win.parent.postMessage({ type: 'hub:hostReady' }, e.origin);
        hostOrigin = e.origin;
        hostKeys = new Set(m.keys.map((k) => keySigs(k)[0]));
      }

      const keyMessage = (type, e) => ({
        type,
        key: e.key,
        code: e.code,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey,
      });

      function onKeydown(e) {
        if (forwards(e)) {
          e.preventDefault();
          return post(keyMessage('hub:keydown', e));
        }
        if (!hostKeys || e.defaultPrevented || !keySigs(e).some((s) => hostKeys.has(s))) return;
        if (e.target?.closest?.(FIELDS)) return;
        e.preventDefault();
        win.parent.postMessage(keyMessage('hub:hostKey', e), hostOrigin);
      }

      function run(action, params, opts, resolve) {
        const pane = opts?.open === 'pane';
        if (status === 'live') {
          const id = String(++nextId);
          pending.set(id, resolve);
          return post({ type: 'hub:invoke', id, action, params, ...(pane && { open: 'pane' }) });
        }
        const target = standaloneFn(action)?.(params);
        if (!target) return resolve({ ok: false, reason: 'unhandled' });
        if (pane) return resolve({ ok: true, handledBy: 'standalone', url: target });
        win.open(target, '_blank', 'noopener');
        resolve({ ok: true, handledBy: 'standalone' });
      }

      // A link with no target loads in the app's frame, and most sites refuse framing; in the installed
      // window a _blank one opens nothing. Capture on the window runs before a modal's stopPropagation
      // can hide the click. The hub page refuses framing, so a link to it opens outside too.
      function onLinkClick(e) {
        if (!welcome || e.defaultPrevented || (e.type === 'auxclick') !== (e.button === 1)) return;
        const a = e.target?.closest?.('a[href]');
        if (!a || a.hasAttribute?.('download')) return;
        const target = a.getAttribute?.('target') || '';
        if (target && !target.startsWith('_')) return;
        let url;
        try {
          // An SVG <a> has an SVGAnimatedString href, so the attribute is read instead.
          url = new URL(a.getAttribute?.('href') ?? a.href, doc.baseURI);
        } catch (_) {
          return;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
        const inApp = url.origin === win.location.origin || appOrigins.has(url.origin);
        if (inApp && target !== '_blank') return;
        e.preventDefault();
        hub.openExternal(url.href);
        // Apps written before this listener open the same link from their own click handler.
        linkOpened = url.href;
        win.setTimeout(() => {
          linkOpened = null;
        });
      }

      function sameUrl(url, href) {
        try {
          return new URL(String(url), doc.baseURI).href === href;
        } catch (_) {
          return false;
        }
      }

      win.addEventListener('message', onMessage);
      win.addEventListener('message', onHostMessage);
      doc.addEventListener('keydown', onKeydown);
      win.addEventListener('click', onLinkClick, true);
      win.addEventListener('auxclick', onLinkClick, true);

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
            if (framed && cfg?.enabled === true) {
              const hubOrigin = new URL(cfg.url).origin;
              if (hubOnTop(hubOrigin)) origin = hubOrigin;
            }
          } catch (_) {}
          if (!origin) {
            setVars(null);
            setStatus('standalone');
          }
        });

      Promise.all([config, loaded]).then(() => {
        if (!origin) return;
        post({ type: 'hub:hello', protocol: [1], subscribes: [...topics.keys()] });
        mods.connectSender(post);
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
        // The values of the settings in the app's manifest `settings`, as {key: value}. Null before
        // welcome, standalone, or with no welcome: the app then uses its own defaults.
        get settings() {
          return settings;
        },
        // Calls fn with the values at welcome and after each change in the hub's settings. A call after
        // welcome gets the current values at once.
        onSettings(fn) {
          settingsFns.add(fn);
          if (settings) fn(settings);
          return () => settingsFns.delete(fn);
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
        invoke(action, params = {}, opts = {}) {
          return new Promise((resolve) => {
            if (waiting()) queued.push(() => run(action, params, opts, resolve));
            else run(action, params, opts, resolve);
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
        // Calls fn after the user changes the hub's keys, so a page that copied forwardCombos() or
        // shows keyLabel() can read them again.
        onKeys(fn) {
          keysFns.add(fn);
          return () => keysFns.delete(fn);
        },
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
        // The voice commands this app handles, [{say, help}], for its help. [] with voice off, before welcome, or standalone.
        voiceCommands: () => (welcome ? welcome.voice.map((c) => ({ ...c })) : []),
        closeGuard(on) {
          post({ type: 'hub:closeGuard', on: !!on });
        },
        // In the hub's installed PWA window, a framed page's own _blank open does nothing.
        openExternal(url) {
          if (linkOpened !== null && sameUrl(url, linkOpened)) return;
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

    return { connect, comboOf, mod };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createClaudeHub, comboOf };
  else root.ClaudeHub = createClaudeHub(root);
})(typeof window !== 'undefined' ? window : globalThis);

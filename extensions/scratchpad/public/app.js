'use strict';

// The viewer uses most plain keys ([, ], Escape, letters); it leaves these free.
const hub = window.ClaudeHub?.connect({ plainHostKeys: ['\\', '|'] }) ?? null;
const frame = document.getElementById('viewer');
const params = new URLSearchParams(location.search);
// In a Kanban pane the pane is the pad, so the list stays hidden. The hub tab's parent is the top window.
const inPane = window.parent !== window && window.parent !== window.top;
document.body.classList.toggle('pane', inPane);

let current = null;
let viewerOrigin = null;

const api = async (url, body) => {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// #region THEME
// The roles are scratch's names for the hub's palette roles; the hub maps them to these vars in lib/themes.js coreVars.
const THEME_VARS = {
  ember: '--accent',
  emberGlow: '--accent-text',
  emberDim: '--accent-dim',
  field: '--bg-deep',
  surface: '--bg-surface',
  elevated: '--bg-elevated',
  hover: '--bg-hover',
  border: '--border',
  ink1: '--text-primary',
  ink2: '--text-secondary',
  ink3: '--text-tertiary',
  inkMuted: '--text-muted',
};

// The viewer blends palette colors for mermaid by parsing #rrggbb, so an oklch() or rgb() hub theme
// color breaks every diagram. Opaque colors go as hex; a translucent one keeps its own form.
let hexCanvas;
const hexCache = new Map();
function opaqueHex(color) {
  if (hexCache.has(color)) return hexCache.get(color);
  if (!color || !CSS.supports('color', color)) return color;
  hexCanvas ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  hexCanvas.clearRect(0, 0, 1, 1);
  hexCanvas.fillStyle = '#000';
  hexCanvas.fillStyle = color;
  hexCanvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = hexCanvas.getImageData(0, 0, 1, 1).data;
  const hex = a === 255 ? `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}` : color;
  hexCache.set(color, hex);
  return hex;
}

const mode = () => (document.body.classList.contains('light') ? 'light' : 'dark');
const colorTheme = () => document.body.dataset.colorTheme || 'ember';

function themeMessage() {
  const style = getComputedStyle(document.body);
  const palette = {};
  for (const [role, cssVar] of Object.entries(THEME_VARS)) palette[role] = opaqueHex(style.getPropertyValue(cssVar).trim());
  return { __scratchHostTheme: 1, mode: mode(), colorTheme: colorTheme(), palette };
}

let sentTheme = '';
function postTheme() {
  if (!viewerOrigin || !frame.contentWindow) return;
  const msg = themeMessage();
  const key = JSON.stringify(msg);
  if (key === sentTheme) return;
  sentTheme = key;
  frame.contentWindow.postMessage(msg, viewerOrigin);
}
// The viewer listens from a script at the end of its body, so a palette sent before load is lost.
frame.addEventListener('load', () => {
  sentTheme = '';
  postTheme();
});

if (!hub?.inHub && matchMedia('(prefers-color-scheme: light)').matches) document.body.classList.add('light');
hub?.bindTheme({
  get: () => ({ theme: mode(), colorTheme: colorTheme() }),
  set: ({ theme, colorTheme: id }) => {
    document.body.classList.toggle('light', theme === 'light');
    // themes.css selects ember by the missing attribute.
    if (id && id !== 'ember') document.body.dataset.colorTheme = id;
    else delete document.body.dataset.colorTheme;
  },
});
let themeQueued = false;
new MutationObserver(() => {
  if (themeQueued) return;
  themeQueued = true;
  requestAnimationFrame(() => {
    themeQueued = false;
    postTheme();
  });
}).observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-color-theme'] });
// #endregion

// #region KEYS
// The viewer's bridge hands back the presses named here; replayed on this page, the SDK sends each to
// the hub or, in a pane, to Kanban around it.
let hostClaims = [];

function sendKeys() {
  if (!viewerOrigin || !frame.contentWindow || !window.ClaudeHubKeys) return;
  const sigs = hostClaims.map((k) => ClaudeHubKeys.keySigs(k)[0]).filter(Boolean);
  frame.contentWindow.postMessage({ type: 'scratchpads:keys', combos: hub?.forwardCombos() ?? [], sigs }, viewerOrigin);
}

function replayKey(m) {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: m.key,
      code: m.code,
      ctrlKey: !!m.ctrl,
      altKey: !!m.alt,
      shiftKey: !!m.shift,
      metaKey: !!m.meta,
      bubbles: true,
      cancelable: true,
    }),
  );
}

window.addEventListener('message', (e) => {
  const type = e.data?.type;
  if (e.source === window.parent && type === 'hub:hostKeys' && Array.isArray(e.data.keys)) {
    hostClaims = e.data.keys;
    sendKeys();
    return;
  }
  if (e.source !== frame.contentWindow || e.origin !== viewerOrigin) return;
  if (type === 'scratchpads:ready') sendKeys();
  else if (type === 'scratchpads:key') replayKey(e.data);
});
hub?.onKeys(sendKeys);
hub?.onStatus(sendKeys);
// #endregion

// #region PADS
function showError(message) {
  const box = document.getElementById('error');
  box.textContent = message;
  box.hidden = false;
  document.getElementById('empty').hidden = true;
  frame.hidden = true;
}

async function openPad(dir, { project = '', session = '' } = {}) {
  document.getElementById('error').hidden = true;
  try {
    const { url, key } = await api('/api/open', { path: dir, project, session });
    current = key;
    const src = new URL(url);
    src.searchParams.set('hostMode', mode());
    src.searchParams.set('hostTheme', colorTheme());
    viewerOrigin = src.origin;
    frame.src = src.href;
    frame.hidden = false;
    document.getElementById('empty').hidden = true;
  } catch (err) {
    showError(err.message);
  }
  refresh();
}

function padRow(p) {
  const b = el('button', `pad${p.key === current ? ' current' : ''}`);
  b.title = p.dir;
  b.append(el('span', `dot${p.running ? '' : ' off'}`), el('span', 'name', p.name), el('span', 'when', ago(p.openedAt)));
  b.addEventListener('click', () => {
    history.replaceState(null, '', `?pad=${encodeURIComponent(p.dir)}`);
    openPad(p.dir);
  });
  return b;
}

function render({ groups, viewers, scratch }) {
  const nav = document.getElementById('groups');
  nav.replaceChildren();
  if (!scratch) nav.append(el('p', 'empty-list', 'The scratch CLI is not on PATH, so pads cannot open.'));
  if (!groups.length) nav.append(el('p', 'empty-list', 'Pads you open show up here, grouped by project.'));
  for (const g of groups) {
    const d = el('details', 'group');
    d.open = true;
    const s = el('summary', null, g.label);
    if (g.project) s.title = g.project;
    const ul = el('ul');
    for (const p of g.pads) {
      const li = el('li');
      li.append(padRow(p));
      ul.append(li);
    }
    d.append(s, ul);
    nav.append(d);
  }
  const running = document.getElementById('running');
  running.replaceChildren();
  document.getElementById('running-section').hidden = !viewers.length;
  for (const v of viewers) {
    const li = el('li');
    const state = v.streams ? `${v.streams} open` : `idle ${ago(v.idleSince)}`;
    const restart = el('button', 'mini', 'Restart');
    restart.addEventListener('click', async () => {
      await api('/api/viewers/restart', { path: v.dir }).catch((err) => showError(err.message));
      if (v.key === current) openPad(v.dir);
      else refresh();
    });
    const stop = el('button', 'mini', 'Stop');
    stop.addEventListener('click', async () => {
      await api('/api/viewers/stop', { path: v.dir }).catch(() => {});
      refresh();
    });
    li.append(el('span', 'name', v.name),el('span', 'state', state), restart, stop);
    running.append(li);
  }
}

async function refresh() {
  if (inPane) return;
  try {
    render(await api('/api/pads'));
  } catch {}
}
// #endregion

const pad = params.get('pad');
if (pad) openPad(pad, { project: params.get('project') || '', session: params.get('session') || '' });
else refresh();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
hub?.onActive((active) => {
  if (active) refresh();
});

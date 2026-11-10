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
  refresh();
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
const LIST_KEY = { key: '\\', code: 'Backslash' };

function sendKeys() {
  if (!viewerOrigin || !frame.contentWindow || !window.ClaudeHubKeys) return;
  const sigs = hostClaims.map((k) => ClaudeHubKeys.keySigs(k)[0]).filter(Boolean);
  if (!inPane) sigs.push(...ClaudeHubKeys.keySigs(LIST_KEY));
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

async function openPad(dir, { project = '', session = '', remember = true, onError = null } = {}) {
  document.getElementById('error').hidden = true;
  let ok = false;
  try {
    document.body.classList.add('has-pad');
    const { url, key } = await api('/api/open', { path: dir, project, session, remember });
    current = key;
    const src = new URL(url);
    src.searchParams.set('hostMode', mode());
    src.searchParams.set('hostTheme', colorTheme());
    viewerOrigin = src.origin;
    frame.src = src.href;
    frame.hidden = false;
    document.getElementById('empty').hidden = true;
    ok = true;
  } catch (err) {
    if (!onError) showError(err.message);
    else {
      document.body.classList.toggle('has-pad', !frame.hidden);
      onError(err.message);
    }
  }
  refresh();
  return ok;
}

function openListed(p) {
  history.replaceState(null, '', `?pad=${encodeURIComponent(p.dir)}`);
  openPad(p.dir, { remember: false });
}

const ICONS = {
  restart: 'M13 8a5 5 0 1 1-1.46-3.54M13 2.5v2.5h-2.5',
  stop: 'M5 5h6v6H5z',
  sidebar: 'M2.5 3.5h11v9h-11zM6.5 3.5v9',
  home: 'M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5',
  forget: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  resume: 'M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0',
};

function svgIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function iconButton(name, label, onClick) {
  const b = el('button', 'icon');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(svgIcon(name));
  b.addEventListener('click', onClick);
  return b;
}

function viewerState(v) {
  if (!v) return ['stopped', 'Viewer stopped'];
  if (v.streams) return ['live', `Viewer running, ${v.streams} open`];
  return ['idle', `Viewer idle for ${ago(v.idleSince)}`];
}

function padRow(p, v, inHistory = true) {
  const li = el('li', `pad${p.key === current ? ' current' : ''}`);
  const [state, stateText] = viewerState(v);
  const open = el('button', 'open');
  open.type = 'button';
  open.title = `${p.dir}\n${stateText}`;
  open.append(el('span', `dot ${state}`), el('span', 'name', p.name), el('span', 'when', p.openedAt ? ago(p.openedAt) : ''));
  open.addEventListener('click', () => {
    if (p.key === current && !frame.hidden) return document.body.classList.add('has-pad');
    openListed(p);
  });
  li.append(open);
  const actions = el('span', 'actions');
  if (v) {
    actions.append(
      iconButton('restart', 'Restart viewer', async () => {
        await api('/api/viewers/restart', { path: v.dir }).catch((err) => showError(err.message));
        if (v.key === current) openPad(v.dir, { remember: false });
        else refresh();
      }),
      iconButton('stop', 'Stop viewer', async () => {
        await api('/api/viewers/stop', { path: v.dir }).catch(() => {});
        refresh();
      }),
    );
  }
  if (inHistory) {
    actions.append(
      iconButton('forget', 'Forget (remove from the list; the files stay)', async () => {
        await api('/api/forget', { path: p.dir }).catch(() => {});
        refresh();
      }),
    );
  }
  if (actions.childElementCount) li.append(actions);
  return li;
}

function groupEl(label, title, rows) {
  const d = el('details', 'group');
  d.open = true;
  const s = el('summary');
  if (title) s.title = title;
  s.append(el('span', 'label', label), el('span', 'n', String(rows.length)));
  const ul = el('ul');
  ul.append(...rows);
  d.append(s, ul);
  return d;
}

function render({ groups, viewers, scratch }) {
  const nav = document.getElementById('groups');
  nav.replaceChildren();
  if (!scratch) nav.append(el('p', 'empty-list', 'The scratch CLI is not on PATH, so pads cannot open.'));
  if (!groups.length && !viewers.length) nav.append(el('p', 'empty-list', 'Pads you open show up here, grouped by project.'));
  const byKey = new Map(viewers.map((v) => [v.key, v]));
  const listed = new Set();
  for (const g of groups) {
    const rows = g.pads.map((p) => {
      listed.add(p.key);
      return padRow(p, byKey.get(p.key));
    });
    nav.append(groupEl(g.label, g.project, rows));
  }
  const others = viewers.filter((v) => !listed.has(v.key));
  if (others.length) nav.append(groupEl('Other running', null, others.map((v) => padRow(v, v, false))));
  document.getElementById('count').textContent = viewers.length ? `${viewers.length} running` : '';
  renderHome({ groups, viewers, scratch }, byKey);
}

async function refresh() {
  if (inPane) return;
  try {
    render(await api('/api/pads'));
  } catch {}
}
// #endregion

// #region HOME
const RECENT = 6;

function padCard(p, v, scratch) {
  const [state, stateText] = viewerState(v);
  const b = el('button', 'card');
  b.type = 'button';
  b.title = `${p.dir}\n${stateText}`;
  b.disabled = !scratch;
  const top = el('span', 'card-top');
  top.append(el('span', `dot ${state}`), el('span', 'name', p.name));
  const meta = el('span', 'card-meta');
  meta.append(el('span', 'label', p.label), el('span', 'when', p.openedAt ? ago(p.openedAt) : ''));
  b.append(top, meta);
  b.addEventListener('click', () => openListed(p));
  const li = el('li');
  li.append(b);
  return li;
}

function actionButton(icon, label, detail, onClick) {
  const b = el('button', 'action');
  b.type = 'button';
  b.append(svgIcon(icon), el('span', 'action-label', label));
  if (detail) b.append(el('span', 'action-detail', detail));
  b.addEventListener('click', onClick);
  return b;
}

function renderHome({ groups, viewers, scratch }, byKey) {
  const pads = groups
    .flatMap((g) => g.pads.map((p) => ({ ...p, label: g.label })))
    .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  const has = pads.length > 0;
  document.getElementById('home-title').textContent = has ? 'No pad open' : 'Welcome to Scratchpads';
  document.getElementById('home-sub').textContent = has
    ? 'Pick up where you left off, or open a pad by its path.'
    : 'A scratchpad is a folder of notes with a scratchpad.json. Pads you open show up here and in the list.';
  document.getElementById('no-scratch').hidden = scratch;
  document.getElementById('recent').hidden = !has;
  document.getElementById('cards').replaceChildren(...pads.slice(0, RECENT).map((p) => padCard(p, byKey.get(p.key), scratch)));

  const buttons = document.getElementById('action-buttons');
  buttons.replaceChildren();
  if (scratch && has) buttons.append(actionButton('resume', 'Open last pad', pads[0].name, () => openListed(pads[0])));
  const idle = viewers.filter((v) => !v.streams);
  if (idle.length) {
    const label = idle.length === 1 ? 'Stop the idle viewer' : `Stop ${idle.length} idle viewers`;
    buttons.append(
      actionButton('stop', label, 'No page shows them', async () => {
        await Promise.all(idle.map((v) => api('/api/viewers/stop', { path: v.dir }).catch(() => {})));
        refresh();
      }),
    );
  }
  buttons.hidden = !buttons.childElementCount;
  document.getElementById('open-form').hidden = !scratch;
  document.getElementById('actions').hidden = !scratch && !idle.length;
}

document.getElementById('open-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('open-path');
  const error = document.getElementById('open-error');
  // Windows "Copy as path" wraps the path in quotes.
  const dir = input.value.trim().replace(/^"(.*)"$/, '$1');
  error.hidden = true;
  if (!dir) return input.focus();
  const ok = await openPad(dir, {
    onError: (message) => {
      error.textContent = message;
      error.hidden = false;
    },
  });
  if (!ok) return;
  history.replaceState(null, '', `?pad=${encodeURIComponent(dir)}`);
  input.value = '';
});
// #endregion

function goHome() {
  current = null;
  viewerOrigin = null;
  frame.hidden = true;
  // Unloading the page closes its live-reload stream, so the viewer can go idle.
  frame.src = 'about:blank';
  document.getElementById('error').hidden = true;
  document.getElementById('empty').hidden = false;
  document.body.classList.remove('has-pad');
  history.replaceState(null, '', location.pathname);
  refresh();
  // The viewer's proxy sees the stream close a moment after the unload.
  setTimeout(refresh, 600);
}

document.getElementById('back').addEventListener('click', () => {
  document.body.classList.remove('has-pad');
  refresh();
});

// #region LIST_TOGGLE
const narrow = matchMedia('(max-width: 720px)');
const COLLAPSED = 'scratchpads.listCollapsed';

function setCollapsed(on) {
  document.body.classList.toggle('list-collapsed', on);
  listToggle.title = on ? 'Show list (\\)' : 'Hide list (\\)';
  try {
    localStorage.setItem(COLLAPSED, on ? '1' : '');
  } catch {}
}

function toggleList() {
  if (inPane) return false;
  if (!narrow.matches) setCollapsed(!document.body.classList.contains('list-collapsed'));
  else if (frame.hidden) return false;
  else if (document.body.classList.toggle('has-pad')) frame.focus();
  else refresh();
  return true;
}

const listToggle = iconButton('sidebar', '', toggleList);
listToggle.id = 'list-toggle';
listToggle.setAttribute('aria-label', 'Toggle list');
const homeButton = iconButton('home', 'Home', goHome);
homeButton.id = 'home-button';
document.querySelector('#list > header').append(homeButton, listToggle);
let collapsed = false;
try {
  collapsed = localStorage.getItem(COLLAPSED) === '1';
} catch {}
setCollapsed(collapsed);

document.addEventListener('keydown', (e) => {
  if (e.key !== LIST_KEY.key || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (toggleList()) e.preventDefault();
});
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

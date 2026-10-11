'use strict';

// #region STATE
const $ = (id) => document.getElementById(id);
const main = $('main');
const helpModal = $('helpModal');

const VIEWS = [
  { id: 'summary', label: 'Summary', question: 'Is the swarm on track, and does any worker need me?' },
  { id: 'queue', label: 'Queue', question: 'Who works on what, for how long, and where did workers collide?' },
  { id: 'timeline', label: 'Timeline', question: 'What did each worker do over time, and who went quiet?' },
  { id: 'knowledge', label: 'Knowledge', question: 'What did the workers find out, and what did they hand off?' },
  {
    id: 'changes',
    label: 'Changes',
    question: 'Which files changed, and who took whose work?',
  },
  { id: 'log', label: 'Log', question: 'What exactly is in the event log, in order?' },
];

const state = {
  swarm: new URLSearchParams(location.search).get('swarm'),
  swarms: [],
  pinned: false,
  root: null,
  model: null,
  view: 'summary',
  scope: null,
  diff: null,
  focus: null,
  log: null,
};
// #endregion STATE

// #region FORMAT
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const short = (id) => String(id ?? '').slice(0, 7);
const TIME = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const clock = (t) => TIME.format(new Date(t));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function dur(ms) {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast error';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}
// #endregion FORMAT

// #region THEME
const COLOR_THEMES = [
  ['ember', 'Ember'],
  ['gruvbox', 'Gruvbox'],
  ['catppuccin', 'Catppuccin'],
  ['tokyo-night', 'Tokyo Night'],
  ['solarized', 'Solarized'],
  ['dracula', 'Dracula'],
  ['nord', 'Nord'],
  ['rose-pine', 'Rosé Pine'],
  ['everforest', 'Everforest'],
  ['kanagawa', 'Kanagawa'],
  ['one-dark', 'One Dark'],
  ['night-owl', 'Night Owl'],
  ['monokai', 'Monokai Pro'],
  ['github', 'GitHub'],
  ['ayu', 'Ayu'],
  ['vitesse', 'Vitesse'],
  ['synthwave', "Synthwave '84"],
];

function store(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setColorTheme(id) {
  if (!id || id === 'ember') delete document.body.dataset.colorTheme;
  else document.body.dataset.colorTheme = id;
  store('color-theme', id && id !== 'ember' ? id : null);
  syncThemeMenu();
}

function buildThemeMenu(themes = COLOR_THEMES) {
  $('themeMenu').innerHTML = themes
    .map(
      ([
        id,
        label,
      ]) => `<button type="button" role="menuitemradio" class="theme-menu-item theme-swatch-${esc(id)}" data-color-theme-id="${esc(id)}">
        <span class="theme-swatch theme-swatch-${esc(id)}"><i class="sw-bg"></i><i class="sw-accent"></i><i class="sw-ink"></i></span>${esc(label)}
      </button>`,
    )
    .join('');
  syncThemeMenu();
}

function syncThemeMenu() {
  const cur = document.body.dataset.colorTheme || 'ember';
  for (const el of document.querySelectorAll('.theme-menu-item')) {
    const on = el.dataset.colorThemeId === cur;
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', String(on));
  }
}

function toggleThemeMenu(force) {
  const open = $('themeMenu').classList.toggle('open', force);
  $('themePickerBtn').setAttribute('aria-expanded', String(open));
}

function toggleTheme() {
  const light = document.body.classList.toggle('light');
  store('theme', light ? 'light' : 'dark');
}

const savedTheme = stored('theme') ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
if (savedTheme === 'light') document.body.classList.add('light');
if (stored('color-theme')) document.body.dataset.colorTheme = stored('color-theme');
buildThemeMenu();
// #endregion THEME

// #region DATA
let stream = null;
let shown = false;
let logBusy = false;
let logAgain = false;
let logGen = 0;

const api = (p, params = {}) => {
  const q = new URLSearchParams(params);
  if (state.swarm) q.set('swarm', state.swarm);
  const s = String(q);
  return s ? `${p}?${s}` : p;
};

// These views draw nothing from the clock, so a resend with no new event changes nothing in them.
const CLOCKLESS = new Set(['knowledge', 'changes', 'log']);

function connect() {
  if (stream) return;
  stream = new EventSource(api('/api/stream'));
  stream.addEventListener('swarm', (e) => {
    const next = JSON.parse(e.data);
    const moved = next.swarm.seq !== state.model?.swarm.seq;
    state.model = next;
    $('live').classList.add('on');
    if (moved && state.log) loadLog();
    if (moved || !CLOCKLESS.has(state.view)) render();
  });
  stream.addEventListener('failure', (e) => toast(`The swarm log could not be read: ${JSON.parse(e.data)}`));
  stream.addEventListener('missing', async (e) => {
    disconnect();
    toast(JSON.parse(e.data));
    try {
      const r = await (await fetch('/api/swarms')).json();
      if (r.selected) pickSwarm(r.selected);
    } catch {}
  });
  stream.onerror = () => $('live').classList.remove('on');
}

function disconnect() {
  stream?.close();
  stream = null;
  $('live').classList.remove('on');
}

// The server checks the log only while a page listens, so a page that is not on screen stops listening.
function show(on) {
  if (on === shown) return;
  shown = on;
  if (on) connect();
  else disconnect();
}

async function refresh() {
  const btn = $('refreshBtn');
  btn.classList.add('loading');
  try {
    const r = await fetch(api('/api/swarm'));
    if (!r.ok) throw new Error((await r.json()).error);
    state.model = await r.json();
    resetLog();
    await loadSwarms();
    render();
  } catch (err) {
    toast(`Refresh failed: ${err.message}`);
  } finally {
    btn.classList.remove('loading');
  }
}

function resetLog() {
  state.log = null;
  logGen++;
}

// Only the rows after the last one held are fetched. A call during a fetch runs once it ends.
async function loadLog() {
  if (logBusy) {
    logAgain = true;
    return;
  }
  logBusy = true;
  const gen = logGen;
  try {
    const r = await fetch(api('/api/log', { since: state.log?.at(-1)?.seq ?? 0 }));
    const rows = await r.json();
    if (!r.ok) throw new Error(rows.error);
    if (gen === logGen) {
      state.log = (state.log ?? []).concat(rows);
      if (state.view === 'log') render();
    }
  } catch (err) {
    toast(`The log did not load: ${err.message}`);
  } finally {
    logBusy = false;
    if (logAgain) {
      logAgain = false;
      loadLog();
    }
  }
}

async function loadSwarms() {
  try {
    const r = await (await fetch('/api/swarms')).json();
    state.swarms = r.swarms;
    state.pinned = r.pinned;
    state.root = r.root;
    state.swarm ??= r.pinned ? null : r.selected;
    renderPicker();
  } catch (err) {
    toast(`The swarm list did not load: ${err.message}`);
  }
}

function pickSwarm(id) {
  if (!id || id === state.swarm) return;
  Object.assign(state, { swarm: id, model: null, diff: null, scope: null, focus: null });
  resetLog();
  const u = new URL(location.href);
  u.searchParams.set('swarm', id);
  history.replaceState(null, '', u);
  disconnect();
  if (shown) connect();
  render();
}

const diffOpen = (pub, path) => state.diff?.pub === pub && state.diff.path === path;

function toggleDiff(pub, path) {
  if (!diffOpen(pub, path)) return openDiff(pub, path);
  state.diff = null;
  render();
}

async function openDiff(pub, path) {
  if (diffOpen(pub, path)) return;
  const want = { pub, path, text: null };
  state.diff = want;
  render();
  try {
    const r = await fetch(api('/api/diff', { publication: pub, path }));
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    want.text = body.binary ? 'Binary file; no text diff.' : body.diff || 'No change in text.';
  } catch (err) {
    want.text = `The diff did not load: ${err.message}`;
  }
  if (state.diff === want) render();
}
// #endregion DATA

// #region HUB_INTEGRATION
const hub = ClaudeHub.connect();

(function initHubTheme() {
  const getTheme = () => (document.body.classList.contains('light') ? 'light' : 'dark');
  const getColorTheme = () => document.body.dataset.colorTheme || 'ember';
  const report = hub.bindTheme({
    get: () => ({ theme: getTheme(), colorTheme: getColorTheme() }),
    set: ({ theme, colorTheme }) => {
      if (colorTheme !== getColorTheme()) setColorTheme(colorTheme);
      if (theme !== getTheme()) toggleTheme();
    },
  });
  new MutationObserver(report).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-color-theme'],
  });
})();

hub.onThemes((themes) => buildThemeMenu(themes.map((t) => [t.id, t.label])));

hub.handle('swarm.open', ({ swarm }) => loadSwarms().then(() => pickSwarm(swarm)));

let hubActive = true;
const showIfSeen = () => show(hubActive && document.visibilityState === 'visible');

hub.onActive((active) => {
  hubActive = active;
  showIfSeen();
});

document.addEventListener('visibilitychange', showIfSeen);

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[target="_blank"]');
  if (!link || !hub.inHub) return;
  e.preventDefault();
  hub.openExternal(link.href);
});
// #endregion HUB_INTEGRATION

// #region RENDER
let workerIndex = { model: null, map: new Map() };
function wc(name) {
  const m = state.model;
  if (workerIndex.model !== m) workerIndex = { model: m, map: new Map((m?.workers ?? []).map((w, i) => [w.name, i])) };
  const i = workerIndex.map.get(name);
  return i == null ? 'var(--text-muted)' : `var(--w${(i % 8) + 1})`;
}
const who = (name) => `<span class="who" style="--wc:${wc(name)}">${esc(name)}</span>`;

const EXT = 'js|mjs|cjs|ts|tsx|jsx|json|md|css|scss|html|py|cs|go|rs|java|rb|sh|ps1|txt|yml|yaml|toml|sql|xml|csv|lock';
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let marks = { key: null };

// The regex and the cache depend on the worker names and the publications, so they are rebuilt
// only when those change. Matching runs on the raw text and every piece is escaped on its own, so
// no match can start inside an HTML entity.
function markup() {
  const m = state.model;
  const names = (m?.workers ?? []).map((w) => w.name);
  const key = `${m?.swarm.listId}|${names.join('|')}#${m?.publications.length ?? 0}`;
  if (marks.key === key) return marks;
  const fileIn = new Map();
  for (const p of m?.publications ?? []) for (const f of p.files) fileIn.set(f.path, p.id);
  const whoRe = names.length ? `(?<who>\\b(?:${names.map(reEsc).join('|')})\\b)|` : '';
  const re = new RegExp(
    `${whoRe}\`(?<code>[^\`\\n]+)\`|(?<pub>\\b(?:publication|pub) #?(?<pubId>\\d+))|(?<task>(?:\\btask[: ]#?|#)(?<taskId>\\d+)\\b)|(?<path>\\b(?:[\\w.-]+\\/)+[\\w.-]*[\\w/]|\\b[\\w-]+\\.(?:${EXT})\\b)`,
    'g',
  );
  marks = { key, re, fileIn, cache: new Map(), rows: new Map() };
  return marks;
}

function token(g, whole, fileIn) {
  if (g.who) return who(g.who);
  if (g.code) return `<code>${esc(g.code)}</code>`;
  if (g.pub) return `<a class="ref" href="#" data-pub="${g.pubId}">${esc(whole)}</a>`;
  if (g.task) return `<a class="ref" href="#" data-task="${g.taskId}">${esc(whole)}</a>`;
  const pub = fileIn.get(g.path);
  return pub
    ? `<a class="ref path" href="#" data-diff="${pub}" data-path="${esc(g.path)}" title="Show the diff in publication ${pub}">${esc(g.path)}</a>`
    : `<code class="path">${esc(g.path)}</code>`;
}

function hl(text) {
  if (!text) return '';
  const s = String(text);
  const m = markup();
  const hit = m.cache.get(s);
  if (hit != null) return hit;
  let out = '';
  let last = 0;
  for (const x of s.matchAll(m.re)) {
    out += esc(s.slice(last, x.index)) + token(x.groups, x[0], m.fileIn);
    last = x.index + x[0].length;
  }
  out += esc(s.slice(last));
  m.cache.set(s, out);
  return out;
}

const focused = (id) => (state.focus === id ? ' focused' : '');

function reveal(view, id) {
  setView(view, id);
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

const HEALTH = {
  working: ['ok', 'working'],
  waiting: ['info', 'waiting'],
  blocked: ['warn', 'blocked'],
  idle: ['', 'idle'],
  finished: ['ok', 'finished'],
  quiet: ['warn', 'quiet'],
  stuck: ['bad', 'stuck on a claim'],
  stopped: ['', 'stopped'],
  'not started': ['', 'not started'],
};
const healthChip = (h) => `<span class="chip ${HEALTH[h]?.[0] ?? ''}">${esc(HEALTH[h]?.[1] ?? h)}</span>`;
const turnChip = (running) =>
  running == null
    ? ''
    : running
      ? ' <span class="chip ok" title="Its turn runs now">running</span>'
      : ' <span class="chip" title="Between turns; the store wakes it when there is work">asleep</span>';
const WAKE_REASONS = { request: 'a new request', ready: 'work is ready', no_producer: 'no running worker can produce its dependency' };

function renderPicker() {
  const pick = $('swarmPick');
  const many = !state.pinned && state.swarms.length > 1;
  pick.hidden = !many;
  $('swarmName').hidden = many;
  if (!many) return;
  pick.innerHTML = state.swarms
    .map(
      (s) =>
        `<option value="${esc(s.id)}"${s.id === state.swarm ? ' selected' : ''}>${esc(s.id)}${s.state === 'running' ? '' : ` (${esc(s.state)})`}</option>`,
    )
    .join('');
  pick.title = state.swarms.find((s) => s.id === state.swarm)?.goal ?? '';
}

function renderTopbar() {
  const s = state.model?.swarm;
  $('swarmName').textContent = s?.listId ?? 'No swarm';
  $('swarmBox').title = s?.goal ?? '';
  const el = $('swarmState');
  if (!s) {
    el.textContent = '';
    return;
  }
  const [kind, text] = state.model.progress.goalReached
    ? ['ok', 'goal reached']
    : s.state === 'running'
      ? ['ok', 'running']
      : s.outcome
        ? ['', `ended · ${s.outcome.outcome}`]
        : [s.state === 'ended' ? '' : 'warn', s.state];
  el.className = `state ${kind}`;
  el.textContent = text;
}

function setView(id, focus = null) {
  if (!VIEWS.some((v) => v.id === id)) return;
  state.view = id;
  state.focus = focus;
  store('view', id);
  const u = new URL(location.href);
  u.searchParams.set('view', id);
  history.replaceState(null, '', u);
  render();
}

function render() {
  renderTopbar();
  const tabs = `<div class="view-tabs" role="tablist">${VIEWS.map(
    (v) =>
      `<button class="view-tab${v.id === state.view ? ' on' : ''}" role="tab" aria-selected="${v.id === state.view}" data-view="${v.id}">${v.label}</button>`,
  ).join('')}</div>`;
  if (!state.model) {
    main.innerHTML = `${tabs}<p class="loading">Reading the swarm log…</p>`;
    return;
  }
  if (!state.model.swarm.listId) {
    main.innerHTML = `${tabs}<p class="loading">No swarm yet. Start one with /swarm in a Claude Code session; it shows up here.${state.root ? ` Swarms are read from <code>${esc(state.root)}</code>.` : ''}</p>`;
    return;
  }
  const v = VIEWS.find((x) => x.id === state.view);
  const scroll = main.scrollTop;
  main.innerHTML = `${tabs}<p class="question">${esc(v.question)}</p><div class="view">${RENDER[state.view]()}</div>`;
  main.scrollTop = scroll;
  if (state.view === 'log' && !state.log) loadLog();
}

function summaryView() {
  const { swarm: s, progress: p, workers, findings } = state.model;
  const pct = (n) => (p.total ? (n / p.total) * 100 : 0);
  const races = state.model.races;
  const alerts = [];
  for (const w of workers) {
    if (w.health === 'stuck')
      alerts.push([
        'bad',
        'stuck',
        `${who(w.name)} holds #${w.holding.id} and has been silent for ${dur(w.silence)}. No peer can take the task until it is released.`,
      ]);
    if (w.health === 'quiet')
      alerts.push(['warn', 'check', `${who(w.name)} went quiet: no event for ${dur(w.silence)}, last at ${clock(w.lastT)}.`]);
    if (w.health === 'blocked')
      alerts.push(['warn', 'check', `${who(w.name)} is blocked: ${hl(w.status.summary) || 'no reason given'}`]);
    if (w.health === 'waiting')
      alerts.push(['info', 'info', `${who(w.name)} waits for ${hl(w.status.dependency)}`]);
    if (w.status?.woken === 'no_producer' && w.health !== 'stopped' && w.health !== 'finished')
      alerts.push(['warn', 'stall', `${who(w.name)} was woken because no running worker can produce ${hl(w.status.wokeFor) || 'its dependency'}.`]);
  }
  if (races.length)
    alerts.push([
      'info',
      'info',
      `${plural(races.length, 'lost claim race')} (${[...new Set(races.map((r) => r.who))].map(esc).join(', ')})`,
    ]);
  const stat = (n, label, bad) =>
    `<div class="stat"><div class="label">${label}</div><div class="value${bad && n ? ' bad' : ''}">${n}</div></div>`;

  return `<div class="stack">
  <div class="card">
    <h1 class="goal">${esc(s.goal ?? 'No goal recorded')}</h1>
    <div class="facts">
      <span>base <code>${esc(short(s.base))}</code></span>
      <span>started ${clock(s.startedAt)}</span>
      <span>${s.endedAt ? `ran ${dur(s.endedAt - s.startedAt)}` : `running for ${dur(s.ref - s.startedAt)}`}</span>
      <span>${plural(s.events, 'event')}</span>
      ${s.revision > 1 ? `<span>request revision ${s.revision}</span>` : ''}
    </div>
    ${s.outcome ? `<p class="outcome"><span class="chip ${s.outcome.outcome === 'complete' ? 'ok' : 'warn'}">${esc(s.outcome.outcome)}</span> ${hl(s.outcome.summary)}</p>` : ''}
    <div class="progress" title="${p.done} done, ${p.claimed} claimed, ${p.open} open">
      <span class="done" style="width:${pct(p.done)}%"></span><span class="claimed" style="width:${pct(p.claimed)}%"></span>
    </div>
    <div class="sub">${p.done} of ${p.total} tasks done${p.closed ? ` (${p.closed} closed)` : ''} · ${p.claimed} claimed · ${p.open} open</div>
  </div>
  ${
    state.model.requests.length
      ? `<div class="card"><div class="section-title"><span>Request changes</span><span>${state.model.requests.length}</span></div>${state.model.requests
          .map((r) => `<div class="note"><div><div class="text">${hl(r.text)}</div><div class="sub">revision ${r.revision} · ${clock(r.t)}</div></div></div>`)
          .join('')}</div>`
      : ''
  }
  <div class="grid cols-2">
    <div class="card">
      <div class="section-title"><span>Workers</span><span>${workers.length}</span></div>
      ${workers
        .map(
          (w) => `<div class="worker-row">
          ${who(w.name)}
          <span>${healthChip(w.health)}${w.health === 'stopped' ? '' : turnChip(w.running)}</span>
          <span class="sub">${w.lastT ? `seen ${dur(w.silence)} ago` : ''}</span>
          <div class="doing">${w.holding ? `#${w.holding.id} ${esc(w.holding.subject)} <span class="muted">· ${dur(s.ref - w.holding.since)}</span>` : (hl(w.status?.summary) || '—')}</div>
        </div>`,
        )
        .join('')}
    </div>
    <div class="card">
      <div class="section-title"><span>Needs a look</span><span>${alerts.length}</span></div>
      ${
        alerts.length
          ? `<ul class="alerts">${alerts.map(([k, label, t]) => `<li><span class="chip ${k}">${label}</span><span>${t}</span></li>`).join('')}</ul>`
          : '<p class="empty">Nothing needs a look.</p>'
      }
    </div>
  </div>
  <div class="stats">
    ${stat(findings.length, 'Findings')}
    ${stat(state.model.publications.length, 'Publications')}
    ${stat(state.model.applies.length, 'Applies')}
    ${stat(state.model.releases.length, 'Releases')}
    ${stat(races.length, 'Lost races')}
  </div>
  </div>`;
}

function queueView() {
  const { tasks, swarm: s } = state.model;
  const col = (st, title) => {
    const list = tasks.filter((t) => t.state === st);
    return `<div class="card"><div class="section-title"><span>${title}</span><span>${list.length}</span></div>${list.length ? list.map((t) => taskCard(t, s)).join('') : '<p class="empty">None.</p>'}</div>`;
  };
  return `<div class="grid cols-3">${col('open', 'Open')}${col('claimed', 'Claimed')}${col('done', 'Done')}</div>`;
}

function taskCard(t, s) {
  const meta = [`#${t.id}`];
  if (t.owner) meta.push(who(t.owner));
  if (t.state === 'open') meta.push(`waiting ${dur(s.ref - t.createdAt)}`);
  if (t.state === 'claimed') meta.push(`held ${dur(s.ref - t.claimedAt)}`);
  if (t.closed) meta.push(`<span class="chip">closed</span> ${clock(t.doneAt)}`);
  else if (t.state === 'done') meta.push(`took ${dur(t.doneAt - t.claimedAt)}`, `done ${clock(t.doneAt)}`);
  meta.push(`<span class="muted">added by ${esc(t.createdBy)}</span>`);
  const races = t.races.map(
    (r) =>
      `<span class="chip warn" title="${esc(r.owner ? `${r.owner} held it` : `task was ${r.taskState}`)}">${esc(r.who)} lost ${clock(r.t)}</span>`,
  );
  return `<div class="task${t.closed ? ' closed' : ''}${focused(`task-${t.id}`)}" id="task-${t.id}">
    <div class="t">${hl(t.subject)}</div>
    ${t.detail ? `<div class="detail">${hl(t.detail)}</div>` : ''}
    <div class="meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
    ${t.summary ? `<div class="summary">${hl(t.summary)}</div>` : ''}
    ${t.state !== 'done' && t.handoff ? `<div class="summary"><span class="muted">handoff:</span> ${hl(t.handoff)}</div>` : ''}
    ${races.length ? `<div class="races">${races.join('')}</div>` : ''}
  </div>`;
}

function timelineView() {
  const { swarm: s, workers, timeline, tasks } = state.model;
  const css = getComputedStyle(main);
  const room = main.clientWidth - 2 * Number.parseFloat(css.paddingLeft);
  const width = Math.min(Number.parseFloat(css.getPropertyValue('--content-max')), room) - 26;
  const narrow = width < 560;
  const W = Math.max(300, width);
  const left = narrow ? 8 : 96;
  const right = 12;
  const laneH = narrow ? 44 : 40;
  const top = 22;
  const labelH = narrow ? 14 : 0;
  const t0 = s.startedAt;
  const t1 = Math.max(s.ref, t0 + 60000);
  const x = (t) => left + ((t - t0) / (t1 - t0)) * (W - left - right);
  const parts = [];
  const tick = niceTick(t1 - t0, narrow ? 4 : 8);
  parts.push('<g class="axis">');
  for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
    const anchor = x(t) < left + 30 ? 'start' : x(t) > W - right - 30 ? 'end' : 'middle';
    parts.push(
      `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${top + workers.length * (laneH + labelH)}"></line><text x="${x(t)}" y="${top - 9}" text-anchor="${anchor}">${clock(t)}</text>`,
    );
  }
  parts.push('</g>');
  workers.forEach((w, i) => {
    const y = top + i * (laneH + labelH) + labelH;
    const mid = y + laneH / 2;
    const color = wc(w.name);
    if (narrow)
      parts.push(`<text x="${left}" y="${y - 3}" style="fill:${color};font-weight:500">${esc(w.name)}</text>`);
    else
      parts.push(
        `<text x="${left - 8}" y="${mid + 4}" text-anchor="end" style="fill:${color};font-weight:500">${esc(w.name)}</text>`,
      );
    parts.push(
      `<rect class="lane-bg" x="${left}" y="${y + 4}" width="${W - left - right}" height="${laneH - 8}" rx="4"></rect>`,
    );
    for (const g of w.gaps)
      parts.push(
        hatch(
          x(g.from),
          y + 4,
          x(g.to) - x(g.from),
          laneH - 8,
          'url(#hatch)',
          `no board event for ${dur(g.to - g.from)}\n${clock(g.from)}–${clock(g.to)}`,
        ),
      );
    if (w.lastT && (w.health === 'quiet' || w.health === 'stuck')) {
      parts.push(
        hatch(
          x(w.lastT),
          y + 4,
          x(t1) - x(w.lastT),
          laneH - 8,
          'url(#hatchBad)',
          `${w.health}: no event for ${dur(w.silence)}\nlast event ${clock(w.lastT)}`,
        ),
      );
      if (x(t1) - x(w.lastT) > 80)
        parts.push(
          `<text x="${(x(w.lastT) + x(t1)) / 2}" y="${mid + 4}" text-anchor="middle" style="fill:var(--warning);font-weight:500">quiet ${dur(w.silence)}</text>`,
        );
    }
    for (const t of tasks.filter((t) => t.owner === w.name && t.claimedAt)) {
      const end = t.doneAt ?? t1;
      const tip = `#${t.id} ${t.subject}\nclaimed ${clock(t.claimedAt)}${t.doneAt ? `, done ${clock(t.doneAt)} (${dur(t.doneAt - t.claimedAt)})` : ', still held'}`;
      parts.push(
        `<rect data-tip="${esc(tip)}" x="${x(t.claimedAt)}" y="${y + 9}" width="${Math.max(3, x(end) - x(t.claimedAt))}" height="${laneH - 18}" rx="3" style="fill:color-mix(in srgb, ${color} 38%, var(--bg-surface));stroke:${color};stroke-width:1"></rect>`,
      );
      if (x(end) - x(t.claimedAt) > 26)
        parts.push(`<text class="bar-label" x="${x(t.claimedAt) + 5}" y="${mid + 4}">#${t.id}</text>`);
    }
    for (const m of timeline[w.name] ?? []) parts.push(marker(m, x(m.t), y, laneH));
  });
  const H = top + workers.length * (laneH + labelH) + 6;
  const swatch = (css) => `<i style="${css}"></i>`;
  return `<div class="card"><div class="tl-wrap"><svg class="tl" viewBox="0 0 ${W} ${H}" height="${H}">
    <defs>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--hatch);stroke-width:2"></line></pattern>
      <pattern id="hatchBad" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--hatch-bad);stroke-width:2"></line></pattern>
    </defs>${parts.join('')}</svg></div>
    <div class="legend">
      <span>${swatch('background:color-mix(in srgb, var(--w1) 38%, var(--bg-surface));border:1px solid var(--w1);border-radius:2px')}claimed → done</span>
      <span>${swatch('background:var(--success);border-radius:50%')}finding</span>
      <span>${swatch('background:var(--accent);border-radius:2px')}publish</span>
      <span>${swatch('background:var(--team);transform:rotate(45deg) scale(.8)')}apply</span>
      <span><b style="color:var(--warning)">↩</b> release</span>
      <span><b style="color:var(--error)">×</b> lost claim</span>
      <span>${swatch('border-left:2px dashed var(--text-tertiary)')}status</span>
      <span>${swatch('border-left:2px solid var(--success)')}outcome</span>
      <span><b style="color:var(--error)">■</b> stopped</span>
      <span><b style="color:var(--team)">↑</b> woken <b style="color:var(--warning)">↑</b> stall</span>
      <span>${swatch('background:repeating-linear-gradient(45deg,var(--hatch) 0 2px,transparent 2px 5px)')}no board event ≥ 8 min</span>
      <span>${swatch('background:repeating-linear-gradient(45deg,var(--hatch-bad) 0 2px,transparent 2px 5px)')}quiet ≥ 10 min</span>
    </div>
  </div>`;
}

function marker(m, cx, y, laneH) {
  const at = clock(m.t);
  if (m.type === 'finding')
    return `<circle data-tip="${esc(`finding #${m.id} ${at}\n${m.text}`)}" cx="${cx}" cy="${y + 6}" r="4.5" style="fill:var(--success);stroke:var(--bg-surface);stroke-width:1.5"></circle>`;
  if (m.type === 'publish')
    return `<rect data-tip="${esc(`publication #${m.id} ${at}\n${m.summary}`)}" x="${cx - 4}" y="${y + laneH - 10}" width="8" height="8" rx="1.5" style="fill:var(--accent);stroke:var(--bg-surface);stroke-width:1"></rect>`;
  if (m.type === 'apply')
    return `<path data-tip="${esc(`applied publication #${m.id} ${at}\n${m.paths.join(', ')}`)}" d="M${cx} ${y + laneH - 11}l5 5-5 5-5-5z" style="fill:var(--team);stroke:var(--bg-surface);stroke-width:1"></path>`;
  if (m.type === 'release')
    return `<text data-tip="${esc(`released #${m.item} ${at}\n${m.handoff ?? ''}`)}" x="${cx}" y="${y + 10}" text-anchor="middle" style="fill:var(--warning);font-weight:600;font-size:12px">↩</text>`;
  if (m.type === 'lost') {
    const tip = `lost the claim on #${m.item} ${at}${m.owner ? `, held by ${m.owner}` : ''}`;
    return `<text data-tip="${esc(tip)}" x="${cx}" y="${y + 10}" text-anchor="middle" style="fill:var(--error);font-weight:600;font-size:13px">×</text>`;
  }
  if (m.type === 'stopped')
    return `<text data-tip="${esc(`stopped ${at}\n${m.reason}`)}" x="${cx}" y="${y + laneH / 2 + 4}" text-anchor="middle" style="fill:var(--error);font-weight:600;font-size:12px">■</text>`;
  if (m.type === 'woken') {
    const tip = `woke up ${at}: ${WAKE_REASONS[m.reason] ?? m.reason}\nwas ${m.from}${m.dependency ? ` for ${m.dependency}` : ''}`;
    const color = m.reason === 'no_producer' ? 'var(--warning)' : 'var(--team)';
    return `<text data-tip="${esc(tip)}" x="${cx}" y="${y + laneH - 3}" text-anchor="middle" style="fill:${color};font-weight:600;font-size:12px">↑</text>`;
  }
  if (m.type === 'outcome')
    return `<line data-tip="${esc(`outcome ${m.outcome} ${at}\n${m.summary}`)}" x1="${cx}" x2="${cx}" y1="${y + 4}" y2="${y + laneH - 4}" style="stroke:var(--success);stroke-width:2"></line>`;
  if (m.type === 'status') {
    const tip = `${m.state}${m.dependency ? ` for ${m.dependency}` : ''}${m.summary ? `: ${m.summary}` : ''} ${at}`;
    return `<line data-tip="${esc(tip)}" x1="${cx}" x2="${cx}" y1="${y + 4}" y2="${y + laneH - 4}" style="stroke:var(--text-tertiary);stroke-width:2;stroke-dasharray:2 2"></line>`;
  }
  return '';
}

const hatch = (x, y, w, h, fill, tip) =>
  `<rect data-tip="${esc(tip)}" x="${x}" y="${y}" width="${Math.max(0, w)}" height="${h}" rx="4" style="fill:${fill}"></rect>`;

function niceTick(span, n) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240].map((m) => m * 60000);
  return steps.find((s) => span / s <= n) ?? steps.at(-1);
}

function diffClass(l) {
  if (l.startsWith('@@')) return 'hunk';
  if (/^(\+\+\+|---) /.test(l)) return 'meta';
  if (l.startsWith('+')) return 'add';
  if (l.startsWith('-')) return 'del';
  return '';
}

const diffHtml = (text) =>
  text
    .split('\n')
    .map((l) => {
      const cls = diffClass(l);
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    })
    .join('\n');

function knowledgeView() {
  const { findings, releases, workers } = state.model;
  const authors = workers.map((w) => w.name).filter((n) => findings.some((f) => f.actor === n));
  const shown = findings.filter((f) => !state.scope || f.actor === state.scope);
  const filters = `<div class="filters"><button class="filter${state.scope ? '' : ' on'}" data-scope="">all</button>${authors.map((a) => `<button class="filter${state.scope === a ? ' on' : ''}" data-scope="${esc(a)}">${esc(a)}</button>`).join('')}</div>`;
  const list = shown
    .slice()
    .reverse()
    .map(
      (f) => `<div class="note"><div>
        <div class="text">${hl(f.text)}</div>
        <div class="sub">${who(f.actor)} · ${clock(f.t)} · #${f.id}</div>
      </div></div>`,
    )
    .join('');
  const handoffs = releases
    .slice()
    .reverse()
    .map(
      (r) => `<div class="note"><div>
        <div class="text">${hl(r.handoff)}</div>
        <div class="sub">${who(r.who)} released ${hl(`#${r.taskId}`)} · ${clock(r.t)}${r.checkpoint ? ` · checkpoint ${hl(`publication ${r.checkpoint}`)}` : ''}</div>
      </div></div>`,
    )
    .join('');
  return `${filters}<div class="grid cols-2">
    <div class="card"><div class="section-title"><span>Findings</span><span>${shown.length}</span></div>${list || '<p class="empty">None.</p>'}</div>
    <div class="card"><div class="section-title"><span>Handoffs</span><span>${releases.length}</span></div>${handoffs || '<p class="empty">None.</p>'}</div>
  </div>`;
}

function changesView() {
  const { workers, applies, publications, files } = state.model;
  const names = workers.map((w) => w.name);
  const head = names.map((n) => `<th>${esc(n)}</th>`).join('');
  const flow = names
    .map(
      (author) =>
        `<tr><td>${who(author)}</td>${names
          .map((to) => {
            if (to === author) return '<td class="num muted">—</td>';
            const n = applies.filter((a) => a.author === author && a.actor === to).length;
            return n ? `<td class="num">${n}</td>` : '<td class="num muted">·</td>';
          })
          .join('')}</tr>`,
    )
    .join('');
  const grid = files
    .map(
      (f) =>
        `<tr><td><code>${esc(f.path)}</code>${f.versions > 1 ? ` <span class="chip warn">${f.versions} versions</span>` : ''}</td>${names
          .map((n) => {
            const h = f.held[n];
            if (!h) return '<td class="held muted">base?</td>';
            const label = h.own ? 'own' : `from ${esc(h.author)}`;
            return `<td class="held${h.current ? '' : ' stale'}" title="${h.current ? 'latest publication' : 'a newer publication exists'}">${label} #${h.pub}${h.current ? '' : ' ⚠'}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const pubs = publications
    .map((p) => {
      const uses = applies.filter((a) => a.id === p.id).map((a) => `${esc(a.actor)} applied ${clock(a.t)}`);
      const open = state.diff?.pub === p.id ? state.diff : null;
      return `<div class="pub${focused(`pub-${p.id}`)}" id="pub-${p.id}">
        <div>${who(p.author)} <span class="sub">${clock(p.t)} · publication ${p.id}</span></div>
        <div class="title">${hl(p.summary)}</div>
        <ul class="files">${p.files
          .map(
            (f) =>
              `<li><button class="file-link${open?.path === f.path ? ' on' : ''}" data-diff="${p.id}" data-path="${esc(f.path)}" title="Show the diff"><span class="chg ${esc(f.change)}">${esc(f.change)}</span>${esc(f.path)}</button> <span class="muted">${f.bytes} B</span></li>`,
          )
          .join('')}</ul>
        ${open ? `<pre class="diff">${open.text == null ? 'Reading the diff…' : diffHtml(open.text)}</pre>` : ''}
        <div class="sub">${uses.length ? uses.join(' · ') : 'not taken by anyone'}</div>
      </div>`;
    })
    .join('');
  return `<div class="grid cols-2">
    <div class="stack">
      <div class="card"><div class="section-title"><span>Who applied whose work</span></div><div class="scroll"><table class="data-table"><thead><tr><th>author ↓ applier →</th>${head}</tr></thead><tbody>${flow}</tbody></table></div></div>
      <div class="card"><div class="section-title"><span>Files per worker, as logged</span></div><div class="scroll"><table class="data-table"><thead><tr><th>path</th>${head}</tr></thead><tbody>${grid}</tbody></table></div>
      <p class="sub" style="margin-top:8px">"base?" means the log has no publication or apply of that path by this worker. ⚠ means a newer publication exists. The log does not record a merge by hand.</p></div>
    </div>
    <div class="card"><div class="section-title"><span>Publications</span><span>${publications.length}</span></div>${pubs || '<p class="empty">None.</p>'}</div>
  </div>`;
}

function logView() {
  if (!state.log) return '<p class="loading">Reading the log…</p>';
  const { rows } = markup();
  const row = (e) => {
    let html = rows.get(e.seq);
    if (html == null) {
      html = `<tr><td>${e.seq}</td><td class="hide-narrow">${clock(e.t)}</td><td>${who(e.who)}</td><td><span class="kind k-${esc(e.group)}">${esc(e.kind)}</span></td><td class="payload" data-tip="${esc(JSON.stringify(e.payload, null, 2))}">${hl(e.text)}</td></tr>`;
      rows.set(e.seq, html);
    }
    return html;
  };
  return `<div class="card">
    <div class="scroll"><table class="data-table log"><thead><tr><th>seq</th><th class="hide-narrow">time</th><th>worker</th><th>kind</th><th>what happened</th></tr></thead><tbody>
    ${state.log.map(row).reverse().join('')}
    </tbody></table></div></div>`;
}

const RENDER = {
  summary: summaryView,
  queue: queueView,
  timeline: timelineView,
  knowledge: knowledgeView,
  changes: changesView,
  log: logView,
};
// #endregion RENDER

// #region MODAL
const SHORTCUTS = [
  [['1', '…', '6'], 'Switch the view'],
  [['r'], 'Refresh'],
  [['t'], 'Toggle light and dark'],
  [['Esc'], 'Close the menu or the dialog'],
  [['?'], 'Show this help'],
];

function showHelp() {
  $('helpShortcuts').innerHTML = SHORTCUTS.map(
    ([keys, label]) =>
      `<dt>${keys.map((k) => (k === '…' ? k : `<kbd>${esc(k)}</kbd>`)).join('')}</dt><dd>${esc(label)}</dd>`,
  ).join('');
  helpModal.showModal();
}

helpModal.addEventListener('click', (e) => {
  if (e.target === helpModal) helpModal.close();
});
// #endregion MODAL

// #region EVENTS
const tip = $('tip');
document.addEventListener('pointermove', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) {
    tip.hidden = true;
    return;
  }
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${e.clientY + 14}px`;
});

// A frame drawn while hidden, such as a background pane tab, gets no window resize when shown.
let resizeTimer = null;
let mainWidth = main.clientWidth;
new ResizeObserver(() => {
  if (main.clientWidth === mainWidth) return;
  mainWidth = main.clientWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.view === 'timeline' && render(), 120);
}).observe(main);

document.addEventListener('click', (e) => {
  if (!e.target.closest('#themePickerBtn')) toggleThemeMenu(false);
  const el = e.target.closest('[data-view],[data-scope],[data-diff],[data-task],[data-pub],[data-act],[data-color-theme-id],#themePickerBtn');
  if (!el) return;
  if (el.classList.contains('ref')) e.preventDefault();
  if (el.dataset.task) {
    reveal('queue', `task-${el.dataset.task}`);
  } else if (el.dataset.pub) {
    reveal('changes', `pub-${el.dataset.pub}`);
  } else if (el.dataset.diff) {
    const pub = Number(el.dataset.diff);
    if (!el.classList.contains('ref')) return toggleDiff(pub, el.dataset.path);
    openDiff(pub, el.dataset.path);
    reveal('changes', `pub-${pub}`);
  } else if (el.dataset.colorThemeId) {
    setColorTheme(el.dataset.colorThemeId);
    toggleThemeMenu(false);
  } else if (el.id === 'themePickerBtn') {
    toggleThemeMenu();
  } else if (el.dataset.view) {
    setView(el.dataset.view);
  } else if (el.dataset.scope != null) {
    state.scope = el.dataset.scope || null;
    render();
  } else {
    act(el.dataset.act);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'swarmPick') pickSwarm(e.target.value);
});

function act(name) {
  if (name === 'help') showHelp();
  else if (name === 'close-help') helpModal.close();
  else if (name === 'theme') toggleTheme();
  else if (name === 'refresh') refresh();
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  if (helpModal.open) return;
  if (e.target.closest('input:not([type=checkbox]), textarea, [contenteditable]')) return;
  if (e.key === 'Escape') {
    toggleThemeMenu(false);
    if (state.focus) {
      state.focus = null;
      render();
    }
    return;
  }
  if (e.key === 'Enter' && e.target.id === 'themePickerBtn') return toggleThemeMenu();
  const keys = { r: 'refresh', t: 'theme', '?': 'help' };
  if (keys[e.key]) {
    e.preventDefault();
    return act(keys[e.key]);
  }
  const n = Number(e.key);
  if (n >= 1 && n <= VIEWS.length) {
    e.preventDefault();
    setView(VIEWS[n - 1].id);
  }
});
// #endregion EVENTS

// #region INIT
const fromUrl = new URLSearchParams(location.search).get('view');
state.view = [fromUrl, stored('view')].find((v) => VIEWS.some((x) => x.id === v)) ?? 'summary';
render();
showIfSeen();
if (shown) loadSwarms();
else refresh();
// #endregion INIT

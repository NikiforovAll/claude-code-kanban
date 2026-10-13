'use strict';

// #region STATE
const $ = (id) => document.getElementById(id);
const main = $('main');
const helpModal = $('helpModal');
const swarmsModal = $('swarmsModal');

// `clockless`: the view draws nothing from the clock, so a resend with no new event changes nothing
// in it. `byWidth`: the view draws to the width of the page. `needsLog`: the view shows the event log.
const VIEWS = [
  { id: 'summary', label: 'Summary', needsRequest: true },
  { id: 'request', label: 'Request', needsRequest: true, byWidth: true },
  { id: 'queue', label: 'Queue' },
  { id: 'timeline', label: 'Timeline', byWidth: true, needsLog: true },
  { id: 'knowledge', label: 'Knowledge', clockless: true },
  { id: 'changes', label: 'Changes', clockless: true },
  { id: 'log', label: 'Log', clockless: true, needsLog: true },
];
const viewOf = (id) => VIEWS.find((v) => v.id === id);

const state = {
  swarm: new URLSearchParams(location.search).get('swarm'),
  swarms: [],
  pinned: false,
  root: null,
  model: null,
  view: 'summary',
  scope: null,
  lane: null,
  diff: null,
  focus: null,
  log: null,
  request: null,
  rev: null,
  sec: null,
  pending: null,
  reqMode: 'spec',
  closed: new Set(),
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
function toast(text, kind = 'error') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast ${kind}`;
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

function connect() {
  if (stream) return;
  stream = new EventSource(api('/api/stream'));
  stream.addEventListener('swarm', (e) => {
    const next = JSON.parse(e.data);
    const moved = next.swarm.seq !== state.model?.swarm.seq;
    state.model = next;
    $('live').classList.add('on');
    if (moved && state.log) loadLog();
    if (moved || !viewOf(state.view).clockless) render();
  });
  stream.addEventListener('failure', (e) => toast(`The swarm log could not be read: ${JSON.parse(e.data)}`));
  stream.addEventListener('missing', async (e) => {
    disconnect();
    toast(JSON.parse(e.data));
    try {
      const r = await (await fetch('/api/swarms')).json();
      if (r.selected) return pickSwarm(r.selected);
      state.swarm = null;
      setSwarmParam(null);
      await refresh();
      if (shown) connect();
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
  reqFailed = null;
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
    if (gen === logGen && (rows.length || !state.log)) {
      state.log = (state.log ?? []).concat(rows);
      if (viewOf(state.view).needsLog) render();
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

// The texts change only with a new request revision, so they are fetched once per revision. A fetch
// that failed is tried again on the next revision or a refresh, not on every frame.
let reqBusy = null;
let reqFailed = null;
async function loadRequest() {
  const s = state.model?.swarm;
  if (!s?.listId) return;
  const key = `${s.listId}:${s.revision}`;
  if (state.request?.key === key || reqBusy === key || reqFailed === key) return;
  reqBusy = key;
  try {
    const r = await fetch(api('/api/request'));
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    if (reqBusy !== key) return;
    const texts = new Map(body.revisions.map((x) => [x.revision, x.text]));
    state.request = { key, texts, doc: splitSpec(texts.get(1) ?? '') };
    if (viewOf(state.view).needsRequest) render();
    if (state.pending && state.view === 'request') {
      const id = state.pending;
      state.pending = null;
      reveal('request', id);
    }
  } catch (err) {
    if (reqBusy === key) reqFailed = key;
    toast(`The request did not load: ${err.message}`);
  } finally {
    if (reqBusy === key) reqBusy = null;
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

function setSwarmParam(id) {
  const u = new URL(location.href);
  if (id) u.searchParams.set('swarm', id);
  else u.searchParams.delete('swarm');
  history.replaceState(null, '', u);
}

function pickSwarm(id) {
  if (!id || id === state.swarm) return;
  Object.assign(state, { swarm: id, model: null, diff: null, scope: null, lane: null, focus: null, request: null, rev: null, sec: null, pending: null });
  state.closed.clear();
  reqBusy = null;
  reqFailed = null;
  resetLog();
  setSwarmParam(id);
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

// A stream frame can redraw the view while the flash runs, so render() puts it back.
let flashing = null;

function reveal(view, id) {
  setView(view, id);
  const el = document.getElementById(id);
  if (!el) return;
  flashing = { id, until: Date.now() + 3200 };
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function showRev(n) {
  state.rev = n;
  state.sec = null;
  reveal('request', `rev-${n}`);
}

// A section exists only once the request text is in, so a jump before that waits for it.
function showSec(id) {
  state.sec = id;
  state.closed.delete(id);
  if (state.request) return reveal('request', id);
  state.pending = id;
  setView('request');
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
  const listed = !state.pinned && state.swarms.length > 0;
  pick.hidden = !listed;
  $('swarmName').hidden = listed;
  if (!listed) return;
  pick.innerHTML = `${esc(state.swarm ?? 'Pick a swarm')} <span class="caret" aria-hidden="true">▾</span>`;
  if (swarmsModal.open) renderRuns();
}

const OUTCOME_CHIP = { complete: 'ok', partial: 'warn', stopped: 'bad' };

function runRow(s) {
  const kind = s.state === 'running' ? 'ok' : (OUTCOME_CHIP[s.outcome] ?? '');
  const text = s.outcome ? `ended · ${s.outcome}` : s.state;
  const start = s.startedAt ? new Date(s.startedAt) : null;
  const when = start ? `${start.toLocaleDateString()} ${clock(start)}` : '—';
  const took = start && s.endedAt ? dur(new Date(s.endedAt) - start) : s.state === 'running' ? 'runs now' : '—';
  const workers = s.workers.length ? s.workers.map(esc).join(', ') : 'no workers';
  const del = `<button class="run-delete" data-act="delete-run" data-run="${esc(s.id)}" title="Delete this run">Delete</button>`;
  return `<li class="run${s.id === state.swarm ? ' on' : ''}">
    <button class="run-open" data-act="open-run" data-run="${esc(s.id)}">
      <span class="run-head"><span class="run-id">${esc(s.id)}</span> <span class="chip ${kind}">${esc(text)}</span></span>
      <span class="run-goal">${esc(s.goal)}</span>
      <span class="run-meta">${esc(when)} · ${esc(took)} · ${workers}</span>
    </button>${del}</li>`;
}

function renderRuns() {
  $('swarmRuns').innerHTML = state.swarms.length
    ? state.swarms.map(runRow).join('')
    : '<li class="run-empty">No swarm runs left.</li>';
}

function showSwarms() {
  if (state.pinned) return;
  renderRuns();
  swarmsModal.showModal();
}

// The first click arms the button; the second, on the same button, deletes.
async function deleteRun(btn) {
  if (!btn.classList.contains('armed')) {
    for (const b of swarmsModal.querySelectorAll('.run-delete.armed')) {
      b.classList.remove('armed');
      b.textContent = 'Delete';
    }
    btn.classList.add('armed');
    btn.textContent = 'Confirm delete';
    return;
  }
  const id = btn.dataset.run;
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const r = await fetch(`/api/swarms/delete?${new URLSearchParams({ swarm: id })}`, { method: 'POST' });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    toast(`Deleted ${id}.`, 'ok');
  } catch (err) {
    toast(`${id} was not deleted: ${err.message}`);
  }
  await loadSwarms();
  renderRuns();
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
  history.replaceState(null, '', viewUrl(id, id === 'request' ? { rev: state.rev, sec: state.sec } : {}) + location.hash);
  render();
}

// The page's query without its view keys, read again only when the address changes.
let baseQuery = { from: null, rest: '' };

function viewUrl(view, { rev, sec } = {}) {
  if (baseQuery.from !== location.search) {
    const q = new URLSearchParams(location.search);
    for (const k of ['view', 'rev', 'sec']) q.delete(k);
    baseQuery = { from: location.search, rest: String(q) };
  }
  const own = [`view=${encodeURIComponent(view)}`];
  if (rev != null) own.push(`rev=${encodeURIComponent(rev)}`);
  if (sec != null) own.push(`sec=${encodeURIComponent(sec)}`);
  return `?${[baseQuery.rest, ...own].filter(Boolean).join('&')}`;
}

const reqHref = (params) => esc(viewUrl('request', params));

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
  const scroll = main.scrollTop;
  main.innerHTML = `${tabs}<div class="view">${RENDER[state.view]()}</div>`;
  main.scrollTop = scroll;
  if (flashing && Date.now() < flashing.until) document.getElementById(flashing.id)?.classList.add('flash');
  if (hoverSeq != null) markHover();
  if (viewOf(state.view).needsLog && !state.log) loadLog();
  if (viewOf(state.view).needsRequest) loadRequest();
}

function deliveryLine(d) {
  if (!d) return '';
  const files = (paths) =>
    `${paths.slice(0, 8).map((p) => `<code>${esc(p)}</code>`).join(', ')}${paths.length > 8 ? ` and ${paths.length - 8} more` : ''}`;
  let text;
  if (d.delivered)
    text = d.changed.length
      ? `Delivered ${plural(d.changed.length, 'file')} from ${who(d.worker)}: ${files(d.changed)}.${d.merged.length ? ` Merged with local edits: ${files(d.merged)}.` : ''}`
      : `The result of ${who(d.worker)} changes no file.`;
  else text = d.conflicts.length ? `Not delivered: conflicts in ${files(d.conflicts)}.` : 'Not delivered.';
  if (d.recovery) text += ` Saved in <code>${esc(d.recovery)}</code>.`;
  return `<p class="sub delivery">${text}</p>`;
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
      ${specLink()}
    </div>
    ${s.outcome ? `<p class="outcome"><span class="chip ${s.outcome.outcome === 'complete' ? 'ok' : 'warn'}">${esc(s.outcome.outcome)}</span> ${hl(s.outcome.summary)}</p>` : ''}
    ${deliveryLine(s.delivery)}
    <div class="progress" title="${p.done} done, ${p.claimed} claimed, ${p.open} open">
      <span class="done" style="width:${pct(p.done)}%"></span><span class="claimed" style="width:${pct(p.claimed)}%"></span>
    </div>
    <div class="sub">${p.done} of ${p.total} tasks done${p.closed ? ` (${p.closed} closed)` : ''} · ${p.claimed} claimed · ${p.open} open</div>
  </div>
  ${requestCard()}
  <div class="grid cols-2">
    <div class="card">
      <div class="section-title"><span>Workers</span><span>${workers.length}</span></div>
      ${workers
        .map(
          (w) => `<div class="worker-row">
          ${who(w.name)}
          <span>${healthChip(w.health)}${w.health === 'stopped' || s.endedAt ? '' : turnChip(w.running)}</span>
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
  ${
    findings.length
      ? `<div class="card"><div class="section-title"><span>Latest findings</span><a class="ref" href="?view=knowledge" data-view="knowledge">all ${findings.length}</a></div>${findings
            .slice(-3)
            .reverse()
            .map((f) => findingNote(f, true))
            .join('')}</div>`
      : ''
  }
  <div class="stats">
    ${stat(findings.length, 'Findings')}
    ${stat(state.model.publications.length, 'Publications')}
    ${stat(state.model.applies.length, 'Applies')}
    ${stat(state.model.releases.length, 'Releases')}
    ${stat(races.length, 'Lost races')}
  </div>
  </div>`;
}

const CANON = ['Goal', 'Constraints', 'Decisions', 'Acceptance checks'];
const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
const inlineCode = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const revName = (n) => (n === 1 ? 'Spec' : `Revision ${n}`);
const revShort = (n) => (n === 1 ? 'spec' : `rev ${n}`);
const revStatus = (n) => (n === state.model.swarm.revision ? 'current' : n === 1 ? null : 'superseded');
const superseded = (outcome, rev) => outcome === 'complete' && rev < state.model.swarm.revision;
const taskRef = (id) => `<a class="ref" href="#" data-task="${id}">#${id}</a>`;
const secChip = (x, words = false) =>
  `<button class="filter" data-sec="${x.id}">${esc(x.name)}${words ? `<span class="n">${x.words}</span>` : ''}</button>`;

function selRev() {
  const { revisions, swarm } = state.model;
  return revisions.some((r) => r.revision === state.rev) ? state.rev : swarm.revision;
}

function tlWidth() {
  const css = getComputedStyle(main);
  const room = main.clientWidth - 2 * Number.parseFloat(css.paddingLeft);
  return Math.min(Number.parseFloat(css.getPropertyValue('--content-max')), room) - 26;
}

// Headings inside a code fence are text, not sections.
function splitSpec(text) {
  const parts = [];
  let cur = { name: null, body: [] };
  let title = null;
  let fence = null;
  for (const l of text.replace(/\r\n?/g, '\n').split('\n')) {
    const f = /^\s*(```|~~~)/.exec(l);
    if (f) fence = fence == null ? f[1] : fence === f[1] ? null : fence;
    else if (fence == null && title == null && !parts.length && cur.body.every((b) => !b.trim()) && l.startsWith('# ')) {
      title = l.slice(2).trim();
      continue;
    } else if (fence == null && l.startsWith('## ')) {
      parts.push(cur);
      cur = { name: l.slice(3).trim(), body: [] };
      continue;
    }
    cur.body.push(l);
  }
  parts.push(cur);
  const ids = new Set();
  const sections = [];
  for (const p of parts) {
    const body = p.body.join('\n').trim();
    if (!p.name && !body) continue;
    const base = p.name ? `sec-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'part'}` : 'sec-intro';
    let id = base;
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
    ids.add(id);
    sections.push({ id, name: p.name, body, words: wordCount(body) });
  }
  return { title, words: wordCount(text), sections };
}

// Request texts come from the log, which any session on the machine can write, so they are sanitized.
const mdCache = new Map();
if (window.DOMPurify)
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A' || !node.hasAttribute('href')) return;
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });

function md(text) {
  if (!text) return '';
  let html = mdCache.get(text);
  if (html == null) {
    html =
      window.marked && window.DOMPurify
        ? DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['img', 'style', 'form', 'input', 'button'] })
        : `<p>${esc(text)}</p>`;
    mdCache.set(text, html);
  }
  return html;
}

function gist(text) {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find((l) => l && !/^(#|```|~~~|---)/.test(l)) ?? '';
  return line.replace(/^([-*+]|\d+\.)\s+/, '').replace(/\*\*|__/g, '').split(/(?<=[.!?])\s/)[0];
}

function specLink() {
  const { revisions, spec, swarm: s } = state.model;
  if (!revisions.length) return '';
  const last = revisions.at(-1);
  const title = `Open the request: ${spec ? `spec ${clock(spec.t)}, ` : ''}revision ${s.revision} current${last.revision > 1 ? ` since ${clock(last.t)}` : ''}`;
  const label = revisions.length > 1 ? `spec · ${revisions.length} revisions` : 'spec · rev 1';
  return `<a class="ref" href="${reqHref({ rev: s.revision })}" data-rev="${s.revision}" title="${esc(title)}">${label}</a>`;
}

function requestCard() {
  const { revisions, spec, swarm: s } = state.model;
  if (!revisions.length) return '';
  const last = revisions.at(-1);
  const req = state.request;
  const goal = req?.doc.sections.find((x) => x.name?.toLowerCase() === 'goal');
  const row = (key, value, label, text, t, title) =>
    `<a class="req-row" href="${reqHref({ [key]: value })}" data-${key}="${esc(value)}" title="${esc(title)}"><span class="rv">${label}</span><span class="txt">${inlineCode(gist(text))}</span><span class="sub">${clock(t)}</span></a>`;
  const rows = [];
  if (spec)
    rows.push(
      goal
        ? row('sec', goal.id, 'goal', goal.body, spec.t, 'Open the Goal section')
        : row('rev', 1, 'spec', req?.doc.title ?? req?.texts.get(1), spec.t, 'Open the spec'),
    );
  if (last.revision > 1)
    rows.push(row('rev', last.revision, revShort(last.revision), req?.texts.get(last.revision), last.t, `Open revision ${last.revision}`));
  return `<div class="card"><div class="section-title"><span>Request</span><a class="ref" href="${reqHref({ rev: s.revision })}" data-rev="${s.revision}">rev ${s.revision}</a></div>${rows.join('')}</div>`;
}

function revCounts(r) {
  return (
    [
      [r.tasks.length, r.revision === 1 ? 'task' : 'new task'],
      [r.retitles.length, 'retitle'],
      [r.publications.length, 'publication'],
      [r.outcomes.length, 'outcome'],
      [r.refused.length, 'refused', 'refused'],
    ]
      .filter(([n]) => n)
      .map(([n, one, many]) => plural(n, one, many))
      .join(' · ') || '—'
  );
}

function requestView() {
  if (!state.model.revisions.length) return '<p class="empty">No request in the log.</p>';
  const byRev = Map.groupBy(state.model.tasks, (t) => t.revision);
  return `<div class="stack">
    ${reqHead(byRev)}
    ${reqTimeline()}
    <div class="grid cols-2 req-grid">${specCard()}<div class="stack">${revisionsCard()}${reqTasks(byRev)}</div></div>
  </div>`;
}

function reqHead(byRev) {
  const { swarm: s, revisions, tasks, spec } = state.model;
  const doc = state.request?.doc;
  const sel = selRev();
  const rail = revisions
    .map((r) => {
      const cur = r.revision === s.revision;
      const kind = [r.revision === 1 ? 'spec' : null, revStatus(r.revision)].filter(Boolean).join(' · ');
      return `<button class="rail-step${r.revision === sel ? ' on' : ''}${cur ? ' current' : ''}" role="tab" aria-selected="${r.revision === sel}" data-rev="${r.revision}" title="seq ${r.seq} · ${esc(r.who)}">
        <span class="r-kind">${kind}</span>
        <span class="r-top"><span>${revName(r.revision)}</span><span class="r-t">${clock(r.t)}</span></span>
        <span class="r-sum">${revCounts(r)}</span>
      </button>`;
    })
    .join('');
  const facts = [
    spec ? `spec ${clock(spec.t)} by ${esc(spec.who)}` : '',
    doc ? `${plural(doc.words, 'word')} · ${plural(doc.sections.filter((x) => x.name).length, 'section')}` : '',
    `revision ${s.revision} is current`,
    `${plural(revisions.length - 1, 'change')} since the spec`,
    `${plural(byRev.get(1)?.length ?? 0, 'task')} seeded · ${tasks.length} now`,
  ];
  return `<div class="card">
    <h1 class="goal">${esc(s.goal ?? 'No goal recorded')}</h1>
    <div class="facts">${facts.filter(Boolean).map((f) => `<span>${f}</span>`).join('')}</div>
    <div class="rail" role="tablist" aria-label="Request revisions">${rail}</div>
  </div>`;
}

function reqTimeline() {
  return `<div class="card"><div class="section-title"><span>Revisions over time</span></div>${laneChart(true)}</div>`;
}

function specCard() {
  const req = state.request;
  if (!req) return '<div class="card"><p class="empty">Reading the request…</p></div>';
  const { doc, texts } = req;
  if (!doc.sections.length) return '<div class="card"><p class="empty">No spec in the log.</p></div>';
  const { spec, revisions, swarm: s } = state.model;
  const named = doc.sections.filter((x) => x.name);
  const has = new Set(named.map((x) => x.name.toLowerCase()));
  const nav = [
    ...named.map((x) => secChip(x, true)),
    ...CANON.filter((c) => !has.has(c.toLowerCase())).map((c) => `<span class="filter absent" title="The spec has no ${c} section">${c}</span>`),
  ].join('');
  const sel = selRev();
  const body = doc.sections
    .map((x) =>
      x.name
        ? `<details class="sec" id="${x.id}" data-part="${x.id}"${state.closed.has(x.id) ? '' : ' open'}><summary><h2>${esc(x.name)}</h2><span class="sub">${plural(x.words, 'word')}</span></summary><div class="md">${md(x.body)}</div></details>`
        : `<div class="md intro" id="${x.id}">${md(x.body)}</div>`,
    )
    .join('');
  const inline =
    state.reqMode === 'all'
      ? revisions
          .filter((r) => r.revision > 1 && r.revision <= sel)
          .map(
            (r) => `<div class="note inline-rev${r.revision === s.revision ? ' current' : ''}">
              <div class="note-head"><a class="ref" href="${reqHref({ rev: r.revision })}" data-rev="${r.revision}">${revName(r.revision)}</a>${r.revision === s.revision ? '<span class="chip ok">current</span>' : ''}<span class="sub">${clock(r.t)} · ${esc(r.who)}</span></div>
              <div class="md">${md(texts.get(r.revision))}</div>
            </div>`,
          )
          .join('')
      : '';
  const modes =
    revisions.length > 1
      ? `<span class="seg" role="group" aria-label="What to show"><button data-mode="spec" class="filter${state.reqMode === 'spec' ? ' on' : ''}">Spec only</button><button data-mode="all" class="filter${state.reqMode === 'all' ? ' on' : ''}" title="The spec plus each revision up to revision ${sel}, as a worker holds them">Spec + revisions ≤ ${sel}</button></span>`
      : '';
  const docTip = spec ? `Request revision 1 · seq ${spec.seq} · ${clock(spec.t)} · ${spec.who}` : '';
  return `<div class="card spec-card">
    ${nav ? `<div class="sec-nav">${nav}</div>` : ''}
    <div class="toolbar">
      <div class="doc-title" title="${esc(docTip)}">${inlineCode(doc.title ?? 'Spec')}</div>
      <span class="grow"></span>
      ${modes}
      ${named.length ? '<span class="seg"><button class="filter" data-fold="open">Expand</button><button class="filter" data-fold="close">Collapse</button></span>' : ''}
    </div>
    ${body}${inline}
  </div>`;
}

function revisionsCard() {
  const { revisions, tasks } = state.model;
  const sel = selRev();
  const req = state.request;
  const subject = new Map(tasks.map((t) => [t.id, t.subject]));
  const notes = revisions
    .slice()
    .reverse()
    .map((r) => {
      const n = r.revision;
      const status = revStatus(n);
      const chip = status ? `<span class="chip${status === 'current' ? ' ok' : ''}">${status}</span>` : '';
      let body = '';
      if (!req) body = '<p class="empty">Reading the request…</p>';
      else if (n === 1) body = `<div class="filters">${req.doc.sections.filter((x) => x.name).map((x) => secChip(x)).join('')}</div>`;
      else body = `<div class="md">${md(req.texts.get(n))}</div>`;
      return `<div class="note rev-note${status === 'current' ? ' current' : ''}${n === sel ? ' sel' : ''}" id="rev-${n}">
        <div class="note-head"><a class="ref" href="${reqHref({ rev: n })}" data-rev="${n}">${revName(n)}</a>${chip}<span class="sub">${clock(r.t)} · seq ${r.seq} · ${esc(r.who)}</span></div>
        ${body}${impact(r, subject)}
      </div>`;
    })
    .join('');
  return `<div class="card"><div class="section-title"><span>Request revisions</span><span>${revisions.length}</span></div>${notes}</div>`;
}

function impact(r, subject) {
  const { workers, swarm: s } = state.model;
  const n = r.revision;
  const rows = [];
  if (r.tasks.length) rows.push(['ok', n === 1 ? 'seeded' : 'new task', r.tasks.map((id) => `${taskRef(id)} ${esc(subject.get(id) ?? '')}`).join(' · ')]);
  for (const x of r.retitles)
    rows.push(['warn', 'retitled', `${taskRef(x.taskId)} <span title="${esc(`was: ${x.from}`)}">${esc(x.to)}</span> <span class="muted">${esc(x.who)} ${clock(x.t)}</span>`]);
  if (r.woken.length) rows.push(['info', 'woken', r.woken.map((w) => `${who(w.who)} ${clock(w.t)}`).join(' · ')]);
  if (n > 1) {
    const first = new Map(r.first.map((f) => [f.who, f.t]));
    const acks = workers.map((w) => {
      if (first.has(w.name)) return `${who(w.name)} ${clock(first.get(w.name))}`;
      if (w.acked != null && w.acked >= n) return `${who(w.name)} <span class="muted">acked</span>`;
      return `${who(w.name)} <span class="muted">${w.health === 'stopped' ? 'stopped' : 'not yet'}</span>`;
    });
    rows.push(['', 'acked', acks.join(' · '), 'The first event each worker wrote under this revision; "acked" when the store has its acknowledgment and no event yet']);
  }
  if (r.publications.length)
    rows.push([
      'info',
      'publish',
      r.publications.map((p) => `${who(p.who)} <a class="ref" href="#" data-pub="${p.id}" title="${esc(p.summary)}">publication ${p.id}</a>`).join(' · '),
    ]);
  for (const o of r.outcomes) {
    const stale = superseded(o.outcome, n)
      ? ` <span class="chip warn" title="${esc(`Declared under revision ${n}; revision ${s.revision} came later`)}">superseded</span>`
      : '';
    rows.push(['info', 'outcome', `${who(o.who)} <span title="${esc(o.summary ?? '')}">${esc(o.outcome)}</span> ${clock(o.t)}${stale}`]);
  }
  for (const x of r.refused)
    rows.push([
      'bad',
      'refused',
      `${who(x.who)} ${esc(x.outcome ?? '?')} <span class="muted">declared under revision ${x.expected ?? '?'}</span> ${clock(x.t)}`,
      'The store refused this declaration: it did not acknowledge the current revision',
    ]);
  if (!rows.length) return '';
  return `<ul class="impact">${rows
    .map(([k, label, html, title]) => `<li><span class="chip ${k}"${title ? ` title="${esc(title)}"` : ''}>${label}</span><span>${html}</span></li>`)
    .join('')}</ul>`;
}

const TASK_CHIP = { done: 'ok', claimed: 'info', open: '' };

const metaRow = (meta) => `<div class="meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>`;

function reqTask(t) {
  const meta = [taskRef(t.id), `<span class="chip ${t.closed ? '' : TASK_CHIP[t.state]}">${t.closed ? 'closed' : t.state}</span>`];
  if (t.owner) meta.push(who(t.owner));
  for (const x of t.retitles) meta.push(`<span class="chip warn" title="${esc(`was: ${x.from}`)}">retitled in rev ${x.revision}</span>`);
  return `<div class="task${t.closed ? ' closed' : ''}"><div class="t">${hl(t.subject)}</div>${metaRow(meta)}</div>`;
}

function reqTasks(byRev) {
  const { tasks } = state.model;
  const groups = [...byRev.keys()]
    .sort((a, b) => a - b)
    .map((n) => {
      const list = byRev.get(n);
      return `<div class="section-title req-group"><a class="ref" href="${reqHref({ rev: n })}" data-rev="${n}">${revName(n)}</a><span>${list.length}</span></div>${list.map(reqTask).join('')}`;
    })
    .join('');
  return `<div class="card"><div class="section-title"><span>Tasks by revision</span><span>${tasks.length}</span></div>${groups || '<p class="empty">None.</p>'}</div>`;
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
    ${metaRow(meta)}
    ${t.summary ? `<div class="summary">${hl(t.summary)}</div>` : ''}
    ${t.state !== 'done' && t.handoff ? `<div class="summary"><span class="muted">handoff:</span> ${hl(t.handoff)}</div>` : ''}
    ${races.length ? `<div class="races">${races.join('')}</div>` : ''}
  </div>`;
}

function timelineView() {
  const lane = state.model.workers.some((w) => w.name === state.lane) ? state.lane : null;
  const drawn = new Set();
  for (const [name, marks] of Object.entries(state.model.timeline))
    if (!lane || name === lane) for (const m of marks) drawn.add(m.seq);
  const log = state.log ? eventList(state.log.filter((e) => drawn.has(e.seq))) : '<p class="loading">Reading the log…</p>';
  return `<div class="card tl-chart">${laneChart(false)}</div>
    <div class="card tl-log"><div class="section-title"><span>Events</span>${filterChips(state.model.workers.map((w) => w.name), lane, 'lane')}</div>${log}</div>`;
}

function tlScale() {
  const { swarm: s, workers } = state.model;
  const width = tlWidth();
  const narrow = width < 560;
  const W = Math.max(300, width);
  const left = narrow ? 8 : Math.max(96, 16 + 7 * Math.max(0, ...workers.map((w) => w.name.length)));
  const right = 12;
  const t0 = s.startedAt;
  const t1 = Math.max(s.ref, t0 + 60000);
  const x = (t) => left + ((Math.max(t, t0) - t0) / (t1 - t0)) * (W - left - right);
  return { narrow, W, left, right, t0, t1, x };
}

function laneChart(revs) {
  const { workers, timeline, tasks, revisions } = state.model;
  const { narrow, W, left, right, t0, t1, x } = tlScale();
  const laneH = narrow ? 44 : 40;
  const top = revs ? 40 : 22;
  const labelH = narrow ? 14 : 0;
  const H = top + workers.length * (laneH + labelH) + 6;
  const under = [];
  const parts = [];
  const tick = niceTick(t1 - t0, narrow ? 4 : 8);
  under.push('<g class="axis">');
  for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
    const anchor = x(t) < left + 30 ? 'start' : x(t) > W - right - 30 ? 'end' : 'middle';
    under.push(
      `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 6}"></line><text x="${x(t)}" y="${top - 9}" text-anchor="${anchor}">${clock(t)}</text>`,
    );
  }
  under.push('</g>');
  workers.forEach((w, i) => {
    const y = top + i * (laneH + labelH) + labelH;
    const mid = y + laneH / 2;
    const color = wc(w.name);
    const pick = revs ? '' : ` class="lane-name" data-lane="${esc(w.name)}"`;
    under.push(
      narrow
        ? `<text${pick} x="${left}" y="${y - 3}" style="fill:${color};font-weight:500">${esc(w.name)}</text>`
        : `<text${pick} x="${left - 8}" y="${mid + 4}" text-anchor="end" style="fill:${color};font-weight:500">${esc(w.name)}</text>`,
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
    for (const m of timeline[w.name] ?? []) {
      const mark = marker(m, x(m.t), y, laneH);
      if (mark) parts.push(`<g data-seq="${m.seq}" data-t="${m.t}">${mark}</g>`);
    }
  });
  if (revs) {
    const sel = selRev();
    revisions.forEach((r, i) => {
      const from = x(r.t);
      const to = x(revisions[i + 1]?.t ?? t1);
      const on = r.revision === sel && revisions.length > 1;
      const cls = on ? ' on' : i % 2 ? ' alt' : '';
      const name = revShort(r.revision);
      const tip = esc(`${revName(r.revision)}${revStatus(r.revision) === 'current' ? ' (current)' : ''}\n${clock(r.t)}–${clock(revisions[i + 1]?.t ?? t1)} · ${r.who}`);
      const end = from > W - right - 60;
      under.push(
        `<rect class="band${cls}" data-rev="${r.revision}" data-tip="${tip}" x="${from}" y="${top - 4}" width="${Math.max(0, to - from)}" height="${H - top}"></rect>`,
        `<line class="rev-line" x1="${from}" x2="${from}" y1="4" y2="${H - 2}"></line>`,
        `<text class="rev-label${on ? ' on' : ''}" data-rev="${r.revision}" data-tip="${tip}" x="${end ? from - 4 : from + 4}" y="13" text-anchor="${end ? 'end' : 'start'}">${name}</text>`,
      );
    });
  }
  const swatch = (css) => `<i style="${css}"></i>`;
  parts.push(`<line class="tl-cursor" y1="${top - 6}" y2="${H - 6}" style="display:none"></line>`);
  return `<div class="tl-wrap"><svg class="tl" viewBox="0 0 ${W} ${H}" height="${H}">
    <defs>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--hatch);stroke-width:2"></line></pattern>
      <pattern id="hatchBad" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--hatch-bad);stroke-width:2"></line></pattern>
    </defs>${under.join('')}${parts.join('')}</svg></div>
    <div class="legend">
      ${revs ? `<span>${swatch('border-left:2px dotted var(--accent)')}revision start</span>` : ''}
      ${revs && revisions.length > 1 ? `<span>${swatch('background:color-mix(in srgb, var(--accent) 10%, transparent);border:1px solid color-mix(in srgb, var(--accent) 40%, transparent);border-radius:2px')}selected revision</span>` : ''}
      <span>${swatch('background:color-mix(in srgb, var(--w1) 38%, var(--bg-surface));border:1px solid var(--w1);border-radius:2px')}claimed → done</span>
      <span>${swatch('background:var(--success);border-radius:50%')}finding</span>
      <span>${swatch('background:var(--accent);border-radius:2px')}publish</span>
      <span>${swatch('background:var(--team);transform:rotate(45deg) scale(.8)')}apply</span>
      <span><b style="color:var(--warning)">↩</b> release</span>
      <span><b style="color:var(--error)">×</b> lost claim</span>
      <span>${swatch('border-left:2px dashed var(--text-tertiary)')}status</span>
      <span>${swatch('border-left:2px solid var(--success)')}outcome</span>
      <span>${swatch('border-left:2px dashed var(--warning)')}superseded</span>
      <span>${swatch('border:1.5px dashed var(--error);border-radius:50%')}refused</span>
      <span><b style="color:var(--error)">■</b> stopped</span>
      <span><b style="color:var(--team)">↑</b> woken <b style="color:var(--warning)">↑</b> stall</span>
      <span>${swatch('background:repeating-linear-gradient(45deg,var(--hatch) 0 2px,transparent 2px 5px)')}no board event ≥ 8 min</span>
      <span>${swatch('background:repeating-linear-gradient(45deg,var(--hatch-bad) 0 2px,transparent 2px 5px)')}quiet ≥ 10 min</span>
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
  const vline = (tip, style) =>
    `<line data-tip="${esc(tip)}" x1="${cx}" x2="${cx}" y1="${y + 4}" y2="${y + laneH - 4}" style="${style}"></line>`;
  if (m.type === 'outcome') {
    const old = superseded(m.outcome, m.rev);
    const tip = `outcome ${m.outcome} ${at}${old ? `, under revision ${m.rev}; superseded by revision ${state.model.swarm.revision}` : ''}\n${m.summary}`;
    return vline(tip, old ? 'stroke:var(--warning);stroke-width:2;stroke-dasharray:3 2' : 'stroke:var(--success);stroke-width:2');
  }
  if (m.type === 'refused') {
    const tip = `outcome ${m.outcome ?? '?'} refused ${at}\ndeclared under revision ${m.expected ?? '?'}, current was ${m.rev}`;
    return `<circle data-tip="${esc(tip)}" cx="${cx}" cy="${y + laneH / 2}" r="4.5" style="fill:none;stroke:var(--error);stroke-width:1.5;stroke-dasharray:2 2"></circle>`;
  }
  if (m.type === 'status') {
    const tip = `${m.state}${m.dependency ? ` for ${m.dependency}` : ''}${m.summary ? `: ${m.summary}` : ''} ${at}`;
    return vline(tip, 'stroke:var(--text-tertiary);stroke-width:2;stroke-dasharray:2 2');
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

const findingNote = (f, clamp) => `<div class="note${clamp ? ' clamp' : ''}" style="--wc:${wc(f.actor)}">
        <div class="note-head">${who(f.actor)}<span class="sub">${clock(f.t)} · #${f.id}</span></div>
        <div class="text">${hl(f.text)}</div>
      </div>`;

const filterChips = (names, current, attr) =>
  `<div class="filters">${[null, ...names]
    .map((n) => `<button class="filter${n === current ? ' on' : ''}" data-${attr}="${esc(n ?? '')}">${esc(n ?? 'all')}</button>`)
    .join('')}</div>`;

function knowledgeView() {
  const { findings, releases, workers } = state.model;
  const authors = workers.map((w) => w.name).filter((n) => findings.some((f) => f.actor === n));
  const shown = findings.filter((f) => !state.scope || f.actor === state.scope);
  const filters = filterChips(authors, state.scope, 'scope');
  const list = shown
    .slice()
    .reverse()
    .map((f) => findingNote(f))
    .join('');
  const handoffs = releases
    .slice()
    .reverse()
    .map(
      (r) => `<div class="note" style="--wc:${wc(r.who)}">
        <div class="note-head">${who(r.who)}<span class="sub">released ${hl(`#${r.taskId}`)} · ${clock(r.t)}${r.checkpoint ? ` · checkpoint ${hl(`publication ${r.checkpoint}`)}` : ''}</span></div>
        <div class="text">${hl(r.handoff)}</div>
      </div>`,
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
            if (!h) return '<td class="held muted" title="no publication or apply of this path by this worker in the log">base?</td>';
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
      <div class="card"><div class="section-title"><span>Files per worker, as logged</span></div><div class="scroll"><table class="data-table"><thead><tr><th>path</th>${head}</tr></thead><tbody>${grid}</tbody></table></div></div>
    </div>
    <div class="card"><div class="section-title"><span>Publications</span><span>${publications.length}</span></div>${pubs || '<p class="empty">None.</p>'}</div>
  </div>`;
}

function logView() {
  if (!state.log) return '<p class="loading">Reading the log…</p>';
  return `<div class="card">
    <div class="scroll"><table class="data-table log"><thead><tr><th>seq</th><th class="hide-narrow">time</th><th>worker</th><th>kind</th><th>what happened</th></tr></thead><tbody>
    ${state.log.map((e) => eventRow(e, false)).reverse().join('')}
    </tbody></table></div></div>`;
}

function eventList(list) {
  return `<div class="scroll"><table class="data-table log compact"><tbody>${list.map((e) => eventRow(e, true)).reverse().join('')}</tbody></table></div>`;
}

// `linked`: the seq opens the event in the log, and the row is tied to its mark on the timeline.
function eventRow(e, linked) {
  const { rows } = markup();
  const key = linked ? -e.seq : e.seq;
  let html = rows.get(key);
  if (html == null) {
    const seq = linked ? `<a class="ref" href="#" data-ev="${e.seq}" title="Open in the log">${e.seq}</a>` : e.seq;
    html = `<tr id="ev-${e.seq}"${linked ? ` data-seq="${e.seq}" data-t="${e.t}"` : ''}><td>${seq}</td><td class="hide-narrow">${clock(e.t)}</td><td>${who(e.who)}</td><td><span class="kind k-${esc(e.group)}">${esc(e.kind)}</span></td><td class="payload">${hl(e.text)}</td></tr>`;
    rows.set(key, html);
  }
  return html;
}

const RENDER = {
  summary: summaryView,
  request: requestView,
  queue: queueView,
  timeline: timelineView,
  knowledge: knowledgeView,
  changes: changesView,
  log: logView,
};
// #endregion RENDER

// #region MODAL
const SHORTCUTS = [
  [['1', '…', String(VIEWS.length)], 'Switch the view'],
  [['[', ']'], 'Step the request revisions'],
  [['s'], 'List the swarm runs'],
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

for (const m of [helpModal, swarmsModal]) {
  m.addEventListener('click', (e) => {
    if (e.target === m) m.close();
  });
}
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

// The hovered event is kept, because the timeline redraws on every clock tick.
let hoverSeq = null;
document.addEventListener('pointerover', (e) => {
  const seq = e.target.closest?.('[data-seq]')?.dataset.seq ?? null;
  if (seq === hoverSeq) return;
  hoverSeq = seq;
  markHover();
});

let hovered = [];
function markHover() {
  for (const x of hovered) x.classList.remove('seq-on');
  const cursor = document.querySelector('.tl-cursor');
  if (cursor) cursor.style.display = 'none';
  hovered = hoverSeq == null ? [] : [...document.querySelectorAll(`[data-seq="${hoverSeq}"]`)];
  for (const x of hovered) x.classList.add('seq-on');
  const t = hovered[0]?.dataset.t;
  if (!cursor || t == null) return;
  const at = tlScale().x(Number(t));
  cursor.setAttribute('x1', at);
  cursor.setAttribute('x2', at);
  cursor.style.display = '';
}

// A frame drawn while hidden, such as a background pane tab, gets no window resize when shown.
let resizeTimer = null;
let mainWidth = main.clientWidth;
new ResizeObserver(() => {
  if (main.clientWidth === mainWidth) return;
  mainWidth = main.clientWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => viewOf(state.view).byWidth && render(), 120);
}).observe(main);

document.addEventListener(
  'toggle',
  (e) => {
    const part = e.target.dataset?.part;
    if (!part) return;
    if (e.target.open) state.closed.delete(part);
    else state.closed.add(part);
  },
  true,
);

document.addEventListener('click', (e) => {
  if (!e.target.closest('#themePickerBtn')) toggleThemeMenu(false);
  const el = e.target.closest(
    '[data-view],[data-scope],[data-lane],[data-diff],[data-task],[data-pub],[data-act],[data-rev],[data-sec],[data-mode],[data-fold],[data-color-theme-id],#themePickerBtn,[data-ev],svg.tl [data-seq]',
  );
  if (!el) return;
  if (el.classList.contains('ref') || el.classList.contains('req-row')) e.preventDefault();
  if (el.dataset.rev) {
    showRev(Number(el.dataset.rev));
  } else if (el.dataset.sec) {
    showSec(el.dataset.sec);
  } else if (el.dataset.mode) {
    state.reqMode = el.dataset.mode;
    render();
  } else if (el.dataset.fold) {
    if (el.dataset.fold === 'open') state.closed.clear();
    else for (const x of state.request?.doc.sections ?? []) if (x.name) state.closed.add(x.id);
    render();
  } else if (el.dataset.task) {
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
  } else if (el.dataset.lane != null) {
    state.lane = el.dataset.lane && el.dataset.lane !== state.lane ? el.dataset.lane : null;
    render();
  } else if (el.dataset.ev) {
    reveal('log', `ev-${el.dataset.ev}`);
  } else if (el.dataset.seq) {
    reveal(state.view, `ev-${el.dataset.seq}`);
  } else {
    act(el.dataset.act, el);
  }
});

function act(name, el) {
  if (name === 'help') showHelp();
  else if (name === 'close-help') helpModal.close();
  else if (name === 'swarms') showSwarms();
  else if (name === 'close-swarms') swarmsModal.close();
  else if (name === 'delete-run') deleteRun(el);
  else if (name === 'open-run') {
    swarmsModal.close();
    pickSwarm(el.dataset.run);
  }
  else if (name === 'theme') toggleTheme();
  else if (name === 'refresh') refresh();
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  if (helpModal.open || swarmsModal.open) return;
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
  const keys = { r: 'refresh', t: 'theme', s: 'swarms', '?': 'help' };
  if (keys[e.key]) {
    e.preventDefault();
    return act(keys[e.key]);
  }
  if ((e.key === '[' || e.key === ']') && state.view === 'request' && state.model?.revisions.length) {
    e.preventDefault();
    const list = state.model.revisions.map((r) => r.revision);
    const next = list[list.indexOf(selRev()) + (e.key === ']' ? 1 : -1)];
    if (next != null) showRev(next);
    return;
  }
  const n = Number(e.key);
  if (n >= 1 && n <= VIEWS.length) {
    e.preventDefault();
    setView(VIEWS[n - 1].id);
  }
});
// #endregion EVENTS

// #region INIT
const params = new URLSearchParams(location.search);
state.view = [params.get('view'), stored('view')].find((v) => VIEWS.some((x) => x.id === v)) ?? 'summary';
state.rev = Number(params.get('rev')) || null;
state.sec = params.get('sec');
if (state.view === 'request') state.pending = state.sec ?? (state.rev ? `rev-${state.rev}` : null);
render();
showIfSeen();
if (shown) loadSwarms();
else refresh();
// #endregion INIT

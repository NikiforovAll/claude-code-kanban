const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];
const decl = (name) => new RegExp(`^(let|const) ${name} = .*;$`, 'm').exec(src)[0].replace(/^(let|const) /, 'var ');

const TASKS = [{ id: '1', subject: 'a', status: 'in_progress', owner: 'show-board' }];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function makePage() {
  const replies = new Map();
  const timers = [];
  const ctx = {
    console: { error() {} },
    JSON,
    Object,
    Promise,
    Error,
    Math,
    setTimeout: (f, ms) => timers.push({ f, ms }),
    clearTimeout() {},
    document: { getElementById: () => ({ style: { removeProperty() {} }, classList: { contains: () => false } }) },
    detailPanel: { classList: { contains: () => false } },
    termState: {},
    runningTerminals: new Set(),
    deferredPinPlacement: new Set(),
    ownerColorCache: {},
    teamColorMap: {},
    rendered: [],
    api: (url) => {
      const next = replies.get(url);
      if (!next?.length) throw new Error(`no reply for ${url}`);
      return next.shift()();
    },
    apiPath: (strings, ...values) => strings.reduce((a, s, i) => a + s + (i < values.length ? values[i] : ''), ''),
  };
  for (const f of 'openTerminal terminalOpenMode wantsTerminalFor exitAgentLogMode closeScratchpad closeDetailPanel expandPinnedFor setSwapPair markOpenSessionRead autoRevealLog loadPins resetMessageScrollState resetAgentState updateUrl fetchAgents fetchMessages renderSessions'.split(' '))
    ctx[f] = () => {};
  ctx.renderSession = () => ctx.rendered.push(ctx.currentTasks.length);
  vm.runInNewContext(
    [
      'var viewMode = "none", currentSessionId = null, currentTasks = [], agentLogMode = false;',
      'var revealedPlanSessionId = null, revealedStorageSessionId = null, lastSessionId = null;',
      'var currentPins, ownerFilter = "", sessionJustSelected = false;',
      ...['lastCurrentTasksHash', 'taskFetchSeq', 'taskRetry'].map(decl),
      fn('retryTaskFetch'),
      fn('fetchTasks'),
    ].join('\n'),
    ctx,
  );
  const reply = (url, ...fs) => replies.set(url, [...(replies.get(url) || []), ...fs]);
  return { ctx, reply, timers };
}

const URL_A = '/api/sessions/A';
const URL_B = '/api/sessions/B';

describe('fetchTasks', () => {
  let page;
  beforeEach(async () => {
    page = makePage();
    page.reply(URL_A, () => json(TASKS));
    await page.ctx.fetchTasks('A');
    assert.equal(page.ctx.currentTasks.length, 1);
  });

  it('keeps the shown tasks when a refresh of the open session fails', async () => {
    page.reply(URL_A, () => json({ error: 'x' }, 502));
    await page.ctx.fetchTasks('A');
    assert.equal(page.ctx.currentTasks.length, 1);
    assert.equal(page.ctx.currentSessionId, 'A');
  });

  it('keeps the shown tasks when the request itself throws', async () => {
    page.reply(URL_A, () => Promise.reject(new TypeError('Failed to fetch')));
    await page.ctx.fetchTasks('A');
    assert.equal(page.ctx.currentTasks.length, 1);
  });

  it('retries a failed refresh, since no later event may name the session', async () => {
    page.reply(URL_A, () => json({}, 502), () => json([...TASKS, { id: '2', subject: 'b', status: 'pending' }]));
    await page.ctx.fetchTasks('A');
    assert.equal(page.timers.length, 1);
    await page.timers[0].f();
    assert.equal(page.ctx.currentTasks.length, 2);
  });

  it('does not empty the board when a render throws', async () => {
    page.ctx.renderSessions = () => {
      throw new Error('sidebar render failed');
    };
    page.reply(URL_A, () => json([...TASKS, { id: '2', subject: 'b', status: 'pending' }]));
    await assert.rejects(page.ctx.fetchTasks('A'), /sidebar render failed/);
    assert.equal(page.ctx.currentTasks.length, 2);
    assert.notEqual(page.ctx.rendered.at(-1), 0);
  });

  it('drops a late reply for a session the user already left', async () => {
    let releaseB;
    page.reply(URL_B, () => new Promise((r) => (releaseB = () => r(json([])))));
    page.reply(URL_A, () => json(TASKS));
    const toB = page.ctx.fetchTasks('B');
    await page.ctx.fetchTasks('A');
    releaseB();
    await toB;
    assert.equal(page.ctx.currentSessionId, 'A');
    assert.equal(page.ctx.currentTasks.length, 1);
  });

  it('still opens a session whose fetch fails, with an empty board', async () => {
    page.reply(URL_B, () => json({}, 500));
    await page.ctx.fetchTasks('B');
    assert.equal(page.ctx.currentSessionId, 'B');
    assert.equal(page.ctx.currentTasks.length, 0);
  });
});

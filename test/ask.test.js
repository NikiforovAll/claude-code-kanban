const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAskStore, mountAskRoutes, askBodyParser, ASK_PATH } = require('../lib/ask');

const TOKEN = 't'.repeat(64);
const TERMINAL = 'dddddddd-0000-0000-0000-000000000001';
const OTHER_TERMINAL = 'dddddddd-0000-0000-0000-000000000002';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';

function board() {
  const events = [];
  const store = createAskStore();
  const app = express();
  app.use(ASK_PATH, askBodyParser());
  mountAskRoutes(app, {
    store,
    authorized: (t) => t === TOKEN,
    hasTerminal: (id) => id === TERMINAL,
    readPreviewFile: async (abs) => {
      if (!fs.existsSync(abs)) throw Object.assign(new Error('File not found'), { status: 404 });
      return { content: fs.readFileSync(abs, 'utf8'), kind: abs.endsWith('.html') ? 'html' : 'markdown' };
    },
    broadcast: (e) => events.push(e),
  });
  return { app, store, events };
}

async function listen(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token = TOKEN) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-terminal-token'] = token;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { server, call };
}

const askUrl = (terminalId = TERMINAL) => `/api/terminals/${terminalId}/ask`;

describe('ask routes', () => {
  let root;
  let card;
  let b;
  let api;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-ask-'));
    card = path.join(root, 'card.html');
    fs.writeFileSync(card, '<form data-cck-submit="pick"><button>Send</button></form>');
    fs.writeFileSync(path.join(root, 'card.md'), '# no');
    b = board();
    api = await listen(b.app);
  });

  after(() => {
    api.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const open = () => api.call('POST', askUrl(), { sessionId: A, title: 'Pick a theme', file: card });

  it('refuses a bad token, a dead terminal and a card that is not HTML', async () => {
    assert.equal((await api.call('POST', askUrl(), { sessionId: A, title: 'x', file: card }, 'nope')).status, 401);
    assert.equal((await api.call('POST', askUrl(OTHER_TERMINAL), { sessionId: A, title: 'x', file: card })).status, 404);
    const md = await api.call('POST', askUrl(), { sessionId: A, title: 'x', file: path.join(root, 'card.md') });
    assert.equal(md.status, 400);
    const missing = await api.call('POST', askUrl(), { sessionId: A, title: 'x', file: path.join(root, 'gone.html') });
    assert.equal(missing.status, 400);
    assert.equal((await api.call('POST', askUrl(), { sessionId: A, title: 'x', file: card, size: 'xl' })).status, 400);
  });

  it('opens a question the board reads, and hands the answer to one wait', async () => {
    const { body } = await open();
    assert.ok(body.id);
    assert.deepEqual(b.events.at(-1), { type: 'ask:opened', terminalId: TERMINAL, id: body.id, sessionId: A });
    const got = await api.call('GET', askUrl(), undefined, null);
    assert.equal(got.body.ask.id, body.id);
    assert.equal(got.body.ask.size, 'lg');
    assert.match(got.body.ask.content, /data-cck-submit/);

    const waiting = api.call('GET', `${askUrl()}/${body.id}/wait?ms=5000`);
    const answered = await api.call('POST', `${askUrl()}/${body.id}`, { status: 'answered', data: { theme: 'light' } });
    assert.equal(answered.status, 204);
    assert.deepEqual((await waiting).body, { status: 'answered', data: { theme: 'light' } });
    assert.deepEqual(b.events.at(-1), { type: 'ask:closed', terminalId: TERMINAL, id: body.id, status: 'answered' });
    assert.equal((await api.call('GET', askUrl())).body.ask, null);
    assert.deepEqual((await api.call('GET', `${askUrl()}/${body.id}/wait`)).body, { status: 'gone' });
  });

  it('keeps an answer that lands between two polls for the next one', async () => {
    const { body } = await open();
    assert.deepEqual((await api.call('GET', `${askUrl()}/${body.id}/wait?ms=10`)).body, { status: 'pending' });
    await api.call('POST', `${askUrl()}/${body.id}`, { status: 'dismissed' });
    assert.deepEqual((await api.call('GET', `${askUrl()}/${body.id}/wait?ms=10`)).body, { status: 'dismissed' });
  });

  it('ends the open question when a new one comes', async () => {
    const first = (await open()).body.id;
    const second = (await open()).body.id;
    assert.ok(b.events.some((e) => e.type === 'ask:closed' && e.id === first && e.status === 'dismissed'));
    assert.deepEqual((await api.call('GET', `${askUrl()}/${first}/wait?ms=10`)).body, {
      status: 'dismissed',
      reason: 'replaced',
    });
    assert.equal((await api.call('POST', `${askUrl()}/${first}`, { status: 'dismissed' })).status, 404);
    assert.equal((await api.call('DELETE', `${askUrl()}/${second}`)).status, 204);
    assert.deepEqual((await api.call('GET', `${askUrl()}/${second}/wait?ms=10`)).body, { status: 'cancelled' });
  });

  it('refuses an answer without a status or data', async () => {
    const { body } = await open();
    assert.equal((await api.call('POST', `${askUrl()}/${body.id}`, { status: 'answered' })).status, 400);
    assert.equal((await api.call('POST', `${askUrl()}/${body.id}`, { status: 'maybe' })).status, 400);
    assert.equal((await api.call('POST', `${askUrl()}/${body.id}`, { status: 'answered', data: 'x' }, null)).status, 401);
    await api.call('DELETE', `${askUrl()}/${body.id}`);
  });

  it('dismisses the questions of terminals that ended', async () => {
    const { body } = await open();
    b.store.prune(() => false);
    assert.equal(b.store.current(TERMINAL), null);
    assert.deepEqual(await b.store.wait(body.id, 10), { status: 'dismissed', reason: 'terminal ended' });
  });
});

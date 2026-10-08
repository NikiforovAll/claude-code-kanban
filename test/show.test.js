const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createShowStore, mountShowRoutes, showBodyParser, SHOW_PATH } = require('../lib/show');

const TOKEN = 't'.repeat(64);
const TERMINAL = 'dddddddd-0000-0000-0000-000000000001';
const OTHER_TERMINAL = 'dddddddd-0000-0000-0000-000000000002';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'aaaaaaaa-0000-0000-0000-000000000002';
const UNKNOWN = 'aaaaaaaa-0000-0000-0000-000000000009';

function board(root, saved = {}) {
  const events = [];
  const state = { saves: 0, map: saved };
  const store = createShowStore({
    load: () => state.map,
    onChange: () => { state.saves++; state.map = store.prune(() => true); },
    resolveDir: (id) => ([A, B].includes(id) ? path.join(root, id, 'scratchpad') : null),
  });
  const app = express();
  app.use(SHOW_PATH, showBodyParser());
  app.use(express.json({ limit: '1mb' }));
  mountShowRoutes(app, {
    store,
    authorized: (t) => t === TOKEN,
    hasTerminal: (id) => id === TERMINAL,
    readPreviewFile: async (abs) => {
      if (!fs.existsSync(abs)) throw Object.assign(new Error('File not found'), { status: 404 });
      if (abs.endsWith('.png')) return { content: null, kind: 'image' };
      if (abs.endsWith('.bin')) return { content: null, kind: null };
      return { content: fs.readFileSync(abs, 'utf8'), kind: abs.endsWith('.md') ? 'markdown' : 'text' };
    },
    broadcast: (e) => events.push(e),
  });
  return { app, store, events, state };
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

const showUrl = (terminalId = TERMINAL) => `/api/terminals/${terminalId}/show`;

describe('show routes', () => {
  let root;
  let b;
  let api;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-show-'));
    b = board(root);
    api = await listen(b.app);
  });

  after(() => {
    api.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const showDir = (id) => path.join(root, id, 'scratchpad', '.cck', 'show');

  it('answers an empty card before the first post', async () => {
    const r = await api.call('GET', showUrl());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { sessionId: null, posts: [] });
  });

  it('posts markdown, stores it in the scratchpad and sends show:posted without the content', async () => {
    const r = await api.call('POST', showUrl(), { sessionId: A, title: 'Plan', content: '# Plan' });
    assert.equal(r.status, 200);
    assert.deepEqual({ ...r.body, id: undefined }, { id: undefined, title: 'Plan', key: null, index: 1, count: 1, replaced: false });
    assert.equal(fs.readFileSync(path.join(showDir(A), `${r.body.id}.md`), 'utf8'), '# Plan');
    const index = JSON.parse(fs.readFileSync(path.join(showDir(A), 'index.json'), 'utf8'));
    assert.equal(index.sessionId, A);
    assert.deepEqual(index.posts.map((p) => [p.id, p.kind, p.file]), [[r.body.id, 'markdown', null]]);
    assert.deepEqual(b.events.at(-1), { type: 'show:posted', terminalId: TERMINAL, sessionId: A, ...r.body });

    const got = await api.call('GET', `${showUrl()}/${r.body.id}`);
    assert.deepEqual(got.body, { id: r.body.id, title: 'Plan', key: null, kind: 'markdown', content: '# Plan', file: null, url: null });
  });

  it('replaces a keyed post in place, keeping its id and position', async () => {
    const first = await api.call('POST', showUrl(), { sessionId: A, title: 'Diagram', key: 'arch', content: 'v1' });
    await api.call('POST', showUrl(), { sessionId: A, title: 'Notes', content: 'n' });
    const again = await api.call('POST', showUrl(), { sessionId: A, title: 'Diagram v2', key: 'arch', kind: 'html', content: '<p>v2</p>' });
    assert.deepEqual(again.body, { id: first.body.id, title: 'Diagram v2', key: 'arch', index: 2, count: 3, replaced: true });
    assert.equal(fs.existsSync(path.join(showDir(A), `${first.body.id}.md`)), false);
    const list = await api.call('GET', showUrl());
    assert.deepEqual(list.body.posts.map((p) => p.title), ['Plan', 'Diagram v2', 'Notes']);
    const got = await api.call('GET', `${showUrl()}/${first.body.id}`);
    assert.equal(got.body.kind, 'html');
    assert.equal(got.body.content, '<p>v2</p>');
  });

  it('posts a file by path and reads it on each GET', async () => {
    const md = path.join(root, 'doc.md');
    fs.writeFileSync(md, 'one');
    const png = path.join(root, 'shot.png');
    fs.writeFileSync(png, 'x');
    const r = await api.call('POST', showUrl(), { sessionId: A, title: 'Doc', file: md });
    assert.equal(r.status, 200);
    fs.writeFileSync(md, 'two');
    const got = await api.call('GET', `${showUrl()}/${r.body.id}`);
    assert.deepEqual(got.body, { id: r.body.id, title: 'Doc', key: null, kind: 'markdown', content: 'two', file: md, url: null });

    const img = await api.call('POST', showUrl(), { sessionId: A, title: 'Shot', file: png });
    const gotImg = await api.call('GET', `${showUrl()}/${img.body.id}`);
    assert.equal(gotImg.body.kind, 'image');
    assert.equal(gotImg.body.content, null);
    assert.equal(gotImg.body.url, `/api/preview/image?path=${encodeURIComponent(png)}`);

    fs.rmSync(md);
    assert.equal((await api.call('GET', `${showUrl()}/${r.body.id}`)).status, 404);
  });

  it('refuses a file that is missing or cannot be shown', async () => {
    const missing = await api.call('POST', showUrl(), { sessionId: A, title: 'x', file: path.join(root, 'nope.md') });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /file not found/);
    fs.writeFileSync(path.join(root, 'blob.bin'), 'x');
    assert.equal((await api.call('POST', showUrl(), { sessionId: A, title: 'x', file: path.join(root, 'blob.bin') })).status, 400);
  });

  it('answers 401 without the token, 404 for no live terminal, 409 for no transcript', async () => {
    const body = { sessionId: A, title: 't', content: 'c' };
    const before = b.events.length;
    assert.equal((await api.call('POST', showUrl(), body, null)).status, 401);
    assert.equal((await api.call('POST', showUrl(), body, 'wrong')).status, 401);
    assert.equal((await api.call('DELETE', showUrl(), undefined, 'wrong')).status, 401);
    const gone = await api.call('POST', showUrl(OTHER_TERMINAL), body);
    assert.equal(gone.status, 404);
    assert.equal((await api.call('DELETE', showUrl(OTHER_TERMINAL))).status, 404);
    const unknown = await api.call('POST', showUrl(), { ...body, sessionId: UNKNOWN });
    assert.equal(unknown.status, 409);
    assert.ok(unknown.body.error);
    assert.equal(b.events.length, before);
    assert.equal((await api.call('GET', `${showUrl()}/${'0'.repeat(8)}-0000-0000-0000-000000000000`)).status, 404);
    assert.equal((await api.call('GET', `${showUrl()}/..%2Findex`)).status, 404);
  });

  it('answers 400 for a bad body', async () => {
    const bad = [
      { title: 't', content: 'c' },
      { sessionId: 'nope', title: 't', content: 'c' },
      { sessionId: A, content: 'c' },
      { sessionId: A, title: 't' },
      { sessionId: A, title: 't', content: 'c', file: path.join(root, 'doc.md') },
      { sessionId: A, title: 't', kind: 'svg', content: 'c' },
      { sessionId: A, title: 't', key: 7, content: 'c' },
      { sessionId: A, title: 't', file: 'relative.md' },
    ];
    for (const body of bad) {
      const r = await api.call('POST', showUrl(), body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(typeof r.body.error, 'string');
    }
  });

  it('caps content at 64 KB in UTF-8 bytes, and takes 60 KB of multibyte text', async () => {
    const over = await api.call('POST', showUrl(), { sessionId: A, title: 'big', content: 'x'.repeat(64 * 1024 + 1) });
    assert.equal(over.status, 413);
    assert.equal(over.body.error, 'over 64 KB: write it to a file and pass file');
    const wide = await api.call('POST', showUrl(), { sessionId: A, title: 'big', content: 'é'.repeat(32 * 1024 + 1) });
    assert.equal(wide.status, 413);
    const huge = await api.call('POST', showUrl(), { sessionId: A, title: 'big', content: 'x'.repeat(300 * 1024) });
    assert.equal(huge.status, 413);
    assert.equal(huge.body.error, 'over 64 KB: write it to a file and pass file');

    const text = '漢'.repeat(20 * 1024);
    assert.equal(Buffer.byteLength(text), 60 * 1024);
    const ok = await api.call('POST', showUrl(), { sessionId: A, title: 'wide', content: text });
    assert.equal(ok.status, 200);
    assert.equal((await api.call('GET', `${showUrl()}/${ok.body.id}`)).body.content, text);
  });

  it('switches the card to a new session id and saves the map', async () => {
    const saves = b.state.saves;
    const r = await api.call('POST', showUrl(), { sessionId: B, title: 'After clear', content: 'b' });
    assert.deepEqual({ index: r.body.index, count: r.body.count }, { index: 1, count: 1 });
    assert.equal(b.state.saves, saves + 1);
    assert.deepEqual(b.state.map, { [TERMINAL]: B });
    const list = await api.call('GET', showUrl());
    assert.equal(list.body.sessionId, B);
    assert.deepEqual(list.body.posts.map((p) => p.title), ['After clear']);
    assert.ok(fs.existsSync(path.join(showDir(A), 'index.json')));
    await api.call('POST', showUrl(), { sessionId: B, title: 'Second', content: 'b2' });
    assert.equal(b.state.saves, saves + 1);
  });

  it('reads the posts back after a restart', async () => {
    const before = await api.call('GET', showUrl());
    const again = board(root, b.state.map);
    const api2 = await listen(again.app);
    try {
      const after = await api2.call('GET', showUrl());
      assert.deepEqual(after.body, before.body);
      const id = after.body.posts[0].id;
      assert.equal((await api2.call('GET', `${showUrl()}/${id}`)).body.content, 'b');
    } finally {
      api2.server.close();
    }
  });

  it('DELETE removes the current session\'s show folder and sends show:cleared', async () => {
    const r = await api.call('DELETE', showUrl());
    assert.equal(r.status, 204);
    assert.equal(fs.existsSync(showDir(B)), false);
    assert.ok(fs.existsSync(showDir(A)));
    assert.deepEqual(b.events.at(-1), { type: 'show:cleared', terminalId: TERMINAL, sessionId: B });
    assert.deepEqual((await api.call('GET', showUrl())).body, { sessionId: B, posts: [] });
  });
});

describe('show store', () => {
  it('drops saved entries that are not ids, and prunes terminals that are gone', () => {
    const store = createShowStore({
      load: () => ({ [TERMINAL]: A, [OTHER_TERMINAL]: B, junk: A, [`${TERMINAL}x`]: 'nope' }),
      onChange: () => {},
      resolveDir: () => null,
    });
    assert.equal(store.sessionOf(TERMINAL), A);
    assert.equal(store.sessionOf('junk'), null);
    assert.deepEqual(store.prune((id) => id === TERMINAL), { [TERMINAL]: A });
    assert.equal(store.sessionOf(OTHER_TERMINAL), null);
  });
});

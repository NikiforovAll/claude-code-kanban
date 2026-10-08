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
  const state = { saves: 0, map: saved, removed: [] };
  const store = createShowStore({
    load: () => state.map,
    onChange: () => { state.saves++; state.map = store.prune(() => true); },
    resolveDir: (id) => ([A, B].includes(id) ? path.join(root, id, 'scratchpad') : null),
    onPosted: (e) => events.push({ type: 'show:posted', ...e }),
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
    onRemoved: (sessionId, paths) => state.removed.push({ sessionId, paths }),
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

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

// Writes a claim's file and waits for its refresh, so no late event lands in a later check.
async function write(b, post, text) {
  const since = b.events.length;
  fs.writeFileSync(post.path, text);
  assert.ok(await until(() => b.events.slice(since).some((e) => e.type === 'show:posted' && e.id === post.id)));
}

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
    b.store.prune(() => false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const showDir = (id) => path.join(root, id, 'scratchpad', '.cck', 'show');

  it('answers an empty card before the first post', async () => {
    const r = await api.call('GET', showUrl());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { sessionId: null, posts: [] });
  });

  it('claims a markdown card in the scratchpad and sends show:posted without the content', async () => {
    const r = await api.call('POST', showUrl(), { sessionId: A, title: 'Plan' });
    assert.equal(r.status, 200);
    const file = path.join(showDir(A), `${r.body.id}.md`);
    assert.deepEqual({ ...r.body, id: undefined }, { id: undefined, title: 'Plan', key: null, index: 1, count: 1, replaced: false, path: file });
    const index = JSON.parse(fs.readFileSync(path.join(showDir(A), 'index.json'), 'utf8'));
    assert.equal(index.sessionId, A);
    assert.deepEqual(index.posts.map((p) => [p.id, p.kind, p.file]), [[r.body.id, 'markdown', null]]);
    const { path: _, ...shown } = r.body;
    assert.deepEqual(b.events.at(-1), { type: 'show:posted', terminalId: TERMINAL, sessionId: A, ...shown });

    await write(b, r.body, '# Plan');
    const got = await api.call('GET', `${showUrl()}/${r.body.id}`);
    assert.deepEqual(got.body, { id: r.body.id, title: 'Plan', key: null, kind: 'markdown', content: '# Plan', file: null, path: file, url: null });
  });

  it('replaces a keyed post in place, keeping its id and position', async () => {
    const first = await api.call('POST', showUrl(), { sessionId: A, title: 'Diagram', key: 'arch' });
    await write(b, first.body, 'v1');
    await write(b, (await api.call('POST', showUrl(), { sessionId: A, title: 'Notes' })).body, 'n');
    const again = await api.call('POST', showUrl(), { sessionId: A, title: 'Diagram v2', key: 'arch', kind: 'html' });
    const html = path.join(showDir(A), `${first.body.id}.html`);
    assert.deepEqual(again.body, { id: first.body.id, title: 'Diagram v2', key: 'arch', index: 2, count: 3, replaced: true, path: html });
    assert.equal(fs.existsSync(path.join(showDir(A), `${first.body.id}.md`)), false);
    await write(b, again.body, '<p>v2</p>');
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
    assert.equal(r.body.path, null);
    fs.writeFileSync(md, 'two');
    const got = await api.call('GET', `${showUrl()}/${r.body.id}`);
    assert.deepEqual(got.body, { id: r.body.id, title: 'Doc', key: null, kind: 'markdown', content: 'two', file: md, path: md, url: null });

    const img = await api.call('POST', showUrl(), { sessionId: A, title: 'Shot', file: png });
    const gotImg = await api.call('GET', `${showUrl()}/${img.body.id}`);
    assert.equal(gotImg.body.kind, 'image');
    assert.equal(gotImg.body.content, null);
    assert.equal(gotImg.body.url, `/api/preview/image?path=${encodeURIComponent(png)}`);

    fs.rmSync(md);
    assert.equal((await api.call('GET', `${showUrl()}/${r.body.id}`)).status, 404);
  });

  it('draws an SVG file as HTML without its prolog', async () => {
    const svg = path.join(root, 'pic.svg');
    fs.writeFileSync(svg, '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg viewBox="0 0 2 1"/>');
    const r = await api.call('POST', showUrl(), { sessionId: A, title: 'Pic', file: svg });
    const got = await api.call('GET', `${showUrl()}/${r.body.id}`);
    assert.equal(got.body.kind, 'html');
    assert.equal(got.body.content, '\n<svg viewBox="0 0 2 1"/>');
  });

  it('refuses a file that is missing or cannot be shown', async () => {
    const missing = await api.call('POST', showUrl(), { sessionId: A, title: 'x', file: path.join(root, 'nope.md') });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /file not found/);
    fs.writeFileSync(path.join(root, 'blob.bin'), 'x');
    assert.equal((await api.call('POST', showUrl(), { sessionId: A, title: 'x', file: path.join(root, 'blob.bin') })).status, 400);
  });

  it('answers 401 without the token, 404 for no live terminal, 409 for no transcript', async () => {
    const body = { sessionId: A, title: 't' };
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
      { title: 't' },
      { sessionId: 'nope', title: 't' },
      { sessionId: A },
      { sessionId: A, title: 't', kind: 'svg' },
      { sessionId: A, title: 't', key: 7 },
      { sessionId: A, title: 't', file: 'relative.md' },
    ];
    for (const body of bad) {
      const r = await api.call('POST', showUrl(), body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(typeof r.body.error, 'string');
    }
  });

  it('refuses inline content and names the claim form', async () => {
    const r = await api.call('POST', showUrl(), { sessionId: A, title: 't', content: 'c' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /call show without file to get a file/);
  });

  it('switches the card to a new session id and saves the map', async () => {
    const saves = b.state.saves;
    const r = await api.call('POST', showUrl(), { sessionId: B, title: 'After clear' });
    await write(b, r.body, 'b');
    assert.deepEqual({ index: r.body.index, count: r.body.count }, { index: 1, count: 1 });
    assert.equal(b.state.saves, saves + 1);
    assert.deepEqual(b.state.map, { [TERMINAL]: B });
    const list = await api.call('GET', showUrl());
    assert.equal(list.body.sessionId, B);
    assert.deepEqual(list.body.posts.map((p) => p.title), ['After clear']);
    assert.ok(fs.existsSync(path.join(showDir(A), 'index.json')));
    await write(b, (await api.call('POST', showUrl(), { sessionId: B, title: 'Second' })).body, 'b2');
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

  it('DELETE of one post drops it and its file and sends show:removed', async () => {
    const posts = (await api.call('GET', showUrl())).body.posts;
    const id = posts.find((p) => p.title === 'Second').id;
    const url = `${showUrl()}/${id}`;
    assert.equal((await api.call('DELETE', url, undefined, 'wrong')).status, 401);
    assert.equal((await api.call('DELETE', `${showUrl(OTHER_TERMINAL)}/${id}`)).status, 404);
    assert.equal((await api.call('DELETE', url)).status, 204);
    assert.deepEqual(b.events.at(-1), { type: 'show:removed', terminalId: TERMINAL, sessionId: B, id, count: posts.length - 1 });
    assert.deepEqual(b.state.removed.at(-1), { sessionId: B, paths: [path.join(showDir(B), `${id}.md`)] });
    assert.equal(fs.existsSync(path.join(showDir(B), `${id}.md`)), false);
    assert.deepEqual((await api.call('GET', showUrl())).body.posts.map((p) => p.title), ['After clear']);
    assert.equal((await api.call('GET', url)).status, 404);
    assert.equal((await api.call('DELETE', url)).status, 404);
  });

  it('DELETE of one file post keeps the session\'s file', async () => {
    const file = path.join(root, 'keep.md');
    fs.writeFileSync(file, '# keep');
    const r = await api.call('POST', showUrl(), { sessionId: B, title: 'File', file });
    assert.equal((await api.call('DELETE', `${showUrl()}/${r.body.id}`)).status, 204);
    assert.deepEqual(b.state.removed.at(-1), { sessionId: B, paths: [file] });
    assert.ok(fs.existsSync(file));
  });

  it('DELETE removes the current session\'s show folder and sends show:cleared', async () => {
    const [left] = (await api.call('GET', showUrl())).body.posts;
    const r = await api.call('DELETE', showUrl());
    assert.deepEqual(b.state.removed.at(-1), { sessionId: B, paths: [path.join(showDir(B), `${left.id}.md`)] });
    assert.equal(r.status, 204);
    assert.equal(fs.existsSync(showDir(B)), false);
    assert.ok(fs.existsSync(showDir(A)));
    assert.deepEqual(b.events.at(-1), { type: 'show:cleared', terminalId: TERMINAL, sessionId: B });
    assert.deepEqual((await api.call('GET', showUrl())).body, { sessionId: B, posts: [] });
  });
});

describe('show claims', () => {
  let root;
  let b;
  let api;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-show-claim-'));
    b = board(root);
    api = await listen(b.app);
  });

  after(() => {
    api.server.close();
    b.store.prune(() => false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const refreshes = (id, since) => b.events.slice(since).filter((e) => e.id === id && e.type === 'show:posted');

  it('names a file it does not create, and the card waits for it', async () => {
    const r = await api.call('POST', showUrl(), { sessionId: A, title: 'Plan', key: 'plan' });
    assert.equal(r.status, 200);
    assert.equal(r.body.path, path.join(root, A, 'scratchpad', '.cck', 'show', `${r.body.id}.md`));
    assert.equal(fs.existsSync(r.body.path), false);
    const got = await api.call('GET', `${showUrl()}/${r.body.id}`);
    assert.equal(got.body.waiting, true);
    assert.equal(got.body.content, null);
  });

  it('refreshes the card on each write, once per settled save', async () => {
    const { body: claim } = await api.call('POST', showUrl(), { sessionId: A, title: 'Plan', key: 'plan' });
    const since = b.events.length;
    fs.writeFileSync(claim.path, '# v1');
    fs.appendFileSync(claim.path, '\nmore');
    assert.ok(await until(() => refreshes(claim.id, since).length === 1));
    const ev = refreshes(claim.id, since)[0];
    assert.deepEqual(ev, { type: 'show:posted', terminalId: TERMINAL, sessionId: A, id: claim.id, title: 'Plan', key: 'plan', index: 1, count: 1, replaced: true });
    assert.equal((await api.call('GET', `${showUrl()}/${claim.id}`)).body.content, '# v1\nmore');

    const before = (await api.call('GET', showUrl())).body.posts[0].updatedAt;
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(claim.path, '# v2');
    assert.ok(await until(() => refreshes(claim.id, since).length === 2));
    assert.notEqual((await api.call('GET', showUrl())).body.posts[0].updatedAt, before);
  });

  it('keeps the file on a second claim with the same key, and renames it for a new kind', async () => {
    const { body: md } = await api.call('POST', showUrl(), { sessionId: A, title: 'Plan', key: 'plan' });
    assert.equal(fs.readFileSync(md.path, 'utf8'), '# v2');
    const { body: html } = await api.call('POST', showUrl(), { sessionId: A, title: 'Plan', key: 'plan', kind: 'html' });
    assert.equal(html.id, md.id);
    assert.equal(html.path, md.path.replace(/\.md$/, '.html'));
    assert.equal(fs.existsSync(md.path), false);
    assert.equal(fs.readFileSync(html.path, 'utf8'), '# v2');
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

// The show overlay's server side: posts a terminal's session makes through the plugin's show tool.
// The card belongs to the terminal and the posts to the session, so the store maps terminal id
// to its current session and keeps each session's posts in <scratchpad>/.cck/show/.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { httpError } = require('./http-error');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOW_PATH = '/api/terminals/:terminalId/show';
// 64 KB is about 16k output tokens that stay in the posting session's context.
const MAX_CONTENT_BYTES = 64 * 1024;
const BODY_LIMIT = '256kb';
const OVER_CAP = 'over 64 KB: write it to a file and pass file';
const MAX_LABEL = 200;
const EXT = { markdown: 'md', html: 'html' };

function isLabel(v) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_LABEL;
}

// A string is a reason the body is refused.
function parsePost(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const { sessionId, title, key, kind = 'markdown', content, file } = body;
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return 'invalid sessionId';
  if (!isLabel(title)) return `title must be a non-empty string of at most ${MAX_LABEL} characters`;
  if (key != null && !isLabel(key)) return `key must be a non-empty string of at most ${MAX_LABEL} characters`;
  if (!Object.hasOwn(EXT, kind)) return 'kind must be markdown or html';
  if ((content == null) === (file == null)) return 'pass exactly one of content and file';
  if (content != null && typeof content !== 'string') return 'content must be a string';
  if (file != null && (typeof file !== 'string' || !path.isAbsolute(file))) return 'file must be an absolute path';
  return { sessionId, title, key: key ?? null, kind, content: content ?? null, file: file ?? null };
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * @param {object} o
 * @param {() => Object<string, string>|null} o.load  terminal id → session id, as saved
 * @param {() => void} o.onChange  the map changed and should be saved
 * @param {(sessionId: string) => string|null} o.resolveDir  the session's scratchpad, null when its transcript is unknown
 * @param {() => number} [o.now]
 */
function createShowStore(o) {
  const now = o.now || Date.now;
  const current = new Map();
  for (const [terminalId, sessionId] of Object.entries(o.load?.() || {})) {
    if (UUID_RE.test(terminalId) && typeof sessionId === 'string' && UUID_RE.test(sessionId)) current.set(terminalId, sessionId);
  }

  function folder(sessionId) {
    const dir = o.resolveDir(sessionId);
    return dir ? path.join(dir, '.cck', 'show') : null;
  }

  function readPosts(dir) {
    try {
      const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
      if (Array.isArray(index.posts)) return index.posts;
    } catch { /* no posts yet */ }
    return [];
  }

  function removeContent(dir, id) {
    for (const ext of Object.values(EXT)) fs.rmSync(path.join(dir, `${id}.${ext}`), { force: true });
  }

  function sessionOf(terminalId) {
    return current.get(terminalId) || null;
  }

  // `kind` of a file post is the one readPreviewFile gave when it was posted.
  function post(terminalId, { sessionId, title, key, kind, content, file }) {
    const dir = folder(sessionId);
    if (!dir) throw httpError(409, 'no transcript found for that session');
    fs.mkdirSync(dir, { recursive: true });
    const posts = readPosts(dir);
    let at = key == null ? -1 : posts.findIndex((p) => p.key === key);
    const replaced = at >= 0;
    const id = replaced ? posts[at].id : crypto.randomUUID();
    if (replaced) removeContent(dir, id);
    if (content != null) fs.writeFileSync(path.join(dir, `${id}.${EXT[kind]}`), content, 'utf8');
    const entry = { id, title, key, kind, file, updatedAt: new Date(now()).toISOString() };
    if (replaced) posts[at] = entry;
    else at = posts.push(entry) - 1;
    writeAtomic(path.join(dir, 'index.json'), JSON.stringify({ sessionId, posts }, null, 2));
    if (current.get(terminalId) !== sessionId) {
      current.set(terminalId, sessionId);
      o.onChange();
    }
    return { id, title, key, index: at + 1, count: posts.length, replaced };
  }

  function list(terminalId) {
    const sessionId = sessionOf(terminalId);
    if (!sessionId) return { sessionId: null, posts: [] };
    const dir = folder(sessionId);
    return { sessionId, posts: dir ? readPosts(dir) : [] };
  }

  // The post's index entry, and its inline content; null when either is gone.
  function get(terminalId, postId) {
    const sessionId = sessionOf(terminalId);
    const dir = sessionId && UUID_RE.test(postId) ? folder(sessionId) : null;
    const entry = dir && readPosts(dir).find((p) => p.id === postId);
    if (!entry) return null;
    if (entry.file) return { entry, content: null };
    try {
      return { entry, content: fs.readFileSync(path.join(dir, `${entry.id}.${EXT[entry.kind]}`), 'utf8') };
    } catch {
      return null;
    }
  }

  function clear(terminalId) {
    const sessionId = sessionOf(terminalId);
    const dir = sessionId && folder(sessionId);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return sessionId;
  }

  // Drops the terminals that `keep` no longer knows, and gives the map to save.
  function prune(keep) {
    for (const terminalId of current.keys()) if (!keep(terminalId)) current.delete(terminalId);
    return Object.fromEntries(current);
  }

  return { sessionOf, post, list, get, clear, prune };
}

// Mounted before the global JSON parser: the parser that runs first owns the body.
function showBodyParser() {
  const parse = express.json({ limit: BODY_LIMIT });
  return (req, res, next) => parse(req, res, (err) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: OVER_CAP });
    next(err);
  });
}

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {ReturnType<typeof createShowStore>} o.store
 * @param {(token: string|undefined) => boolean} o.authorized  the terminal token
 * @param {(terminalId: string) => boolean} o.hasTerminal  a live terminal has this id
 * @param {(absPath: string) => Promise<{content: string|null, kind: string|null}>} o.readPreviewFile
 * @param {(event: object) => void} o.broadcast
 */
function mountShowRoutes(app, o) {
  const { store } = o;

  function guard(req, res) {
    if (!o.authorized(req.get('x-terminal-token'))) return res.status(401).json({ error: 'invalid terminal token' });
    if (!o.hasTerminal(req.params.terminalId)) return res.status(404).json({ error: 'no live terminal with that id' });
    return null;
  }

  async function readFilePost(file) {
    let read;
    try {
      read = await o.readPreviewFile(file);
    } catch (e) {
      if (e.status === 404) throw httpError(404, `file not found: ${file}`);
      throw e;
    }
    if (!read.kind) throw httpError(400, 'not a markdown, HTML, text or image file');
    return read;
  }

  const route = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (res.headersSent) return;
    if (!e.status) console.error(`Error in ${req.method} ${req.path}:`, e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Internal error' });
  });

  app.post(SHOW_PATH, route(async (req, res) => {
    if (guard(req, res)) return;
    const p = parsePost(req.body);
    if (typeof p === 'string') return res.status(400).json({ error: p });
    if (p.content != null && Buffer.byteLength(p.content, 'utf8') > MAX_CONTENT_BYTES) return res.status(413).json({ error: OVER_CAP });
    if (p.file) {
      try {
        p.kind = (await readFilePost(p.file)).kind;
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }
    const r = store.post(req.params.terminalId, p);
    o.broadcast({ type: 'show:posted', terminalId: req.params.terminalId, sessionId: p.sessionId, ...r });
    res.json(r);
  }));

  app.get(SHOW_PATH, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(store.list(req.params.terminalId));
  });

  app.get(`${SHOW_PATH}/:postId`, route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const found = store.get(req.params.terminalId, req.params.postId);
    if (!found) return res.status(404).json({ error: 'no such post' });
    const { entry } = found;
    const out = { id: entry.id, title: entry.title, key: entry.key, kind: entry.kind, content: found.content, file: entry.file, url: null };
    if (entry.file) {
      const { content, kind } = await readFilePost(entry.file);
      out.kind = kind;
      out.content = content;
      if (kind === 'image') out.url = `/api/preview/image?path=${encodeURIComponent(entry.file)}`;
    }
    res.json(out);
  }));

  app.delete(SHOW_PATH, route(async (req, res) => {
    if (guard(req, res)) return;
    const sessionId = store.clear(req.params.terminalId);
    if (sessionId) o.broadcast({ type: 'show:cleared', terminalId: req.params.terminalId, sessionId });
    res.status(204).end();
  }));
}

module.exports = { createShowStore, mountShowRoutes, showBodyParser, parsePost, SHOW_PATH, MAX_CONTENT_BYTES };

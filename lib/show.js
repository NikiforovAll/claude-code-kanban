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
const BODY_LIMIT = '16kb';
const MAX_LABEL = 200;
const EXT = { markdown: 'md', html: 'html' };
const CONTENT_FILE_RE = new RegExp(`^(${UUID_RE.source.slice(1, -1)})\\.(md|html)$`, 'i');
// An editor can save in two steps, so a refresh waits for the writes to settle.
const SETTLE_MS = 200;

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
  if (content != null) return 'content is not accepted: call show with only title and key to get a file to write the card into';
  if (file != null && (typeof file !== 'string' || !path.isAbsolute(file))) return 'file must be an absolute path';
  return { sessionId, title, key: key ?? null, kind, file: file ?? null };
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
 * @param {(terminalId: string) => string|null} [o.startedSession]  the session a live terminal was started with
 * @param {(e: object) => void} [o.onPosted]  a post was made or its file changed on disk, once per terminal showing its session
 * @param {() => number} [o.now]
 */
function createShowStore(o) {
  const now = o.now || Date.now;
  const current = new Map();
  const watchers = new Map();
  // Post id → the claim file's mtime as cck last saw it, so a second watch event for one save is not a change.
  const seen = new Map();
  for (const [terminalId, sessionId] of Object.entries(o.load?.() || {})) {
    if (UUID_RE.test(terminalId) && typeof sessionId === 'string' && UUID_RE.test(sessionId)) current.set(terminalId, sessionId);
  }

  function folder(sessionId) {
    const dir = o.resolveDir(sessionId);
    return dir ? path.join(dir, '.cck', 'show') : null;
  }

  function contentPath(dir, entry) {
    return path.join(dir, `${entry.id}.${EXT[entry.kind]}`);
  }

  function postPath(dir, entry) {
    return entry.file || contentPath(dir, entry);
  }

  function locate(terminalId, postId) {
    const sessionId = sessionOf(terminalId);
    const dir = sessionId && UUID_RE.test(postId) ? folder(sessionId) : null;
    const posts = dir ? readPosts(dir) : [];
    return { sessionId, dir, posts, at: posts.findIndex((p) => p.id === postId) };
  }

  function writeIndex(dir, sessionId, posts) {
    writeAtomic(path.join(dir, 'index.json'), JSON.stringify({ sessionId, posts }, null, 2));
  }

  function notify(sessionId, entry, at, count, replaced) {
    if (!o.onPosted) return;
    for (const [terminalId, s] of current) {
      if (s !== sessionId) continue;
      o.onPosted({ terminalId, sessionId, id: entry.id, title: entry.title, key: entry.key, index: at + 1, count, replaced });
    }
  }

  function touch(sessionId, dir, postId) {
    const posts = readPosts(dir);
    const at = posts.findIndex((p) => p.id === postId);
    const entry = posts[at];
    if (!entry || entry.file) return;
    let mtime;
    try {
      mtime = fs.statSync(contentPath(dir, entry)).mtimeMs;
    } catch {
      return;
    }
    if (mtime === seen.get(postId)) return;
    seen.set(postId, mtime);
    entry.updatedAt = new Date(now()).toISOString();
    writeIndex(dir, sessionId, posts);
    notify(sessionId, entry, at, posts.length, true);
  }

  function watch(sessionId, dir) {
    if (!o.onPosted || watchers.has(sessionId)) return;
    let w;
    try {
      // libuv aborts the process on a change under an 8.3 short path (NIKIFO~1), so watch the long form.
      w = fs.watch(fs.realpathSync.native(dir));
    } catch {
      return;
    }
    w.unref();
    const timers = new Map();
    // A watch left on a deleted folder keeps the process from exiting on Windows.
    w.on('change', (event, name) => {
      if (event === 'rename' && !fs.existsSync(dir)) return unwatch(sessionId);
      const id = CONTENT_FILE_RE.exec(String(name ?? ''))?.[1];
      if (!id) return;
      clearTimeout(timers.get(id));
      const t = setTimeout(() => {
        timers.delete(id);
        try {
          touch(sessionId, dir, id);
        } catch (e) {
          console.error('[show] refresh failed:', e.message);
        }
      }, SETTLE_MS);
      t.unref();
      timers.set(id, t);
    });
    w.on('error', () => unwatch(sessionId));
    watchers.set(sessionId, () => {
      for (const t of timers.values()) clearTimeout(t);
      w.close();
    });
  }

  function unwatch(sessionId) {
    watchers.get(sessionId)?.();
    watchers.delete(sessionId);
  }

  function unwatchUnused() {
    const used = new Set(current.values());
    for (const sessionId of watchers.keys()) if (!used.has(sessionId)) unwatch(sessionId);
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

  // A session resumed in a new terminal gets a new terminal id, so a terminal with no posts yet
  // takes the posts of the session it was started with.
  function sessionOf(terminalId) {
    const known = current.get(terminalId);
    if (known) return known;
    const started = o.startedSession?.(terminalId);
    const dir = started && UUID_RE.test(started) ? folder(started) : null;
    if (!dir || !readPosts(dir).length) return null;
    bind(terminalId, started);
    return started;
  }

  function bind(terminalId, sessionId) {
    if (current.get(terminalId) === sessionId) return;
    current.set(terminalId, sessionId);
    unwatchUnused();
    o.onChange();
  }

  // `kind` of a file post is the one readPreviewFile gave when it was posted. A post without a file
  // is a claim: cck names the file and the session writes it. cck does not create it, because
  // Claude Code's Write refuses to overwrite a file the session has not read.
  function post(terminalId, { sessionId, title, key, kind, file }) {
    const dir = folder(sessionId);
    if (!dir) throw httpError(409, 'no transcript found for that session');
    fs.mkdirSync(dir, { recursive: true });
    const posts = readPosts(dir);
    let at = key == null ? -1 : posts.findIndex((p) => p.key === key);
    const old = at >= 0 ? posts[at] : null;
    const id = old ? old.id : crypto.randomUUID();
    const target = file == null ? contentPath(dir, { id, kind }) : null;
    if (target && old && !old.file) {
      const from = contentPath(dir, old);
      if (from !== target && fs.existsSync(from)) fs.renameSync(from, target);
    } else if (old) {
      removeContent(dir, id);
      seen.delete(id);
    }
    if (!old) at = posts.length;
    const entry = { id, title, key, kind, file, updatedAt: new Date(now()).toISOString() };
    posts[at] = entry;
    writeIndex(dir, sessionId, posts);
    bind(terminalId, sessionId);
    watch(sessionId, dir);
    notify(sessionId, entry, at, posts.length, !!old);
    return { id, title, key, index: at + 1, count: posts.length, replaced: !!old, path: target };
  }

  function list(terminalId) {
    const sessionId = sessionOf(terminalId);
    if (!sessionId) return { sessionId: null, posts: [] };
    const dir = folder(sessionId);
    const posts = dir ? readPosts(dir) : [];
    if (posts.length) watch(sessionId, dir);
    return { sessionId, posts };
  }

  // The post's index entry and its stored content; `waiting` when a claim file is not written yet.
  function get(terminalId, postId) {
    const { dir, posts, at } = locate(terminalId, postId);
    if (at < 0) return null;
    const entry = posts[at];
    const file = postPath(dir, entry);
    if (entry.file) return { entry, content: null, path: file };
    try {
      return { entry, content: fs.readFileSync(file, 'utf8'), path: file };
    } catch {
      return { entry, content: null, path: file, waiting: true };
    }
  }

  // Returns the session and the paths of the posts it had.
  function clear(terminalId) {
    const sessionId = sessionOf(terminalId);
    const dir = sessionId && folder(sessionId);
    const paths = [];
    if (dir) {
      unwatch(sessionId);
      for (const p of readPosts(dir)) {
        seen.delete(p.id);
        paths.push(postPath(dir, p));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { sessionId, paths };
  }

  // A file post's file belongs to the session, so only cck's own copy is deleted.
  function remove(terminalId, postId) {
    const { sessionId, dir, posts, at } = locate(terminalId, postId);
    if (at < 0) return null;
    const [entry] = posts.splice(at, 1);
    writeIndex(dir, sessionId, posts);
    removeContent(dir, postId);
    seen.delete(postId);
    return { sessionId, count: posts.length, path: postPath(dir, entry) };
  }

  // Drops the terminals that `keep` no longer knows, and gives the map to save.
  function prune(keep) {
    for (const terminalId of current.keys()) if (!keep(terminalId)) current.delete(terminalId);
    unwatchUnused();
    return Object.fromEntries(current);
  }

  return { sessionOf, post, list, get, clear, remove, prune };
}

// Mounted before the global JSON parser: the parser that runs first owns the body.
function showBodyParser() {
  return express.json({ limit: BODY_LIMIT });
}

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {ReturnType<typeof createShowStore>} o.store
 * @param {(token: string|undefined) => boolean} o.authorized  the terminal token
 * @param {(terminalId: string) => boolean} o.hasTerminal  a live terminal has this id
 * @param {(absPath: string) => Promise<{content: string|null, kind: string|null}>} o.readPreviewFile
 * @param {(event: object) => void} o.broadcast
 * @param {(sessionId: string, paths: string[]) => void} [o.onRemoved]  posts left the card; their files' panes go too
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
    // The previewer shows SVG as source; the card draws it in its sandboxed frame. The prolog
    // would read as a whole document there.
    if (read.kind === 'text' && /\.svg$/i.test(file)) {
      return { kind: 'html', content: read.content.replace(/^(?:\s*(?:<\?xml[\s\S]*?\?>|<!doctype[^>]*>))*/i, '') };
    }
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
    if (p.file) {
      try {
        p.kind = (await readFilePost(p.file)).kind;
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }
    res.json(store.post(req.params.terminalId, p));
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
    const out = { id: entry.id, title: entry.title, key: entry.key, kind: entry.kind, content: found.content, file: entry.file, path: found.path, url: null };
    if (found.waiting) out.waiting = true;
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
    const { sessionId, paths } = store.clear(req.params.terminalId);
    if (sessionId) {
      o.broadcast({ type: 'show:cleared', terminalId: req.params.terminalId, sessionId });
      if (paths.length) o.onRemoved?.(sessionId, paths);
    }
    res.status(204).end();
  }));

  app.delete(`${SHOW_PATH}/:postId`, route(async (req, res) => {
    if (guard(req, res)) return;
    const { terminalId, postId } = req.params;
    const removed = store.remove(terminalId, postId);
    if (!removed) return res.status(404).json({ error: 'no such post' });
    o.broadcast({ type: 'show:removed', terminalId, sessionId: removed.sessionId, id: postId, count: removed.count });
    o.onRemoved?.(removed.sessionId, [removed.path]);
    res.status(204).end();
  }));
}

module.exports = { createShowStore, mountShowRoutes, showBodyParser, parsePost, SHOW_PATH };

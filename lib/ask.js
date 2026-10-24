// The ask modal's server side: one open question per terminal, from the plugin's ask tool. The tool's
// call waits on it, long-polling /wait until the board answers, the user skips, or the agent is
// interrupted. Nothing is written to disk: a question outlives neither the board nor its terminal.

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { httpError } = require('./http-error');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASK_PATH = '/api/terminals/:terminalId/ask';
// The answer of a playground card is its whole state.
const BODY_LIMIT = '256kb';
const MAX_LABEL = 200;
const SIZES = ['md', 'lg', 'full'];
// $.http.fetch gives up after 30 s, so a wait answers pending before that.
const WAIT_MAX_MS = 25_000;
// An answer that lands between two polls waits this long for the next one.
const DONE_TTL_MS = 60_000;

function parseAsk(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const { sessionId, title, file, size = 'lg' } = body;
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return 'invalid sessionId';
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_LABEL) {
    return `title must be a non-empty string of at most ${MAX_LABEL} characters`;
  }
  if (typeof file !== 'string' || !path.isAbsolute(file)) return 'file must be an absolute path';
  if (!SIZES.includes(size)) return `size must be one of ${SIZES.join(', ')}`;
  return { sessionId, title, file, size };
}

// A string is a reason the body is refused.
function parseAnswer(body) {
  const { status, data } = body || {};
  if (status === 'dismissed') return { status };
  if (status !== 'answered') return 'status must be answered or dismissed';
  if (data === undefined) return 'an answer needs data';
  return { status, data };
}

/**
 * @param {object} [o]
 * @param {() => number} [o.now]
 */
function createAskStore(o = {}) {
  const now = o.now || Date.now;
  const open = new Map();
  const done = new Map();
  const waiters = new Map();

  function sweep() {
    const t = now();
    for (const [id, d] of done) if (t - d.at > DONE_TTL_MS) done.delete(id);
  }

  function settle(ask, result) {
    open.delete(ask.terminalId);
    done.set(ask.id, { result, at: now() });
    for (const w of waiters.get(ask.id) || []) w(result);
    waiters.delete(ask.id);
  }

  // A new question ends the open one, so the board never holds two.
  function ask(terminalId, { sessionId, title, file, size }) {
    sweep();
    const old = open.get(terminalId);
    if (old) settle(old, { status: 'dismissed', reason: 'replaced' });
    const entry = { id: crypto.randomUUID(), terminalId, sessionId, title, file, size, at: now() };
    open.set(terminalId, entry);
    return { entry, replaced: old?.id ?? null };
  }

  function current(terminalId) {
    return open.get(terminalId) || null;
  }

  function end(terminalId, askId, result) {
    const entry = open.get(terminalId);
    if (!entry || entry.id !== askId) return false;
    settle(entry, result);
    return true;
  }

  // Resolves the result once, or pending after `ms`; an unknown id is gone.
  function wait(askId, ms) {
    const d = done.get(askId);
    if (d) {
      done.delete(askId);
      return Promise.resolve(d.result);
    }
    if (![...open.values()].some((a) => a.id === askId)) return Promise.resolve({ status: 'gone' });
    return new Promise((resolve) => {
      const list = waiters.get(askId) || [];
      const finish = (result) => {
        clearTimeout(timer);
        done.delete(askId);
        resolve(result);
      };
      const timer = setTimeout(() => {
        const left = (waiters.get(askId) || []).filter((w) => w !== finish);
        if (left.length) waiters.set(askId, left);
        else waiters.delete(askId);
        resolve({ status: 'pending' });
      }, ms);
      timer.unref?.();
      list.push(finish);
      waiters.set(askId, list);
    });
  }

  function prune(keep) {
    for (const [tid, entry] of open) if (!keep(tid)) settle(entry, { status: 'dismissed', reason: 'terminal ended' });
  }

  return { ask, current, end, wait, prune };
}

function askBodyParser() {
  return express.json({ limit: BODY_LIMIT });
}

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {ReturnType<typeof createAskStore>} o.store
 * @param {(token: string|undefined) => boolean} o.authorized  the terminal token
 * @param {(terminalId: string) => boolean} o.hasTerminal  a live terminal has this id
 * @param {(absPath: string) => Promise<{content: string|null, kind: string|null}>} o.readPreviewFile
 * @param {(event: object) => void} o.broadcast
 */
function mountAskRoutes(app, o) {
  const { store } = o;

  function guard(req, res) {
    if (!o.authorized(req.get('x-terminal-token'))) return res.status(401).json({ error: 'invalid terminal token' });
    if (!o.hasTerminal(req.params.terminalId)) return res.status(404).json({ error: 'no live terminal with that id' });
    return null;
  }

  async function readCard(file) {
    let read;
    try {
      read = await o.readPreviewFile(file);
    } catch (e) {
      if (e.status === 404) throw httpError(400, `file not found: ${file}`);
      throw e;
    }
    if (read.kind !== 'html') throw httpError(400, 'file must be an HTML file');
    return read.content;
  }

  const route = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (res.headersSent) return;
    if (!e.status) console.error(`Error in ${req.method} ${req.path}:`, e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Internal error' });
  });

  const closed = (terminalId, id, status) => o.broadcast({ type: 'ask:closed', terminalId, id, status });

  app.post(ASK_PATH, route(async (req, res) => {
    if (guard(req, res)) return;
    const p = parseAsk(req.body);
    if (typeof p === 'string') return res.status(400).json({ error: p });
    await readCard(p.file);
    const { terminalId } = req.params;
    const { entry, replaced } = store.ask(terminalId, p);
    if (replaced) closed(terminalId, replaced, 'dismissed');
    o.broadcast({ type: 'ask:opened', terminalId, id: entry.id, sessionId: entry.sessionId });
    res.json({ id: entry.id });
  }));

  app.get(ASK_PATH, route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const entry = store.current(req.params.terminalId);
    if (!entry) return res.json({ ask: null });
    const { id, title, size, file, sessionId } = entry;
    let content = null;
    try {
      content = await readCard(file);
    } catch (e) {
      if (!e.status) throw e;
    }
    res.json({ ask: { id, title, size, file, sessionId, content } });
  }));

  app.get(`${ASK_PATH}/:askId/wait`, route(async (req, res) => {
    if (guard(req, res)) return;
    const ms = Math.min(Math.max(Number(req.query.ms) || WAIT_MAX_MS, 0), WAIT_MAX_MS);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await store.wait(req.params.askId, ms));
  }));

  // The board answers or skips.
  app.post(`${ASK_PATH}/:askId`, route(async (req, res) => {
    if (guard(req, res)) return;
    const result = parseAnswer(req.body);
    if (typeof result === 'string') return res.status(400).json({ error: result });
    const { terminalId, askId } = req.params;
    if (!store.end(terminalId, askId, result)) return res.status(404).json({ error: 'no such question' });
    closed(terminalId, askId, result.status);
    res.status(204).end();
  }));

  // The tool call was interrupted.
  app.delete(`${ASK_PATH}/:askId`, route(async (req, res) => {
    if (guard(req, res)) return;
    const { terminalId, askId } = req.params;
    if (!store.end(terminalId, askId, { status: 'cancelled' })) return res.status(404).json({ error: 'no such question' });
    closed(terminalId, askId, 'cancelled');
    res.status(204).end();
  }));
}

module.exports = { createAskStore, mountAskRoutes, askBodyParser, parseAsk, parseAnswer, ASK_PATH, WAIT_MAX_MS };

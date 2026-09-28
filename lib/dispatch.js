// Dispatch: one Claude Code session started by another through cck, and the report it
// settles with. In memory on purpose: the PTYs die with the server, so nothing a
// restart drops could still settle.
//
// The child holds a per-dispatch capability, never the terminal token, so it can
// report its own outcome and nothing else. A stale or duplicate child is refused
// because a record settles once.

const crypto = require('node:crypto');
const { tokenMatches } = require('./terminal');
const { clampWait } = require('./session-events');

const OUTCOMES = new Set(['succeeded', 'failed']);
const MAX_SUMMARY = 4000;
// Settled records outlive their session long enough for a parent to collect them.
const KEEP_SETTLED_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^d_[0-9a-f]{12}$/;
// The peer name lands verbatim in the started session's prompt.
const PEER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isPeerName = (v) => typeof v === 'string' && PEER_RE.test(v);

// With neither --report nor --peer the started session gets the task alone, like one the user typed.
function formatPreamble(record, cli = 'claude-code-kanban') {
  if (!record.report && !record.peer) return record.spec;
  const lines = [`[cck dispatch ${record.id}] Another Claude Code session started you through claude-code-kanban to do the task below.`];
  if (record.peer) {
    lines.push(
      `That session is the peer "${record.peer}". Ask it, not the user: when you need a decision, or find something that changes the task, send a short message with the SendMessage tool to "${record.peer}".`,
      'Keep working on what does not depend on the answer. The reply arrives as a new message.',
    );
  }
  if (record.report) {
    lines.push(
      'When the task is done, or you cannot finish it, report exactly once with this command, then stop:',
      `${cli} dispatch done ${record.id} --cap ${record.cap} --outcome succeeded --summary "<what changed, what you found, what remains>"`,
      record.peer
        ? 'Use --outcome failed when the task cannot be finished. If the command refuses because the dispatch already ended, send the summary to the peer instead.'
        : 'Use --outcome failed when the task is not done. Do not ask the user questions the other session must answer; report failed with the question instead.',
    );
  }
  lines.push('', 'Task:', record.spec);
  return lines.join('\n');
}

// The line reaches the parent through the postman at hook trust level; the summary is
// last so no summary text can pose as a further field.
function formatDispatchLine(r) {
  const head = `cck:1 dispatch.${r.status} ${r.id} session=${r.session}`;
  return r.summary ? `${head} summary=${r.summary}` : head;
}

function publicView(r) {
  const { cap: _cap, ...rest } = r;
  return rest;
}

function createDispatchRegistry({ onSettle, now = Date.now } = {}) {
  const records = new Map();
  const waiters = new Set();

  function prune() {
    const cutoff = now() - KEEP_SETTLED_MS;
    for (const [id, r] of records) if (r.settledAt && r.settledAt < cutoff) records.delete(id);
  }

  function create({ parent, spec, name, report, peer, group, worktree }) {
    prune();
    const r = {
      id: `d_${crypto.randomBytes(6).toString('hex')}`,
      cap: crypto.randomBytes(16).toString('hex'),
      parent: parent || null,
      session: null,
      cwd: null,
      name: name || null,
      report: !!report,
      peer: peer || null,
      group: group || null,
      worktree: worktree || null,
      spec,
      status: 'running',
      summary: null,
      startedAt: now(),
      settledAt: null,
    };
    records.set(r.id, r);
    return r;
  }

  // The preamble carries the id, so the record exists before its session does.
  function attach(id, { session, cwd }) {
    const r = records.get(id);
    if (r) Object.assign(r, { session, cwd });
  }

  function discard(id) {
    records.delete(id);
  }

  function finish(r, status, summary) {
    r.status = status;
    r.summary = summary;
    r.settledAt = now();
    onSettle?.(r);
    for (const wake of [...waiters]) wake();
  }

  // Returns null when settled, or {status, error} naming the refusal.
  function settle(id, cap, outcome, summary) {
    const r = typeof id === 'string' && ID_RE.test(id) ? records.get(id) : null;
    if (!r) return { status: 404, error: 'no such dispatch' };
    if (!tokenMatches(r.cap, cap)) return { status: 403, error: 'wrong capability' };
    if (r.status !== 'running') return { status: 409, error: `already ${r.status}` };
    if (!OUTCOMES.has(outcome)) return { status: 400, error: 'outcome must be succeeded or failed' };
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters on purpose
    const text = typeof summary === 'string' ? summary.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, MAX_SUMMARY) : '';
    finish(r, outcome, text || null);
    return null;
  }

  // The PTY ended with no report: the parent must not wait on it forever.
  function sessionExited(sessionId) {
    for (const r of records.values()) if (r.session === sessionId && r.status === 'running') finish(r, 'exited', null);
  }

  function select({ ids, parent } = {}) {
    prune();
    let out = [...records.values()];
    if (ids?.length) out = out.filter((r) => ids.includes(r.id));
    else if (parent) out = out.filter((r) => r.parent === parent);
    return out;
  }

  function list(filter) {
    return select(filter).map(publicView);
  }

  // Resolves once any selected record is settled, or after `waitSec`. Stateless for the
  // caller: it passes the ids still running on the next call. `onClose(stop)` returns an
  // unsubscribe, called once the wait ends.
  function wait(filter, waitSec, onClose) {
    const sec = clampWait(waitSec);
    const snapshot = () => {
      const rows = select(filter);
      return {
        settled: rows.filter((r) => r.status !== 'running').map(publicView),
        running: rows.filter((r) => r.status === 'running').map(publicView),
      };
    };
    const first = snapshot();
    if (first.settled.length || !first.running.length || !sec) return Promise.resolve({ ...first, timeout: false });
    return new Promise((resolve) => {
      let unsubscribe;
      const done = (timeout) => {
        if (!waiters.delete(wake)) return;
        clearTimeout(timer);
        unsubscribe?.();
        resolve({ ...snapshot(), timeout });
      };
      const wake = () => {
        if (select(filter).some((r) => r.status !== 'running')) done(false);
      };
      const timer = setTimeout(() => done(true), sec * 1000);
      waiters.add(wake);
      unsubscribe = onClose?.(() => done(true));
    });
  }

  return { create, attach, discard, settle, sessionExited, list, wait };
}

module.exports = { createDispatchRegistry, formatPreamble, formatDispatchLine, isPeerName };

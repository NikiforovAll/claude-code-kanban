// Session event doorbell: tells a live session that the board moved one of its tasks.
// Its own module so the behaviour is unit-testable without booting the server -- the
// bucket-map invariants here are the difference between a bounded queue and a map that
// grows one permanent entry per session id ever named in a request path.

const crypto = require('node:crypto');
const { oneLine } = require('./one-line');

// Tells a live session that the board moved one of its tasks. The plugin's doorbell mod
// (plugin/plugins/claude-code-kanban/hooks/doorbell.ts) drains this queue and submits the
// lines to that session as a prompt.
//
// Deliberately in-memory and lossy. The task file is the durable command -- a dropped
// event only means the agent notices on its next turn instead of immediately -- so a
// disk queue would buy nothing. Reading consumes, so a restarted session never replays
// a backlog and acts on the same move twice.
//
// A mod that acks changes when a line leaves: on its ack, not on the read. A line with a
// `marker` (a review) is the durable exception. Its comments exist nowhere else the agent
// reads, so it survives the first-attach drop and /clear, and server.js keeps the marker
// file until the ack, which `restore` reads back after a board restart.
//
// A bucket exists only while it holds something: an undelivered line or a waiting
// poller. Without that, the map would grow one permanent entry per session id ever
// asked for -- and the id comes straight off the request path.
const sessionEventBuckets = new Map();

// The line reaches the model verbatim at hook trust level. The task id is caller-supplied
// and the subject and description are board-authored, so the length cap and the
// control-character scrub are what hold the one-line-per-event contract: a newline inside
// a description becomes a space rather than a second forged event.
//
// One cap for the whole line rather than one per field, because the description comes
// last: truncation eats its tail first and leaves the machine-readable head intact.
const sanitizeEventLine = (line) => oneLine(line, 1500);

// No skill explains the lines, so each one says what the user means by it. EVENT_PREFIX
// marks the board as the sender.
const EVENT_PREFIX = '[kanban board]';

function moveCommand(from, to, ref) {
  if (to === 'in_progress') return `Start task ${ref} now. Mark it completed when done.`;
  if (from === 'in_progress' && to === 'pending') return `Stop work on task ${ref} and leave it for later.`;
  if (to === 'completed') return `Stop work on task ${ref}: it is done.`;
  if (to === 'cancelled') return `Drop task ${ref}. Keep the changes made so far.`;
  return `Task ${ref} is now ${to}.`;
}

// Everything after `Description:` is the description verbatim to end of line, so no amount
// of board text can pose as a further part of the line. That leaves the subject as the only
// value that needs delimiting.
function formatTaskMoved(taskId, prevStatus, task) {
  const subject = String(task.subject || '').replace(/(["\\])/g, '\\$1');
  const head = `${EVENT_PREFIX} ${moveCommand(prevStatus, task.status, `${taskId} "${subject}"`)}`;
  return task.description ? `${head} Description: ${task.description}` : head;
}

// The `boardEvents` section of <CCK_DIR>/config.json. On unless it says enabled: false.
function boardEventsOn(cfg) {
  return cfg?.boardEvents?.enabled !== false;
}

// The comments themselves live in the review file; the line only points at it, because a
// batch of quotes would not survive the one-line cap. The path comes last and runs to end
// of line, so a space in the config dir cannot split it.
function formatReviewSubmitted(count, label, reviewFile) {
  const comments = `${count} review comment${count === 1 ? '' : 's'}`;
  return `${EVENT_PREFIX} Address ${comments} on ${label}: ${reviewFile}`;
}

function formatActionSubmitted(action, label, file) {
  return `${EVENT_PREFIX} User submitted "${action}" on ${label}: ${file}`;
}

// Names this board run in every reply, so a mod drops `got` and `ack` counted against a run
// that has since restarted.
const BOARD_RUN = crypto.randomBytes(6).toString('hex');
let lastSeq = 0;

// Ids come off request paths, so both maps are capped; the oldest entry goes first.
const MAX_IDS = 500;
const doorbells = new Map();
const aliases = new Map();

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_IDS) map.delete(map.keys().next().value);
}

// Set by server.js: `onDelivered(entry)` runs once a review line is acked (or drained by a
// mod without acks); `restore(sessionId)` returns the review lines still pending on disk.
const hooks = { onDelivered: null, restore: null };

function configureSessionEvents(opts) {
  Object.assign(hooks, opts);
}

// After /clear the mod polls under a new id, and the board may still send to the old one.
// `adopt` keeps each alias pointing at the newest id, so one lookup is enough.
function resolveSessionId(sessionId) {
  return aliases.get(sessionId) ?? sessionId;
}

function bucketFor(key) {
  let bucket = sessionEventBuckets.get(key);
  if (!bucket) {
    bucket = { queue: [], waiters: new Set() };
    sessionEventBuckets.set(key, bucket);
  }
  return bucket;
}

function partition(list, pred) {
  const yes = [];
  const no = [];
  for (const e of list) (pred(e) ? yes : no).push(e);
  return [yes, no];
}

// True once this session's doorbell has polled during this board run. A review then always
// goes into the queue: the mod takes it on its next poll, so a busy turn only delays it.
function hasDoorbell(sessionId) {
  return doorbells.has(resolveSessionId(sessionId));
}

function enqueueSessionEvent(sessionId, line, { marker } = {}) {
  const text = sanitizeEventLine(line);
  if (!sessionId || !text) return;
  const bucket = bucketFor(resolveSessionId(sessionId));
  bucket.queue.push({ seq: ++lastSeq, text, marker });
  // A session with no doorbell attached must not grow without bound.
  if (bucket.queue.length > 50) bucket.queue.splice(0, bucket.queue.length - 50);
  for (const wake of [...bucket.waiters]) wake();
}

function delivered(entries) {
  for (const e of entries) if (e.marker) hooks.onDelivered?.(e);
}

function adopt(prev, sessionId) {
  if (!prev || prev === sessionId) return;
  for (const [from, to] of aliases) if (to === prev) aliases.set(from, sessionId);
  remember(aliases, prev, sessionId);
  const old = sessionEventBuckets.get(prev);
  if (!old) return;
  const [durable, rest] = partition(old.queue, (e) => e.marker);
  old.queue = rest;
  evictIfEmpty(prev, old);
  if (!durable.length) return;
  const bucket = bucketFor(sessionId);
  bucket.queue.push(...durable);
  bucket.queue.sort((a, b) => a.seq - b.seq);
}

async function restorePending(sessionId) {
  const lines = await hooks.restore(sessionId).catch(() => []);
  const queued = new Set(sessionEventBuckets.get(sessionId)?.queue.map((e) => e.marker));
  for (const { text, marker } of lines) {
    if (!queued.has(marker)) enqueueSessionEvent(sessionId, text, { marker });
  }
}

const MAX_WAIT_SEC = 120;
const TOPIC_RE = /^[a-z]+$/;

function clampWait(sec) {
  return Math.min(Math.max(Number(sec) || 0, 0), MAX_WAIT_SEC);
}

// Each topic rides its own bucket. No topic is the task-move bucket. Plugins before 2.22.0
// run a `--topic dispatch` monitor, which must keep getting nothing.
function topicKey(topic, sessionId) {
  return topic ? `${topic}:${sessionId}` : sessionId;
}

function seqParam(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

// Long-poll drained by the doorbell mod. Routing stays in server.js; this is the handler.
//
// A mod that acks sends `got` (the last seq it took) and `ack` (the last seq it submitted to
// the session). The board answers only lines past `got` and keeps each line until its ack, so
// a reply lost on the way, or a mod that dies before its submit, gets the line again. A mod
// before acks sends neither, and a line is gone once a reply carries it.
async function handleSessionEvents(req, res) {
  const topic = req.query.topic;
  if (topic !== undefined && !(typeof topic === 'string' && TOPIC_RE.test(topic))) {
    return res.status(400).json({ error: 'invalid topic' });
  }
  const sessionId = topicKey(topic, req.params.sessionId);
  const wait = clampWait(req.query.wait);
  const acks = req.query.got !== undefined;
  const trusted = acks && req.query.board === BOARD_RUN;
  const got = trusted ? seqParam(req.query.got) : 0;
  const ack = trusted ? seqParam(req.query.ack) : 0;

  if (!topic) {
    aliases.delete(sessionId);
    const known = doorbells.has(sessionId);
    remember(doorbells, sessionId, true);
    if (req.query.first === '1' && typeof req.query.prev === 'string') adopt(req.query.prev, sessionId);
    if (!known && hooks.restore) await restorePending(sessionId);
  }

  const bucket = sessionEventBuckets.get(sessionId);
  if (bucket && ack) {
    const [done, rest] = partition(bucket.queue, (e) => e.seq <= ack);
    bucket.queue = rest;
    delivered(done);
  }

  // A doorbell can attach long after the board moved something (a resumed session, a board
  // that came up later). Those lines are read as instructions, and an hours-old instruction
  // is worse than no instruction, so `first=1` drops the backlog of moves, and an emptied
  // bucket is still evicted from the map. Reviews are kept: the review file says what to
  // address however late it arrives.
  if (bucket && req.query.first === '1') bucket.queue = bucket.queue.filter((e) => e.marker);

  const take = (b) => {
    if (acks) return b.queue.filter((e) => e.seq > got);
    const all = b.queue.splice(0);
    delivered(all);
    return all;
  };
  const reply = (entries) => ({ events: entries.map((e) => e.text), seqs: entries.map((e) => e.seq), board: BOARD_RUN });

  const ready = bucket ? take(bucket) : [];
  if (bucket) evictIfEmpty(sessionId, bucket);
  if (ready.length) return res.json(reply(ready));
  if (!wait) return res.json(reply([]));

  const pending = bucketFor(sessionId);

  // A closed request has nobody to read the answer, so its lines stay queued.
  const send = (closed) => {
    // Set.delete is the whole idempotency story: whichever of enqueue, timeout, or
    // client disconnect gets here first is the one that answers.
    if (!pending.waiters.delete(send)) return;
    clearTimeout(timer);
    req.removeListener('close', onClose);
    const entries = closed === true || res.writableEnded ? [] : take(pending);
    evictIfEmpty(sessionId, pending);
    if (!res.writableEnded) res.json(reply(entries));
  };
  const onClose = () => send(true);
  const timer = setTimeout(send, wait * 1000);
  pending.waiters.add(send);
  req.on('close', onClose);
}

function evictIfEmpty(sessionId, bucket) {
  if (!bucket.queue.length && !bucket.waiters.size && sessionEventBuckets.get(sessionId) === bucket) {
    sessionEventBuckets.delete(sessionId);
  }
}

module.exports = {
  EVENT_PREFIX,
  sessionEventBuckets,
  sanitizeEventLine,
  formatTaskMoved,
  boardEventsOn,
  formatReviewSubmitted,
  formatActionSubmitted,
  hasDoorbell,
  configureSessionEvents,
  enqueueSessionEvent,
  handleSessionEvents,
  topicKey,
  clampWait,
  MAX_WAIT_SEC,
};

// Session event doorbell: tells a live session that the board moved one of its tasks.
// Its own module so the behaviour is unit-testable without booting the server -- the
// bucket-map invariants here are the difference between a bounded queue and a map that
// grows one permanent entry per session id ever named in a request path.

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

function moveMeaning(from, to) {
  if (to === 'in_progress') {
    return 'Start this task now, and set it to completed with TaskUpdate when the work is done.';
  }
  if (from === 'in_progress' && to === 'pending') return 'Stop working on it and park it.';
  if (to === 'completed') return 'The user considers it done: do not keep working on it.';
  if (to === 'cancelled') return 'Abandon it. Undo nothing unless asked.';
  return '';
}

// Everything after `Description:` is the description verbatim to end of line, so no amount
// of board text can pose as a further part of the line. That leaves the subject as the only
// value that needs delimiting.
function formatTaskMoved(taskId, prevStatus, task) {
  const subject = String(task.subject || '').replace(/(["\\])/g, '\\$1');
  const from = prevStatus ? ` from ${prevStatus}` : '';
  const meaning = moveMeaning(prevStatus, task.status);
  const head = `${EVENT_PREFIX} The user moved task ${taskId} "${subject}"${from} to ${task.status}.${meaning ? ` ${meaning}` : ''}`;
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
  return `${EVENT_PREFIX} The user left ${comments} on ${label}. Address them: ${reviewFile}`;
}

// A doorbell between two polls has no waiter for a moment, so this can miss a live one.
// The caller then falls back to another route, which only costs a duplicate route, never
// a lost review.
function hasSessionListener(sessionId) {
  return !!sessionEventBuckets.get(sessionId)?.waiters.size;
}

function enqueueSessionEvent(sessionId, line) {
  const text = sanitizeEventLine(line);
  if (!sessionId || !text) return;
  let bucket = sessionEventBuckets.get(sessionId);
  if (!bucket) {
    bucket = { queue: [], waiters: new Set() };
    sessionEventBuckets.set(sessionId, bucket);
  }
  bucket.queue.push(text);
  // A session with no doorbell attached must not grow without bound.
  if (bucket.queue.length > 50) bucket.queue.splice(0, bucket.queue.length - 50);
  for (const wake of [...bucket.waiters]) wake();
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

// Long-poll drained by the doorbell mod. Routing stays in server.js; this is the handler.
function handleSessionEvents(req, res) {
  const topic = req.query.topic;
  if (topic !== undefined && !(typeof topic === 'string' && TOPIC_RE.test(topic))) {
    return res.status(400).json({ error: 'invalid topic' });
  }
  const sessionId = topicKey(topic, req.params.sessionId);
  const bucket = sessionEventBuckets.get(sessionId);
  const wait = clampWait(req.query.wait);

  // A doorbell can attach long after the board moved something (a resumed session, a board
  // that came up later). Those lines are read as instructions, and an hours-old instruction
  // is worse than no instruction, so `first=1` drops the whole backlog. drain() (not a bare
  // truncate) so an emptied bucket is still evicted from the map.
  if (bucket && req.query.first === '1') drain(sessionId, bucket);

  if (bucket?.queue.length) return res.json({ events: drain(sessionId, bucket) });
  if (!wait) return res.json({ events: [] });

  const pending = bucket || { queue: [], waiters: new Set() };
  sessionEventBuckets.set(sessionId, pending);

  const send = () => {
    // Set.delete is the whole idempotency story: whichever of enqueue, timeout, or
    // client disconnect gets here first is the one that answers.
    if (!pending.waiters.delete(send)) return;
    clearTimeout(timer);
    req.removeListener('close', send);
    const events = drain(sessionId, pending);
    if (!res.writableEnded) res.json({ events });
  };
  const timer = setTimeout(send, wait * 1000);
  pending.waiters.add(send);
  req.on('close', send);
}

function drain(sessionId, bucket) {
  const events = bucket.queue.splice(0);
  if (!bucket.queue.length && !bucket.waiters.size) sessionEventBuckets.delete(sessionId);
  return events;
}

module.exports = {
  EVENT_PREFIX,
  sessionEventBuckets,
  sanitizeEventLine,
  formatTaskMoved,
  boardEventsOn,
  formatReviewSubmitted,
  hasSessionListener,
  enqueueSessionEvent,
  handleSessionEvents,
  topicKey,
  clampWait,
  MAX_WAIT_SEC,
};

// Session event doorbell: tells a live session that the board moved one of its tasks.
// Its own module so the behaviour is unit-testable without booting the server -- the
// bucket-map invariants here are the difference between a bounded queue and a map that
// grows one permanent entry per session id ever named in a request path.

// Tells a live session that the board moved one of its tasks. The postman monitor
// (plugin/plugins/claude-code-kanban/scripts/postman.js) drains this queue and prints
// each line, which Claude Code delivers into that session as a task notification.
//
// Deliberately in-memory and lossy. The task file is the durable command -- a dropped
// event only means the agent notices on its next turn instead of immediately -- so a
// disk queue would buy nothing. Reading consumes, so a restarted postman never replays
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
function sanitizeEventLine(line) {
  return line.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 1500);
}

// Everything after `description=` is the description verbatim to end of line, so no amount
// of board text can pose as a further field. That leaves the subject as the only value
// that needs delimiting.
function formatTaskMoved(taskId, prevStatus, task) {
  const subject = String(task.subject || '').replace(/(["\\])/g, '\\$1');
  const head = `cck:1 task.moved ${taskId} ${prevStatus || 'none'}>${task.status} subject="${subject}"`;
  return task.description ? `${head} description=${task.description}` : head;
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
  // A session with no postman attached must not grow without bound.
  if (bucket.queue.length > 50) bucket.queue.splice(0, bucket.queue.length - 50);
  for (const wake of [...bucket.waiters]) wake();
}

// Long-poll drained by the postman monitor. Routing stays in server.js; this is the handler.
function handleSessionEvents(req, res) {
  const { sessionId } = req.params;
  const bucket = sessionEventBuckets.get(sessionId);
  const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), 120);

  // A postman is armed by a skill invocation, so it can attach long after the board moved
  // something. Those lines are read as instructions, and an hours-old instruction is worse
  // than no instruction, so the grant starts the session's history rather than inheriting
  // it: `first=1` drops the whole backlog. drain() (not a bare truncate) so an emptied
  // bucket is still evicted from the map.
  if (bucket && req.query.first === '1') drain(sessionId, bucket);

  if (bucket && bucket.queue.length) return res.json({ events: drain(sessionId, bucket) });
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
  sessionEventBuckets,
  sanitizeEventLine,
  formatTaskMoved,
  enqueueSessionEvent,
  handleSessionEvents,
};

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// A fresh module per test: the bucket map is module state, and these tests assert its
// invariants -- an emptied bucket is evicted, an unknown session id mints nothing.
const MODULE = require.resolve('../lib/session-events');

function loadDoorbell() {
  delete require.cache[MODULE];
  const mod = require(MODULE);
  const poll = (sessionId, wait = 0, query = {}) => new Promise((resolve) => {
    const req = { params: { sessionId }, query: { wait, ...query }, on() {}, removeListener() {} };
    const res = { writableEnded: false, json: (body) => { res.writableEnded = true; resolve(body); } };
    mod.handleSessionEvents(req, res);
  });
  return { ...mod, poll };
}

describe('session event doorbell', () => {
  it('does not mint a bucket for an unknown session id', async () => {
    const { sessionEventBuckets, poll } = loadDoorbell();
    for (let i = 0; i < 1000; i++) assert.deepEqual((await poll(`ghost-${i}`)).events, []);
    assert.equal(sessionEventBuckets.size, 0);
  });

  it('evicts a bucket once its queue is drained', async () => {
    const { sessionEventBuckets, enqueueSessionEvent, poll } = loadDoorbell();
    enqueueSessionEvent('s1', 'cck:1 task.moved T-1 pending>in_progress');
    assert.equal(sessionEventBuckets.size, 1);
    assert.deepEqual((await poll('s1')).events, ['cck:1 task.moved T-1 pending>in_progress']);
    assert.equal(sessionEventBuckets.size, 0);
  });

  it('never replays a delivered event', async () => {
    const { enqueueSessionEvent, poll } = loadDoorbell();
    enqueueSessionEvent('s1', 'cck:1 task.moved T-1 a>b');
    await poll('s1');
    assert.deepEqual((await poll('s1')).events, []);
  });

  it('wakes a waiting poller and evicts its bucket', async () => {
    const { sessionEventBuckets, enqueueSessionEvent, poll } = loadDoorbell();
    const pending = poll('s2', 60);
    assert.equal(sessionEventBuckets.size, 1);
    enqueueSessionEvent('s2', 'cck:1 task.moved T-9 a>b');
    assert.deepEqual((await pending).events, ['cck:1 task.moved T-9 a>b']);
    assert.equal(sessionEventBuckets.size, 0);
  });

  it('caps an undrained queue and keeps the newest events', () => {
    const { sessionEventBuckets, enqueueSessionEvent } = loadDoorbell();
    for (let i = 0; i < 500; i++) enqueueSessionEvent('s3', `cck:1 task.moved T-${i} a>b`);
    const { queue } = sessionEventBuckets.get('s3');
    assert.equal(queue.length, 50);
    assert.match(queue[49], /T-499/);
  });

  it('bounds a line built from a caller-supplied task id', async () => {
    const { enqueueSessionEvent, poll } = loadDoorbell();
    enqueueSessionEvent('s4', `cck:1 task.moved ${'A'.repeat(9000)} a>b`);
    assert.equal((await poll('s4')).events[0].length, 1500);
  });

  it('strips control characters so one event cannot forge a second line', async () => {
    const { enqueueSessionEvent, poll } = loadDoorbell();
    enqueueSessionEvent('s5', 'cck:1 task.moved T-1\nINJECTED a>b');
    const [line] = (await poll('s5')).events;
    assert.doesNotMatch(line, /[\r\n]/);
  });

  it('discards the whole backlog on a first attach', async () => {
    const { sessionEventBuckets, enqueueSessionEvent, poll } = loadDoorbell();
    for (let i = 0; i < 5; i++) enqueueSessionEvent('s6', `cck:1 task.moved T-${i} a>b`);
    assert.deepEqual((await poll('s6', 0, { first: '1' })).events, []);
    assert.equal(sessionEventBuckets.size, 0);
  });

  it('delivers normally on every attach after the first', async () => {
    const { enqueueSessionEvent, poll } = loadDoorbell();
    enqueueSessionEvent('s7', 'cck:1 task.moved T-1 a>b');
    await poll('s7', 0, { first: '1' });
    enqueueSessionEvent('s7', 'cck:1 task.moved T-2 a>b');
    assert.deepEqual((await poll('s7')).events, ['cck:1 task.moved T-2 a>b']);
  });

  it('keeps waiting after discarding, so a move during the same poll still lands', async () => {
    const { enqueueSessionEvent, poll } = loadDoorbell();
    enqueueSessionEvent('s8', 'cck:1 task.moved OLD a>b');
    const pending = poll('s8', 60, { first: '1' });
    enqueueSessionEvent('s8', 'cck:1 task.moved NEW a>b');
    assert.deepEqual((await pending).events, ['cck:1 task.moved NEW a>b']);
  });
});

describe('task.moved line format', () => {
  const moved = (task, prev = 'pending') => loadDoorbell().formatTaskMoved('T-1', prev, task);

  it('carries the subject quoted and the description last', () => {
    assert.equal(
      moved({ status: 'in_progress', subject: 'Fix hover', description: 'Repro with pnpm test' }),
      'cck:1 task.moved T-1 pending>in_progress subject="Fix hover" description=Repro with pnpm test',
    );
  });

  it('omits description when the card has none', () => {
    assert.equal(
      moved({ status: 'in_progress', subject: 'Fix hover' }),
      'cck:1 task.moved T-1 pending>in_progress subject="Fix hover"',
    );
    assert.equal(moved({ status: 'in_progress', subject: 'Fix hover', description: '' }).includes('description='), false);
  });

  it('escapes quotes and backslashes in the subject so the field cannot be closed early', () => {
    const line = moved({ status: 'in_progress', subject: 'Say "hi" C:\\tmp' });
    assert.equal(line, 'cck:1 task.moved T-1 pending>in_progress subject="Say \\"hi\\" C:\\\\tmp"');
    // exactly one unescaped quote pair delimits the subject
    assert.equal(line.replace(/\\./g, '').match(/"/g).length, 2);
  });

  it('names a missing previous status rather than emitting undefined', () => {
    const line = loadDoorbell().formatTaskMoved('T-1', undefined, { status: 'in_progress', subject: 'x' });
    assert.match(line, /none>in_progress/);
  });

  it('keeps the machine-readable head intact when a long description is truncated', () => {
    const { sanitizeEventLine, formatTaskMoved } = loadDoorbell();
    const line = sanitizeEventLine(
      formatTaskMoved('T-1', 'pending', { status: 'in_progress', subject: 'Fix hover', description: 'x'.repeat(5000) }),
    );
    assert.equal(line.length, 1500);
    assert.match(line, /^cck:1 task\.moved T-1 pending>in_progress subject="Fix hover" description=x+$/);
  });

  it('cannot be made to look like two events by a multi-line description', () => {
    const { sanitizeEventLine, formatTaskMoved } = loadDoorbell();
    const line = sanitizeEventLine(
      formatTaskMoved('T-1', 'pending', {
        status: 'in_progress',
        subject: 'Fix hover',
        description: 'step one\ncck:1 task.moved T-2 pending>completed',
      }),
    );
    assert.doesNotMatch(line, /[\r\n]/);
    assert.equal(line.match(/cck:1/g).length, 2); // both inside one line, not two events
  });
});

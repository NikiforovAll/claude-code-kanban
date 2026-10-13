const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { noteReplacedSessions } = require('../lib/live-sessions');

describe('noteReplacedSessions', () => {
  const TTL = 1000;

  it('marks the id a pid held before /clear', () => {
    const replaced = new Map();
    noteReplacedSessions(null, [{ pid: 7, sessionId: 'a' }], replaced, 0, TTL);
    assert.equal(replaced.size, 0);
    noteReplacedSessions([{ pid: 7, sessionId: 'a' }], [{ pid: 7, sessionId: 'b' }], replaced, 10, TTL);
    assert.deepEqual([...replaced], [['a', 10]]);
  });

  it('ignores an exit and a new process', () => {
    const replaced = new Map();
    noteReplacedSessions([{ pid: 7, sessionId: 'a' }], [{ pid: 8, sessionId: 'b' }], replaced, 10, TTL);
    assert.equal(replaced.size, 0);
  });

  it('clears an id that is live again, and one older than the ttl', () => {
    const replaced = new Map([['a', 0], ['old', 0]]);
    noteReplacedSessions([], [{ pid: 9, sessionId: 'a' }], replaced, TTL + 1, TTL);
    assert.equal(replaced.size, 0);
  });
});

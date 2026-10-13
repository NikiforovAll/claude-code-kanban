'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseExport, describeEvent, nameMap, logRow } = require('../lib/events');

const W1 = 'id-w1';
const ev = (seq, kind, payload, actor = W1, name = 'w1') => ({ seq, ts: `2026-10-10 09:00:0${seq % 10}`, actor, name, kind, payload, revision: 1 });

const RAW = [
  ev(1, 'task_create', { task_id: 1, title: 'Parse', description: 'd', kind: 'implementation' }, 'id-p', 'parent'),
  ev(2, 'task_claim', { task_id: 1 }),
  ev(3, 'claim_lost', { task_id: 1, owner: W1, state: 'claimed' }, 'id-w2', 'w2'),
  ev(4, 'publication', { summary: 'parser', file_count: 1, files: [{ path: 'src/a.js', change: 'added', bytes: 3 }] }),
  ev(5, 'finding', { text: 'a fact' }),
  ev(6, 'apply', { publication_id: 4, paths: ['src/a.js'], confirmed: true }, 'id-w2', 'w2'),
  ev(7, 'task_release', { task_id: 1, handoff: 'half done', checkpoint: 4 }),
  ev(8, 'request', { revision: 2, text: 'also bench' }, 'id-p', 'parent'),
  ev(9, 'task_owner_stopped', { task_id: 1, owner: W1, reason: 'out of context' }),
  ev(10, 'worker_stopped', { worker: 'w1', reason: 'out of context', released: [1] }),
  ev(11, 'task_close', { task_id: 1, summary: 'Closed: not needed' }, 'id-p', 'parent'),
  ev(12, 'outcome', { worker: 'w2', outcome: 'complete', summary: 'all done', dependency: null }, 'id-w2', 'w2'),
  ev(13, 'end', { outcome: 'complete', summary: 'shipped' }, 'id-p', 'parent'),
  ev(14, 'worker_woken', { worker: 'w2', reason: 'no_producer', state: 'waiting', dependency: 'task:1' }, 'id-w2', 'w2'),
  ev(15, 'something_new', { x: 1 }),
];

describe('parseExport', () => {
  const { events, raw, sequence, running } = parseExport({ sequence: 15, events: RAW });

  it('keeps the raw rows and the sequence, and drops kinds it does not know', () => {
    assert.equal(sequence, 15);
    assert.equal(raw.length, 15);
    assert.equal(events.length, 14);
    assert.ok(!events.some((e) => e.seq === 15));
  });

  it('reads which worker turns run when the export carries the workers, else none', () => {
    assert.equal(running, null);
    const r = parseExport({ sequence: 0, events: [], workers: [{ worker: 'w1', running: true }, { worker: 'w2', running: false }] }).running;
    assert.deepEqual([...r], [['w1', true], ['w2', false]]);
  });

  it('reads the revision each worker acknowledged, and a refused declaration', () => {
    const r = parseExport({ sequence: 1, events: [ev(1, 'outcome_refused', { worker: 'w1', outcome: 'complete', expected_revision: 1, revision: 2 })], workers: [{ worker: 'w1', running: false, acked: 2 }, { worker: 'w2', running: false }] });
    assert.deepEqual([...r.acked], [['w1', 2]]);
    assert.deepEqual([r.events[0].kind, r.events[0].outcome, r.events[0].expected], ['refused', 'complete', 1]);
    assert.equal(parseExport({ events: [] }).acked, null);
  });

  it('keeps the reason and the state before a wake', () => {
    const w = events.find((e) => e.kind === 'woken');
    assert.deepEqual([w.reason, w.from, w.dependency], ['no_producer', 'waiting', 'task:1']);
  });

  it('reads timestamps without a zone as UTC', () => {
    assert.equal(events[0].t, Date.parse('2026-10-10T09:00:01Z'));
  });

  it('maps each store kind to one model kind', () => {
    assert.deepEqual(
      events.map((e) => e.kind),
      ['task', 'claim', 'lost', 'publish', 'finding', 'apply', 'release', 'request', 'release', 'stopped', 'close', 'outcome', 'end', 'woken'],
    );
  });

  it('takes publication and finding ids from the event seq', () => {
    assert.equal(events.find((e) => e.kind === 'publish').publicationId, 4);
    assert.equal(events.find((e) => e.kind === 'finding').findingId, 5);
  });

  it('turns an owner stop into a release with a handoff', () => {
    const r = events.find((e) => e.seq === 9);
    assert.equal(r.handoff, 'Owner stopped: out of context');
  });
});

describe('describeEvent', () => {
  const label = (id) => ({ [W1]: 'w1', 'id-w2': 'w2' })[id] ?? id;
  const text = (seq) => describeEvent(RAW[seq - 1], label);

  it('writes one sentence per kind', () => {
    assert.equal(text(1), 'added #1 Parse (implementation)');
    assert.equal(text(3), 'lost the claim on #1, held by w1');
    assert.equal(text(7), 'released #1: half done (checkpoint publication 4)');
    assert.equal(text(9), 'released #1 because w1 stopped: out of context');
    assert.equal(text(10), 'w1 stopped: out of context; released #1');
    assert.equal(text(11), 'closed #1: not needed');
    assert.equal(text(8), 'request revision 2: also bench');
    assert.equal(text(13), 'ended the swarm (complete): shipped');
    assert.equal(text(14), 'woke up, no running worker can produce its dependency; was waiting for task:1');
  });

  it('keeps #N for tasks only, so the page can link every #N to a task', () => {
    for (const seq of [4, 5, 6]) assert.doesNotMatch(text(seq), /#\d/);
  });

  it('names both revisions of a refused declaration', () => {
    const e = ev(16, 'outcome_refused', { worker: 'w1', outcome: 'complete', expected_revision: 1, revision: 3 });
    assert.equal(describeEvent(e), 'outcome complete refused: declared under revision 1, current is 3');
    assert.equal(describeEvent({ ...e, payload: { worker: 'w1', outcome: null, expected_revision: null, revision: 3 } }), 'outcome ? refused: declared under revision ?, current is 3');
  });

  it('falls back to the payload for an unknown kind', () => {
    assert.equal(text(15), '{"x":1}');
  });
});

describe('nameMap and logRow', () => {
  it('lets the name an event carries win over the registry', () => {
    const names = nameMap([{ actor: W1, name: 'w1-new' }], { workers: [{ sessionId: W1, name: 'w1-old' }, { sessionId: 'id-w9', name: 'w9' }] });
    assert.equal(names.get(W1), 'w1-new');
    assert.equal(names.get('id-w9'), 'w9');
  });

  it('builds a log row with time, worker, group and text', () => {
    const names = new Map([['id-p', 'parent']]);
    const row = logRow(RAW[7], names);
    assert.deepEqual(
      { ...row, payload: undefined },
      { seq: 8, t: Date.parse('2026-10-10T09:00:08Z'), who: 'parent', revision: 1, kind: 'request', group: 'parent', text: 'request revision 2: also bench', payload: undefined },
    );
    assert.equal(logRow(RAW[2], names).group, 'lost');
    assert.equal(logRow(RAW[11], names).group, 'status');
    assert.equal(logRow(RAW[0], names).group, 'task');
    assert.equal(logRow(RAW[13], names).group, 'status');
    assert.equal(logRow(RAW[14], names).group, 'other');
  });
});

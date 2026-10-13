'use strict';

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseExport } = require('../lib/events');
const { buildModel } = require('../lib/model');
const { configDir, buildSwarm, store, registry } = require('./helpers');

describe('buildModel on the fixture swarm, built through the real store', () => {
  let config;
  let m;

  before(async () => {
    config = configDir();
    const { dir } = await buildSwarm(config);
    const { main } = await store();
    const { events, acked } = parseExport(main('export', { dir, since: 0 }));
    m = buildModel(events, { listId: path.basename(dir), ...registry(dir) }, Date.now(), { acked });
  });

  after(() => fs.rmSync(config, { recursive: true, force: true }));

  it('reads the swarm end from the log', () => {
    assert.equal(m.swarm.outcome.outcome, 'complete');
    assert.equal(m.swarm.revision, 2);
    assert.equal(m.swarm.endedAt, Date.parse('2026-10-10T10:00:00Z'));
    assert.equal(m.progress.goalReached, true);
  });

  it('counts tasks, a closed one among the done', () => {
    assert.deepEqual(m.progress, { total: 9, open: 0, claimed: 0, done: 9, closed: 1, goalReached: true });
    const closed = m.tasks.find((t) => t.closed);
    assert.equal(closed.subject, 'Add JSON export');
    assert.equal(closed.createdBy, 'supervisor');
  });

  it('keeps the supervisor out of the workers, and finishes only the worker that declared complete', () => {
    assert.deepEqual(
      m.workers.map((w) => [w.name, w.health]),
      [
        ['w1-a3f9c2', 'finished'],
        ['w2-a3f9c2', 'idle'],
        ['w3-a3f9c2', 'stopped'],
      ],
    );
  });

  it('records lost claims with the owner that held the task', () => {
    assert.equal(m.races.length, 4);
    const onNine = m.races.find((r) => r.taskId === 9);
    assert.deepEqual([onNine.who, onNine.owner], ['w2-a3f9c2', 'w1-a3f9c2']);
    assert.equal(m.tasks.find((t) => t.id === 1).races.length, 2);
  });

  it('turns a stopped owner into a release with a handoff', () => {
    assert.deepEqual(
      m.releases.map((r) => [r.who, r.taskId, r.handoff.split(';')[0]]),
      [
        ['w1-a3f9c2', 6, 'README section drafted'],
        ['w3-a3f9c2', 9, 'Owner stopped: context limit reached'],
      ],
    );
  });

  it('keeps the spec and each revision with what was done under it, and no request text', () => {
    assert.deepEqual(m.spec, { revision: 1, seq: 1, who: 'supervisor', t: Date.parse('2026-10-10T09:00:00Z') });
    assert.deepEqual(m.revisions.map((r) => [r.revision, r.who, r.tasks]), [[1, 'supervisor', [1, 2, 3, 4, 5, 6, 7]], [2, 'supervisor', [8, 9]]]);
    assert.ok(m.revisions.every((r) => !('text' in r)));
    const [one, two] = m.revisions;
    assert.deepEqual([one.publications.length, two.publications.length], [2, 6]);
    assert.deepEqual(two.woken.map((x) => x.who), ['w2-a3f9c2']);
    assert.deepEqual(two.outcomes.map((x) => [x.who, x.outcome]), [['w2-a3f9c2', 'waiting'], ['w1-a3f9c2', 'blocked'], ['w1-a3f9c2', 'complete']]);
    assert.deepEqual(two.first.map((x) => x.who), ['w3-a3f9c2', 'w1-a3f9c2', 'w2-a3f9c2'], 'a wake is the store acting, not the worker');
    assert.deepEqual(m.tasks.map((t) => t.revision), [1, 1, 1, 1, 1, 1, 1, 2, 2]);
    assert.ok(m.timeline['w1-a3f9c2'].every((x) => x.rev === (x.t < m.revisions[1].t ? 1 : 2)));
  });

  it('reads from the store the last revision each worker acknowledged', () => {
    assert.deepEqual(m.workers.map((w) => [w.name, w.acked]), [['w1-a3f9c2', 2], ['w2-a3f9c2', 2], ['w3-a3f9c2', 2]]);
  });

  it('lists findings, publications and applies', () => {
    assert.equal(m.findings.length, 7);
    assert.equal(m.publications.length, 8);
    assert.equal(m.applies.length, 5);
  });

  it('shows who holds which version of a file', () => {
    const csv = m.files.find((f) => f.path === 'src/csv.js');
    assert.equal(csv.versions, 2);
    assert.deepEqual(
      [csv.held['w1-a3f9c2'].own, csv.held['w1-a3f9c2'].current],
      [true, true],
    );
    assert.equal(csv.held['w3-a3f9c2'].author, 'w2-a3f9c2');
    assert.equal(csv.held['w3-a3f9c2'].current, false);
  });

  it('marks stops and outcomes on the timeline', () => {
    assert.ok(m.timeline['w3-a3f9c2'].some((x) => x.type === 'stopped'));
    assert.ok(m.timeline['w1-a3f9c2'].some((x) => x.type === 'outcome'));
  });

  it('marks each wake with its reason and the state before it', () => {
    const wakes = m.timeline['w2-a3f9c2'].filter((x) => x.type === 'woken');
    assert.deepEqual(
      wakes.map((x) => [x.reason, x.from, x.dependency]),
      [
        ['request', 'working', null],
        ['no_producer', 'waiting', 'task:9'],
      ],
    );
  });
});

describe('buildModel on a running swarm with a stalled waiter', () => {
  let config;
  let m;

  before(async () => {
    config = configDir();
    const { dir } = await buildSwarm(config, undefined, { running: true });
    const { main } = await store();
    const { events, running } = parseExport(main('export', { dir, since: 0 }));
    m = buildModel(events, { listId: path.basename(dir), ...registry(dir) }, Date.now(), { running });
  });

  after(() => fs.rmSync(config, { recursive: true, force: true }));

  it('shows the waiter as working again after a no-producer wake, and remembers why', () => {
    const w2 = m.workers.find((w) => w.name === 'w2-a3f9c2');
    assert.deepEqual([w2.status.state, w2.status.woken, w2.status.wokeFor], ['working', 'no_producer', 'task:9']);
  });

  it('reads from the store whose turn runs: the woken worker runs, the blocked and the stopped ones do not', () => {
    assert.deepEqual(
      m.workers.map((w) => [w.name, w.running, w.health]),
      [
        ['w1-a3f9c2', false, 'blocked'],
        ['w2-a3f9c2', true, 'quiet'],
        ['w3-a3f9c2', false, 'stopped'],
      ],
    );
  });
});

describe('buildModel on a running swarm', () => {
  it('rates health against the clock', () => {
    const t = (min) => Date.parse('2026-10-10T09:00:00Z') + min * 60_000;
    const events = [
      { seq: 1, t: t(0), actor: 'a', name: 'w1', kind: 'task', taskId: 1, title: 'x' },
      { seq: 2, t: t(1), actor: 'a', name: 'w1', kind: 'claim', taskId: 1 },
      { seq: 3, t: t(2), actor: 'b', name: 'w2', kind: 'status', state: 'waiting', summary: '', dependency: 'task:1' },
    ];
    const health = (now) => Object.fromEntries(buildModel(events, { state: 'running' }, now).workers.map((w) => [w.name, w.health]));
    assert.deepEqual(health(t(3)), { w1: 'working', w2: 'waiting' });
    assert.deepEqual(health(t(30)), { w1: 'stuck', w2: 'quiet' });
  });

  it('does not call a worker quiet while it sleeps between turns', () => {
    const t = (min) => Date.parse('2026-10-10T09:00:00Z') + min * 60_000;
    const events = [
      { seq: 1, t: t(0), actor: 'a', name: 'w1', kind: 'task', taskId: 1, title: 'x' },
      { seq: 2, t: t(1), actor: 'a', name: 'w1', kind: 'claim', taskId: 1 },
      { seq: 3, t: t(2), actor: 'b', name: 'w2', kind: 'status', state: 'waiting', summary: '', dependency: 'task:1' },
      { seq: 4, t: t(2), actor: 'c', name: 'w3', kind: 'status', state: 'working', summary: '' },
    ];
    const at = (running) => buildModel(events, { state: 'running' }, t(30), { running }).workers.map((w) => [w.name, w.health, w.running]);
    assert.deepEqual(at(new Map([['w1', false], ['w2', false], ['w3', false]])), [
      ['w1', 'stuck', false],
      ['w2', 'waiting', false],
      ['w3', 'idle', false],
    ]);
    assert.deepEqual(at(new Map([['w2', true]])), [
      ['w1', 'stuck', null],
      ['w2', 'quiet', true],
      ['w3', 'quiet', null],
    ]);
  });
});

describe('buildModel per request revision', () => {
  const ts = (s) => `2026-10-10 09:00:${String(s).padStart(2, '0')}`;
  const ev = (seq, revision, actor, name, kind, payload) => ({ seq, ts: ts(seq), actor, name, kind, payload, revision });
  const raw = [
    ev(1, 1, 'p', 'supervisor', 'request', { revision: 1, text: '# Spec' }),
    ev(2, 1, 'p', 'supervisor', 'task_create', { task_id: 1, title: 'Old title', description: 'd' }),
    ev(3, 1, 'a', 'wa', 'task_claim', { task_id: 1 }),
    ev(4, 2, 'p', 'supervisor', 'request', { revision: 2, text: 'Change' }),
    ev(5, 2, 'p', 'supervisor', 'task_update', { task_id: 1, title: 'New title' }),
    ev(6, 2, 'a', 'wa', 'worker_woken', { worker: 'wa', reason: 'request', state: 'working' }),
    ev(7, 2, 'a', 'wa', 'outcome_refused', { worker: 'wa', outcome: 'complete', expected_revision: 1, revision: 2 }),
    ev(8, 2, 'a', 'wa', 'outcome', { worker: 'wa', outcome: 'complete', summary: 'Done', expected_revision: 2 }),
  ];
  const { events, acked } = parseExport({ events: raw, workers: [{ worker: 'wa', running: false, acked: 2 }] });
  const m = buildModel(events, { parent: 'p', state: 'running' }, Date.parse('2026-10-10T09:01:00Z'), { acked });

  it('records a retitle under the revision it was made in, with the old title', () => {
    const [task] = m.tasks;
    assert.equal(task.subject, 'New title');
    assert.deepEqual(task.retitles.map((r) => [r.from, r.to, r.revision, r.who]), [['Old title', 'New title', 2, 'supervisor']]);
    assert.deepEqual(m.revisions[1].retitles.map((r) => r.taskId), [1]);
  });

  it('shows a refused declaration under the revision that refused it, on the timeline too', () => {
    assert.deepEqual(m.revisions[1].refused.map((r) => [r.who, r.outcome, r.expected]), [['wa', 'complete', 1]]);
    assert.deepEqual(m.revisions[0].refused, []);
    assert.ok(m.timeline.wa.some((x) => x.type === 'refused' && x.rev === 2));
    assert.deepEqual(m.revisions[1].first.map((x) => x.who), ['wa']);
    assert.equal(m.workers[0].acked, 2);
    assert.equal(m.swarm.revision, 2);
  });
});

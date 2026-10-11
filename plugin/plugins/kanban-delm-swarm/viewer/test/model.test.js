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
    const r = main('export', { dir, since: 0 });
    m = buildModel(parseExport(r).events, { listId: path.basename(dir), ...registry(dir) });
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

  it('lists requests after the spec, findings, publications and applies', () => {
    assert.deepEqual(m.requests.map((r) => [r.revision, r.who]), [[2, 'supervisor']]);
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
    m = buildModel(events, { listId: path.basename(dir), ...registry(dir) }, Date.now(), running);
  });

  after(() => fs.rmSync(config, { recursive: true, force: true }));

  it('shows the waiter as working again after a no-producer wake, and remembers why', () => {
    const w2 = m.workers.find((w) => w.name === 'w2-a3f9c2');
    assert.deepEqual([w2.status.state, w2.status.woken, w2.status.wokeFor], ['working', 'no_producer', 'task:9']);
  });

  it('reads from the store whose turn runs: the woken worker runs, the one that declared blocked sleeps', () => {
    assert.deepEqual(
      m.workers.map((w) => [w.name, w.running, w.health]),
      [
        ['w1-a3f9c2', false, 'blocked'],
        ['w2-a3f9c2', true, 'quiet'],
        ['w3-a3f9c2', true, 'stopped'],
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
    const at = (running) => buildModel(events, { state: 'running' }, t(30), running).workers.map((w) => [w.name, w.health, w.running]);
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

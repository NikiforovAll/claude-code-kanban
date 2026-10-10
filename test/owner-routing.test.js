const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ownerLinks, moveRecipients } = require('../lib/owner-routing');

const PARENT = '11111111-1111-4111-8111-111111111111';

function inputs({ dispatched = {}, maps = {}, names = {} } = {}) {
  const metadata = Object.fromEntries(Object.entries(names).map(([id, agentName]) => [id, { agentName }]));
  return {
    dispatched: { entries: () => Object.entries(dispatched), get: (id) => dispatched[id] || null },
    listToSessions: maps,
    metadata: () => metadata,
  };
}

const link = (list, owner, i) => ownerLinks(new Set([list]), i)(list, owner);

describe('ownerLinks', () => {
  it('links an owner on a custom list through the task map', () => {
    const i = inputs({ maps: { 'swarm-x': { w1: {}, w2: {} } }, names: { w1: 'worker-1', w2: 'worker-2' } });
    assert.equal(link('swarm-x', 'worker-2', i), 'w2');
  });

  it('matches the whole name, so worker-1 does not link worker-10', () => {
    const i = inputs({ maps: { l: { a: {}, b: {} } }, names: { a: 'worker-1', b: 'worker-10' } });
    assert.equal(link('l', 'worker-1', i), 'a');
    assert.equal(link('l', 'worker-10', i), 'b');
    assert.equal(link('l', 'worker', i), null);
  });

  it('gives no link for a name two sessions share', () => {
    const i = inputs({ maps: { l: { a: {}, b: {} } }, names: { a: 'dup', b: 'dup' } });
    assert.equal(link('l', 'dup', i), null);
  });

  it('counts a session found both ways once', () => {
    const i = inputs({ dispatched: { c: { parent: PARENT } }, maps: { [PARENT]: { c: {} } }, names: { c: 'child' } });
    assert.equal(link(PARENT, 'child', i), 'c');
  });

  it('links a dispatched child on its parent own list with no task map', () => {
    const i = inputs({ dispatched: { c: { parent: PARENT } }, names: { c: 'child' } });
    assert.equal(link(PARENT, 'child', i), 'c');
  });

  it('reads no metadata when the list has no candidates', () => {
    const i = { ...inputs(), metadata: () => assert.fail('metadata read') };
    assert.equal(link('empty', 'x', i), null);
  });
});

describe('moveRecipients', () => {
  const swarm = (extra = {}) =>
    inputs({
      dispatched: { w1: { parent: PARENT }, w2: { parent: PARENT }, ...extra.dispatched },
      maps: { 'swarm-x': { w1: {}, w2: {}, ...extra.onList } },
      names: { w1: 'worker-1', w2: 'worker-2' },
    });

  it('sends an owned move to the owner alone', () => {
    assert.deepEqual(moveRecipients('swarm-x', 'worker-2', swarm()), ['w2']);
  });

  it('sends an unowned move to the one parent', () => {
    assert.deepEqual(moveRecipients('swarm-x', undefined, swarm()), [PARENT]);
  });

  it('sends a move whose owner links to no session to the parent', () => {
    assert.deepEqual(moveRecipients('swarm-x', 'nobody', swarm()), [PARENT]);
  });

  it('sends nothing when the list has two parents', () => {
    const i = swarm({ dispatched: { w3: { parent: 'other' } }, onList: { w3: {} } });
    assert.deepEqual(moveRecipients('swarm-x', undefined, i), []);
  });

  it('sends nothing when no session on the list was dispatched', () => {
    const i = inputs({ maps: { l: { a: {}, b: {} } } });
    assert.deepEqual(moveRecipients('l', undefined, i), []);
  });

  it('treats a parent on the list as the orchestrator, not its own parent', () => {
    const i = swarm({ dispatched: { [PARENT]: { parent: 'grandparent' } }, onList: { [PARENT]: {} } });
    assert.deepEqual(moveRecipients('swarm-x', undefined, i), [PARENT]);
  });

  it('leaves a session own list to the old routing, even with a task map and a child owner', () => {
    const i = inputs({ dispatched: { c: { parent: PARENT } }, maps: { [PARENT]: { c: {} } }, names: { c: 'child' } });
    assert.equal(moveRecipients(PARENT, 'child', i), null);
  });

  it('leaves a list with no task map to the old routing', () => {
    assert.equal(moveRecipients('team-a', 'worker-1', inputs()), null);
  });
});

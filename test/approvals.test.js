const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeRequestId, buildDecision, decisionFileName, waitSecondsFrom, isLapsed } = require('../lib/approvals');

const PERM_MARKER = { status: 'waiting', kind: 'permission', id: 'abc-123', toolName: 'Bash', timestamp: '2026-08-25T10:00:00Z' };
const Q_MARKER = { status: 'waiting', kind: 'question', id: 'q-456', toolName: 'AskUserQuestion', timestamp: '2026-08-25T10:00:00Z' };

describe('sanitizeRequestId', () => {
  it('accepts uuids and the hook fallback compound', () => {
    assert.equal(sanitizeRequestId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
    assert.equal(sanitizeRequestId('1787600872123456789-421-12345'), '1787600872123456789-421-12345');
  });

  it('rejects traversal, separators, and non-strings', () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', 'a.b', '', null, undefined, 42, 'x'.repeat(65)]) {
      assert.equal(sanitizeRequestId(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('buildDecision — marker/id pairing (D8)', () => {
  it('410 when there is no marker', () => {
    assert.deepEqual(buildDecision(null, { id: 'abc-123', behavior: 'allow' }), { error: 'No pending ask', status: 410 });
  });

  it('410 when the marker is not waiting', () => {
    const r = buildDecision({ ...PERM_MARKER, status: 'resolved' }, { id: 'abc-123', behavior: 'allow' });
    assert.equal(r.status, 410);
  });

  it('409 when the id does not match the live marker', () => {
    const r = buildDecision(PERM_MARKER, { id: 'stale-id', behavior: 'allow' });
    assert.equal(r.status, 409);
  });

  it('400 on a missing or malformed id', () => {
    assert.equal(buildDecision(PERM_MARKER, { behavior: 'allow' }).status, 400);
    assert.equal(buildDecision(PERM_MARKER, { id: '../../etc', behavior: 'allow' }).status, 400);
  });
});

describe('buildDecision — kind validation (D7)', () => {
  it('rejects a question answer on a permission ask', () => {
    const r = buildDecision(PERM_MARKER, { id: 'abc-123', answers: { 0: 'A' } });
    assert.equal(r.status, 422);
  });

  it('rejects approve/deny on a question ask', () => {
    const r = buildDecision(Q_MARKER, { id: 'q-456', behavior: 'allow' });
    assert.equal(r.status, 422);
  });
});

describe('buildDecision — permission decisions', () => {
  it('shapes a bare allow', () => {
    assert.deepEqual(buildDecision(PERM_MARKER, { id: 'abc-123', behavior: 'allow' }), { decision: { behavior: 'allow' } });
  });

  it('shapes a deny with message', () => {
    assert.deepEqual(
      buildDecision(PERM_MARKER, { id: 'abc-123', behavior: 'deny', message: 'nope' }),
      { decision: { behavior: 'deny', message: 'nope' } }
    );
  });

  it('passes through updatedPermissions and updatedInput, drops junk fields', () => {
    const { decision } = buildDecision(PERM_MARKER, {
      id: 'abc-123',
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules' }],
      updatedInput: { command: 'ls' },
      extra: 'dropped',
      message: 42
    });
    assert.deepEqual(decision, {
      behavior: 'allow',
      updatedInput: { command: 'ls' },
      updatedPermissions: [{ type: 'addRules' }]
    });
  });

  it('rejects behaviors other than allow/deny', () => {
    assert.equal(buildDecision(PERM_MARKER, { id: 'abc-123', behavior: 'ask' }).status, 422);
  });
});

describe('buildDecision — plan decisions (#40)', () => {
  // ExitPlanMode markers (kind "plan") take the permission shape; the gate
  // echoes tool_input as updatedInput on allow, so the board only sends
  // behavior (+ feedback message on reject).
  const PLAN_MARKER = { status: 'waiting', kind: 'plan', id: 'plan-1' };

  it('shapes a plan approve', () => {
    assert.deepEqual(buildDecision(PLAN_MARKER, { id: 'plan-1', behavior: 'allow' }), { decision: { behavior: 'allow' } });
  });

  it('shapes a plan reject with feedback', () => {
    assert.deepEqual(
      buildDecision(PLAN_MARKER, { id: 'plan-1', behavior: 'deny', message: 'tighten phase 2' }),
      { decision: { behavior: 'deny', message: 'tighten phase 2' } }
    );
  });

  it('rejects a plan response without behavior', () => {
    assert.equal(buildDecision(PLAN_MARKER, { id: 'plan-1', answers: { q: 'a' } }).status, 422);
  });
});

describe('buildDecision — question decisions', () => {
  it('shapes answers', () => {
    assert.deepEqual(
      buildDecision(Q_MARKER, { id: 'q-456', answers: { 0: 'Option A' } }),
      { decision: { answers: { 0: 'Option A' } } }
    );
  });

  const TWO_Q_MARKER = {
    ...Q_MARKER,
    toolInput: JSON.stringify({
      questions: [
        { question: 'Color?', options: [{ label: 'Red' }] },
        { question: 'Size?', options: [{ label: 'Big' }] },
      ],
    }),
  };

  it('accepts partial answers, dropping empty values', () => {
    assert.deepEqual(
      buildDecision(TWO_Q_MARKER, { id: 'q-456', answers: { 'Color?': 'Red', 'Size?': '' } }),
      { decision: { answers: { 'Color?': 'Red' } } }
    );
  });

  it('rejects an answers object with nothing usable in it', () => {
    assert.equal(buildDecision(TWO_Q_MARKER, { id: 'q-456', answers: {} }).status, 422);
    assert.equal(buildDecision(TWO_Q_MARKER, { id: 'q-456', answers: { 'Size?': '' } }).status, 422);
  });

  it('accepts array answers for multiSelect, rejects empty or non-string arrays', () => {
    assert.deepEqual(
      buildDecision(TWO_Q_MARKER, { id: 'q-456', answers: { 'Color?': ['Red', 'Blue'] } }),
      { decision: { answers: { 'Color?': ['Red', 'Blue'] } } }
    );
    assert.equal(buildDecision(TWO_Q_MARKER, { id: 'q-456', answers: { 'Color?': [] } }).status, 422);
    assert.equal(buildDecision(TWO_Q_MARKER, { id: 'q-456', answers: { 'Color?': ['Red', 7] } }).status, 422);
  });

  it('accepts complete answers', () => {
    assert.deepEqual(
      buildDecision(TWO_Q_MARKER, { id: 'q-456', answers: { 'Color?': 'Red', 'Size?': 'Big' } }),
      { decision: { answers: { 'Color?': 'Red', 'Size?': 'Big' } } }
    );
  });
});

describe('decisionFileName', () => {
  it('matches the file the hook polls for', () => {
    assert.equal(decisionFileName('abc-123'), '_decision-abc-123.json');
  });
});

// Pins the parity with approval-gate.sh's own parse (default 30, clamp 1800):
// if either side changes alone, the board's lapse gating desyncs from the
// hook's actual deadline.
describe('waitSecondsFrom', () => {
  it('defaults to the gate default of 30', () => {
    assert.equal(waitSecondsFrom(null), 30);
    assert.equal(waitSecondsFrom({}), 30);
    assert.equal(waitSecondsFrom({ waitSeconds: '60' }), 30);
    assert.equal(waitSecondsFrom({ waitSeconds: -5 }), 30);
    assert.equal(waitSecondsFrom({ waitSeconds: 1.5 }), 30);
  });

  it('clamps to the gate cap of 1800', () => {
    assert.equal(waitSecondsFrom({ waitSeconds: 7200 }), 1800);
    assert.equal(waitSecondsFrom({ waitSeconds: 1800 }), 1800);
  });

  it('passes valid values through', () => {
    assert.equal(waitSecondsFrom({ waitSeconds: 0 }), 0);
    assert.equal(waitSecondsFrom({ waitSeconds: 600 }), 600);
  });
});

describe('isLapsed', () => {
  const T0 = Date.parse('2026-08-25T10:00:00Z');
  const WAIT_MS = 30 * 1000;

  it('is fresh within waitSeconds plus the 5s grace', () => {
    assert.equal(isLapsed('2026-08-25T10:00:00Z', WAIT_MS, T0 + 34 * 1000), false);
    assert.equal(isLapsed('2026-08-25T10:00:00Z', WAIT_MS, T0 + 35 * 1000), false);
  });

  it('lapses past waitSeconds plus grace', () => {
    assert.equal(isLapsed('2026-08-25T10:00:00Z', WAIT_MS, T0 + 35 * 1000 + 1), true);
  });

  it('treats a missing timestamp as lapsed', () => {
    assert.equal(isLapsed(undefined, WAIT_MS, T0), true);
    assert.equal(isLapsed('', WAIT_MS, T0), true);
  });
});

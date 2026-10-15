const { test } = require('node:test');
const assert = require('node:assert/strict');
const { foldAgentLines } = require('../lib/agent-log');

const jsonl = (...objs) => `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`;

test('later lines win within a run', () => {
  const agent = foldAgentLines(
    jsonl(
      { agentId: 'a1', type: 'general-purpose', event: 'start', status: 'active', startedAt: 't1' },
      { agentId: 'a1', event: 'stop', status: 'stopped', stoppedAt: 't2', lastMessage: 'done' },
    ),
  );
  assert.deepEqual(agent, {
    agentId: 'a1',
    type: 'general-purpose',
    event: 'stop',
    status: 'stopped',
    startedAt: 't1',
    stoppedAt: 't2',
    lastMessage: 'done',
  });
});

test('a start line drops the run before it', () => {
  const agent = foldAgentLines(
    jsonl(
      { agentId: 'a1', type: 'general-purpose', event: 'start', status: 'active', prompt: 'first', startedAt: 't1' },
      { agentId: 'a1', event: 'stop', status: 'stopped', stoppedAt: 't2' },
      { agentId: 'a1', event: 'server-update', lastMessage: 'first answer', resultUnavailable: 1, modelUnavailable: 1 },
      { agentId: 'a1', type: 'general-purpose', event: 'start', status: 'active', prompt: 'second', startedAt: 't3' },
    ),
  );
  assert.deepEqual(agent, {
    agentId: 'a1',
    type: 'general-purpose',
    event: 'start',
    status: 'active',
    prompt: 'second',
    startedAt: 't3',
  });
});

test('a malformed line is skipped', () => {
  assert.deepEqual(foldAgentLines('{"agentId":"a1"}\nnot json\r\n{"status":"active"}\n'), {
    agentId: 'a1',
    status: 'active',
  });
});

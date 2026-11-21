const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSessionDigest } = require('../lib/parsers');

const toolUse = (id, name, input) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, toolUseResult, timestamp) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ tool_use_id: id, type: 'tool_result', content: 'started' }] },
    timestamp,
    toolUseResult,
  });
const notification = (taskId, body, timestamp) =>
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp,
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n${body}\n</task-notification>`,
  });

async function tasksOf(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-tasks-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  try {
    return (await buildSessionDigest(file)).backgroundTasks;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('background tasks in the session digest', () => {
  it('a background shell runs until its notification has a status', async () => {
    const start = [
      toolUse('tu1', 'Bash', { command: 'npm test', description: 'Run tests', run_in_background: true }),
      toolResult('tu1', { stdout: '', backgroundTaskId: 'b1' }, '2026-01-01T10:00:00.000Z'),
    ];
    assert.deepEqual(await tasksOf(start), [
      {
        taskId: 'b1',
        kind: 'shell',
        description: 'Run tests',
        command: 'npm test',
        startedAt: '2026-01-01T10:00:00.000Z',
        endedAt: null,
        outputFile: null,
      },
    ]);
    const [done] = await tasksOf([
      ...start,
      notification('b1', '<status>failed</status>\n<summary>exit code 1</summary>', '2026-01-01T10:01:00.000Z'),
      notification('b1', '<status>completed</status>', '2026-01-01T10:02:00.000Z'),
    ]);
    assert.equal(done.status, 'failed');
    assert.equal(done.endedAt, '2026-01-01T10:01:00.000Z');
  });

  it('a monitor event without a status does not end the monitor', async () => {
    const lines = [
      toolUse('tu2', 'Monitor', { command: 'tail -f log', description: 'Watch log', timeout_ms: 60000 }),
      toolResult('tu2', { taskId: 'm1', timeoutMs: 60000, persistent: false }, '2026-01-01T10:00:00.000Z'),
      notification('m1', '<summary>Monitor event: "Watch log"</summary>\n<event>one</event>', '2026-01-01T10:00:05.000Z'),
    ];
    const [running] = await tasksOf(lines);
    assert.equal(running.kind, 'monitor');
    assert.equal(running.endedAt, null);
    const [ended] = await tasksOf([
      ...lines,
      notification('m1', '<status>completed</status>\n<summary>stream ended</summary>', '2026-01-01T10:00:09.000Z'),
    ]);
    assert.equal(ended.status, 'completed');
  });

  it('TaskStop ends a task without a notification', async () => {
    const [task] = await tasksOf([
      toolUse('tu1', 'Bash', { command: 'sleep 400', run_in_background: true }),
      toolResult('tu1', { backgroundTaskId: 'b1' }, '2026-01-01T10:00:00.000Z'),
      toolUse('tu4', 'TaskStop', { task_id: 'b1' }),
      toolResult('tu4', { message: 'Successfully stopped task: b1', task_id: 'b1' }, '2026-01-01T10:00:30.000Z'),
    ]);
    assert.equal(task.status, 'stopped');
    assert.equal(task.endedAt, '2026-01-01T10:00:30.000Z');
  });

  it('a monitor gets its output file from the folder of another task', async () => {
    const dir = path.join(os.tmpdir(), 'claude', 'tasks');
    const shellStart = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            tool_use_id: 'tu1',
            type: 'tool_result',
            content: `Command running in background with ID: b1. Output is being written to: ${path.join(dir, 'b1.output')}. You will be notified.`,
          },
        ],
      },
      timestamp: '2026-01-01T10:00:00.000Z',
      toolUseResult: { backgroundTaskId: 'b1' },
    });
    const tasks = await tasksOf([
      toolUse('tu1', 'Bash', { command: 'npm test', run_in_background: true }),
      shellStart,
      toolUse('tu2', 'Monitor', { command: 'tail -f log', description: 'Watch log' }),
      toolResult('tu2', { taskId: 'm1', timeoutMs: 60000, persistent: false }, '2026-01-01T10:00:01.000Z'),
    ]);
    assert.deepEqual(
      tasks.map((t) => t.outputFile),
      [path.join(dir, 'b1.output'), path.join(dir, 'm1.output')],
    );
  });

  it('a taskId from another tool is not a background task', async () => {
    const tasks = await tasksOf([
      toolUse('tu3', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      toolResult('tu3', { success: true, taskId: '1' }, '2026-01-01T10:00:00.000Z'),
    ]);
    assert.deepEqual(tasks, []);
  });
});

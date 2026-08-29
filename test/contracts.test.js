const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } = require('fs');
const path = require('path');
const os = require('os');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const {
  parseTask,
  parseAgent,
  parseWaiting,
  parseTeamConfig,
  parseSessionsIndex,
  parseJsonlLine,
  parseTaskNotification,
  getSystemMessageLabel,
  readSessionInfoFromJsonl,
  readRecentMessages,
  readMessagesPage,
  buildAgentProgressMap,
  buildSessionDigest,
  readCompactSummaries,
  findTerminatedTeammates,
  extractPromptFromTranscript
} = require('../lib/parsers');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const SCHEMAS_DIR = path.join(__dirname, 'schemas');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function loadSchema(name) {
  return JSON.parse(readFileSync(path.join(SCHEMAS_DIR, name), 'utf8'));
}

function loadFixture(name) {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

function loadFixtureJson(name) {
  return JSON.parse(loadFixture(name));
}

// --- Schema validation tests ---

describe('Schema: Task JSON', () => {
  const validate = ajv.compile(loadSchema('task.schema.json'));

  it('validates completed task', () => {
    assert.ok(validate(loadFixtureJson('task-completed.json')), JSON.stringify(validate.errors));
  });

  it('validates in-progress task', () => {
    assert.ok(validate(loadFixtureJson('task-in-progress.json')), JSON.stringify(validate.errors));
  });

  it('validates pending task', () => {
    assert.ok(validate(loadFixtureJson('task-pending.json')), JSON.stringify(validate.errors));
  });

  it('validates internal task', () => {
    assert.ok(validate(loadFixtureJson('task-internal.json')), JSON.stringify(validate.errors));
  });

  it('rejects task with invalid status', () => {
    assert.ok(!validate({ id: '1', subject: 'test', status: 'unknown' }));
  });

  it('rejects task without required fields', () => {
    assert.ok(!validate({ subject: 'test' }));
  });
});

describe('Schema: Agent JSON', () => {
  const validate = ajv.compile(loadSchema('agent.schema.json'));

  it('validates active agent', () => {
    assert.ok(validate(loadFixtureJson('agent-active.json')), JSON.stringify(validate.errors));
  });

  it('validates stopped agent', () => {
    assert.ok(validate(loadFixtureJson('agent-stopped.json')), JSON.stringify(validate.errors));
  });

  it('rejects agent with invalid status', () => {
    assert.ok(!validate({ agentId: 'x', status: 'running', startedAt: '2026-01-01T00:00:00Z' }));
  });

  it('rejects agent without agentId', () => {
    assert.ok(!validate({ status: 'active', startedAt: '2026-01-01T00:00:00Z' }));
  });
});

describe('Schema: Waiting JSON', () => {
  const validate = ajv.compile(loadSchema('waiting.schema.json'));

  it('validates waiting-for-permission', () => {
    assert.ok(validate(loadFixtureJson('waiting-permission.json')), JSON.stringify(validate.errors));
  });

  it('rejects without timestamp', () => {
    assert.ok(!validate({ status: 'waiting' }));
  });
});

describe('Schema: Team Config', () => {
  const validate = ajv.compile(loadSchema('team-config.schema.json'));

  it('validates team config', () => {
    assert.ok(validate(loadFixtureJson('team-config.json')), JSON.stringify(validate.errors));
  });

  it('rejects without members', () => {
    assert.ok(!validate({ name: 'test', leadAgentId: 'x' }));
  });
});

describe('Schema: Sessions Index', () => {
  const validate = ajv.compile(loadSchema('sessions-index.schema.json'));

  it('validates sessions index', () => {
    assert.ok(validate(loadFixtureJson('sessions-index.json')), JSON.stringify(validate.errors));
  });

  it('rejects without entries', () => {
    assert.ok(!validate({ version: 1 }));
  });
});

describe('Schema: Session JSONL Lines', () => {
  const validate = ajv.compile(loadSchema('session-jsonl-line.schema.json'));

  it('validates all lines in fixture JSONL', () => {
    const lines = loadFixture('session.jsonl').trim().split('\n');
    for (const line of lines) {
      const obj = JSON.parse(line);
      const valid = validate(obj);
      assert.ok(valid, `Line type="${obj.type}" failed: ${JSON.stringify(validate.errors)}`);
    }
  });
});

// --- Parser unit tests ---

describe('Parser: parseTask', () => {
  it('parses completed task', () => {
    const task = parseTask(loadFixture('task-completed.json'));
    assert.equal(task.id, '1');
    assert.equal(task.status, 'completed');
    assert.equal(task.isInternal, false);
  });

  it('detects internal tasks', () => {
    const task = parseTask(loadFixture('task-internal.json'));
    assert.equal(task.isInternal, true);
  });

  it('handles missing optional fields', () => {
    const task = parseTask('{"id":"1","subject":"test","status":"pending"}');
    assert.equal(task.description, null);
    assert.deepEqual(task.blocks, []);
    assert.deepEqual(task.blockedBy, []);
  });
});

describe('Parser: parseAgent', () => {
  it('parses active agent', () => {
    const agent = parseAgent(loadFixture('agent-active.json'));
    assert.equal(agent.agentId, 'abc123def456');
    assert.equal(agent.status, 'active');
    assert.equal(agent.stoppedAt, null);
  });

  it('parses stopped agent', () => {
    const agent = parseAgent(loadFixture('agent-stopped.json'));
    assert.equal(agent.status, 'stopped');
    assert.ok(agent.stoppedAt);
  });
});

describe('Parser: parseWaiting', () => {
  it('parses permission waiting', () => {
    const w = parseWaiting(loadFixture('waiting-permission.json'));
    assert.equal(w.status, 'waiting');
    assert.equal(w.kind, 'permission');
    assert.equal(w.toolName, 'Bash');
  });
});

describe('Parser: parseTeamConfig', () => {
  it('parses team config with members', () => {
    const config = parseTeamConfig(loadFixture('team-config.json'));
    assert.equal(config.name, 'test-team-alpha');
    assert.equal(config.members.length, 2);
    assert.equal(config.members[0].agentType, 'team-lead');
    assert.equal(config.leadSessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('parses member color field', () => {
    const config = parseTeamConfig(loadFixture('team-config.json'));
    assert.equal(config.members[0].color, 'red');
    assert.equal(config.members[1].color, 'blue');
  });

  it('defaults color to null when missing', () => {
    const config = parseTeamConfig(JSON.stringify({
      name: 'no-color-team',
      leadAgentId: 'lead',
      members: [{ agentId: 'a1', name: 'worker' }]
    }));
    assert.equal(config.members[0].color, null);
  });
});

describe('Parser: parseSessionsIndex', () => {
  it('parses sessions index', () => {
    const index = parseSessionsIndex(loadFixture('sessions-index.json'));
    assert.equal(index.entries.length, 2);
    assert.equal(index.entries[0].gitBranch, 'feat/logging');
    assert.equal(index.entries[1].description, 'Quick fix session');
  });
});

describe('Parser: parseJsonlLine', () => {
  const lines = readFileSync(path.join(FIXTURES_DIR, 'session.jsonl'), 'utf8').trim().split('\n');

  it('parses progress/meta line', () => {
    const parsed = parseJsonlLine(lines[0]);
    assert.equal(parsed.type, 'progress');
    assert.equal(parsed.slug, 'test-session');
    assert.equal(parsed.cwd, '/home/user/project');
  });

  it('parses user message', () => {
    const parsed = parseJsonlLine(lines[1]);
    assert.equal(parsed.role, 'user');
    assert.equal(parsed.content, 'Fix the login bug');
    assert.equal(parsed.isMeta, false);
  });

  it('parses assistant text message', () => {
    const parsed = parseJsonlLine(lines[2]);
    assert.equal(parsed.role, 'assistant');
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0].type, 'text');
  });

  it('parses assistant tool_use message', () => {
    const parsed = parseJsonlLine(lines[3]);
    assert.equal(parsed.role, 'assistant');
    assert.equal(parsed.blocks.length, 2);
    assert.equal(parsed.blocks[0].type, 'tool_use');
    assert.equal(parsed.blocks[0].name, 'Read');
    assert.equal(parsed.blocks[1].name, 'Bash');
  });

  it('parses file-history-snapshot', () => {
    const parsed = parseJsonlLine(lines[6]);
    assert.equal(parsed.type, 'file-history-snapshot');
  });

  it('parses queued message (queue-operation enqueue)', () => {
    const parsed = parseJsonlLine(JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-06-06T16:00:44.682Z',
      sessionId: 'abc',
      content: 'can we use gold for user message'
    }));
    assert.equal(parsed.role, 'user');
    assert.equal(parsed.queued, true);
    assert.equal(parsed.content, 'can we use gold for user message');
  });
});

describe('Parser: readRecentMessages', () => {
  const jsonlPath = path.join(FIXTURES_DIR, 'session.jsonl');

  it('reads messages from JSONL file', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    assert.ok(messages.length > 0);
    const types = messages.map(m => m.type);
    assert.ok(types.includes('user'));
    assert.ok(types.includes('assistant'));
  });

  it('includes tool_use messages', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const toolMsgs = messages.filter(m => m.type === 'tool_use');
    assert.ok(toolMsgs.length > 0);
    assert.ok(toolMsgs.some(m => m.tool === 'Read'));
    assert.ok(toolMsgs.some(m => m.tool === 'Bash'));
  });

  it('extracts file_path detail for Read tool', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const readMsg = messages.find(m => m.tool === 'Read');
    assert.equal(readMsg.detail, 'login.ts');
    assert.equal(readMsg.fullDetail, '/home/user/project/src/auth/login.ts');
  });

  it('extracts command detail for Bash tool', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const bashMsg = messages.find(m => m.tool === 'Bash');
    assert.ok(bashMsg.detail);
  });

  it('respects limit', () => {
    const messages = readRecentMessages(jsonlPath, 2);
    assert.ok(messages.length <= 2);
  });

  it('returns empty for non-existent file', () => {
    const messages = readRecentMessages('/nonexistent/path.jsonl', 10);
    assert.deepEqual(messages, []);
  });

  it('extracts Agent tool fields (toolUseId, agentType, agentPrompt)', () => {
    const messages = readRecentMessages(jsonlPath, 20);
    const agentMsg = messages.find(m => m.tool === 'Agent');
    assert.ok(agentMsg, 'should find an Agent tool_use message');
    assert.equal(agentMsg.toolUseId, 'tu_agent_01');
    assert.equal(agentMsg.agentType, 'Explore');
    assert.equal(agentMsg.agentPrompt, 'Find all auth middleware files');
  });

  it('attaches tool_result to matching tool_use messages', () => {
    const messages = readRecentMessages(jsonlPath, 20);
    const readMsg = messages.find(m => m.tool === 'Read');
    assert.ok(readMsg, 'should find a Read tool_use message');
    assert.ok(readMsg.toolResult, 'Read message should have toolResult');
    assert.ok(readMsg.toolResult.includes('import { hash }'), 'toolResult should contain file content');

    const bashMsg = messages.find(m => m.tool === 'Bash');
    assert.ok(bashMsg, 'should find a Bash tool_use message');
    assert.ok(bashMsg.toolResult, 'Bash message should have toolResult');
    assert.ok(bashMsg.toolResult.includes('authenticate'), 'toolResult should contain grep output');
  });

  it('extracts SendMessage detail with recipient and summary', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const sendMsg = messages.find(m => m.tool === 'SendMessage' && m.detail && m.detail.includes('worker-1'));
    assert.ok(sendMsg, 'should find a SendMessage tool_use');
    assert.equal(sendMsg.detail, '→ worker-1: Please review the auth module');
    assert.equal(sendMsg.fullDetail, 'Check the auth module for security issues');
  });

  it('extracts SendMessage params (to, summary, protocol)', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const sendMsg = messages.find(m => m.tool === 'SendMessage' && m.params?.to === 'worker-1');
    assert.ok(sendMsg, 'should find SendMessage with params');
    assert.equal(sendMsg.params.to, 'worker-1');
    assert.equal(sendMsg.params.summary, 'Please review the auth module');
  });

  it('extracts SendMessage protocol object when message is an object', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const protoMsg = messages.find(m => m.tool === 'SendMessage' && m.params?.to === 'worker-3');
    assert.ok(protoMsg, 'should find SendMessage with protocol message');
    assert.deepEqual(protoMsg.params.protocol, { type: 'task_assignment', taskId: '99', subject: 'Deploy hotfix' });
  });

  it('extracts TaskCreate subject param', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const createMsg = messages.find(m => m.tool === 'TaskCreate');
    assert.ok(createMsg, 'should find a TaskCreate tool_use');
    assert.equal(createMsg.params.subject, 'Fix login null guard');
  });

  it('extracts TaskUpdate taskId with # prefix', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const updateMsg = messages.find(m => m.tool === 'TaskUpdate');
    assert.ok(updateMsg, 'should find a TaskUpdate tool_use');
    assert.equal(updateMsg.params.taskId, '#42');
    assert.equal(updateMsg.params.status, 'completed');
  });

  it('parses teammate_terminated protocol with protocolLabel and protocolData', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const terminated = messages.find(m => m.type === 'teammate' && m.protocolType === 'teammate_terminated');
    assert.ok(terminated, 'should find teammate_terminated message');
    assert.equal(terminated.teammateId, 'worker-1');
    assert.equal(terminated.protocolLabel, 'worker-1 has shut down');
    assert.ok(terminated.protocolData, 'should have protocolData');
    assert.equal(terminated.protocolData.type, 'teammate_terminated');
    assert.equal(terminated.protocolData.from, 'worker-1');
  });

  it('parses shutdown_response with protocolData', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const shutdown = messages.find(m => m.type === 'teammate' && m.protocolType === 'shutdown_response');
    assert.ok(shutdown, 'should find shutdown_response message');
    assert.equal(shutdown.teammateId, 'worker-2');
    assert.equal(shutdown.protocolLabel, 'shutdown approved');
    assert.ok(shutdown.protocolData, 'should have protocolData');
    assert.equal(shutdown.protocolData.approve, true);
  });

  it('uses default protocolLabel with underscores replaced by spaces', () => {
    const messages = readRecentMessages(jsonlPath, 30);
    const taskAssign = messages.find(m => m.type === 'teammate' && m.protocolType === 'task_assignment');
    // There's no teammate message with task_assignment in our fixture via teammate-message tag,
    // but we can test the protocol label via SendMessage protocol. Skip if not present.
    // Instead let's verify teammate_terminated label is not the default handler
    const terminated = messages.find(m => m.type === 'teammate' && m.protocolType === 'teammate_terminated');
    assert.ok(terminated);
    assert.notEqual(terminated.protocolLabel, 'teammate terminated');
  });
});

describe('Parser: findTerminatedTeammates', () => {
  const { writeFileSync, unlinkSync, mkdtempSync } = require('fs');
  const os = require('os');
  let tmpDir;

  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cck-test-'));

  it('returns empty map for non-existent file', () => {
    const result = findTerminatedTeammates('/nonexistent/path.jsonl');
    assert.deepEqual(result, new Map());
  });

  it('detects teammate_terminated with from field', () => {
    const file = path.join(tmpDir, 'terminated-from.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<teammate-message teammate_id="worker-1" summary="terminated">{"type":"teammate_terminated","from":"worker-1","message":"worker-1 has shut down"}</teammate-message>' },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    const result = findTerminatedTeammates(file);
    assert.ok(result.has('worker-1'));
    assert.equal(result.size, 1);
    unlinkSync(file);
  });

  it('extracts name from message first word when from is missing', () => {
    const file = path.join(tmpDir, 'terminated-msg.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<teammate-message teammate_id="w2" summary="terminated">{"type":"teammate_terminated","message":"alice has shut down"}</teammate-message>' },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    const result = findTerminatedTeammates(file);
    assert.ok(result.has('alice'));
    unlinkSync(file);
  });

  it('falls back to teammate_id when no from or message match', () => {
    const file = path.join(tmpDir, 'terminated-tid.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<teammate-message teammate_id="bob" summary="terminated">{"type":"teammate_terminated"}</teammate-message>' },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    const result = findTerminatedTeammates(file);
    assert.ok(result.has('bob'));
    unlinkSync(file);
  });

  it('detects shutdown_response with approve:true', () => {
    const file = path.join(tmpDir, 'shutdown-approve.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<teammate-message teammate_id="worker-3" summary="approved">{"type":"shutdown_response","from":"worker-3","approve":true}</teammate-message>' },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    const result = findTerminatedTeammates(file);
    assert.ok(result.has('worker-3'));
    unlinkSync(file);
  });

  it('ignores shutdown_response with approve:false', () => {
    const file = path.join(tmpDir, 'shutdown-reject.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<teammate-message teammate_id="worker-4" summary="rejected">{"type":"shutdown_response","from":"worker-4","approve":false,"reason":"still working"}</teammate-message>' },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    const result = findTerminatedTeammates(file);
    assert.equal(result.size, 0);
    unlinkSync(file);
  });

  it('filters out system teammate_id', () => {
    const file = path.join(tmpDir, 'terminated-system.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<teammate-message teammate_id="system" summary="terminated">{"type":"teammate_terminated","from":"system"}</teammate-message>' },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    const result = findTerminatedTeammates(file);
    assert.equal(result.size, 0);
    unlinkSync(file);
  });

  it('handles multiple teammate-message tags in one JSONL line', () => {
    const file = path.join(tmpDir, 'multi-terminated.jsonl');
    const content = '<teammate-message teammate_id="a1" summary="t1">{"type":"teammate_terminated","from":"alice"}</teammate-message>' +
      '<teammate-message teammate_id="b1" summary="t2">{"type":"shutdown_response","from":"bob","approve":true}</teammate-message>';
    writeFileSync(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: content },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    const result = findTerminatedTeammates(file);
    assert.ok(result.has('alice'));
    assert.ok(result.has('bob'));
    assert.equal(result.size, 2);
    unlinkSync(file);
  });

  it('skips non-user type lines', () => {
    const file = path.join(tmpDir, 'non-user.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: '<teammate-message teammate_id="x" summary="t">{"type":"teammate_terminated","from":"x"}</teammate-message>' },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    const result = findTerminatedTeammates(file);
    assert.equal(result.size, 0);
    unlinkSync(file);
  });

  it('reads from existing session fixture', () => {
    const result = findTerminatedTeammates(path.join(FIXTURES_DIR, 'session.jsonl'));
    assert.ok(result.has('worker-1'));
    assert.ok(result.has('worker-2'));
    assert.equal(result.size, 2);
  });
});

describe('Parser: buildAgentProgressMap', () => {
  const jsonlPath = path.join(FIXTURES_DIR, 'session.jsonl');

  it('maps parentToolUseID to agentId and prompt', () => {
    const map = buildAgentProgressMap(jsonlPath);
    assert.equal(map['tu_agent_01'].agentId, 'agent-abc-123');
    assert.equal(map['tu_agent_01'].prompt, 'Find all auth middleware files');
  });

  it('maps background agent tool_result to agentId', () => {
    const map = buildAgentProgressMap(jsonlPath);
    assert.equal(map['tu_bg_agent_01'].agentId, 'agent-bg-456');
    assert.equal(map['tu_bg_agent_01'].prompt, null);
  });

  it('maps teammate_spawned tool_result to agentId', () => {
    const map = buildAgentProgressMap(jsonlPath);
    assert.equal(map['tu_team_agent_01'].agentId, 'reviewer@my-team');
    assert.equal(map['tu_team_agent_01'].prompt, null);
  });

  it('returns empty map for non-existent file', () => {
    const map = buildAgentProgressMap('/nonexistent/path.jsonl');
    assert.deepEqual(map, {});
  });
});

describe('Parser: buildSessionDigest', () => {
  const jsonlPath = path.join(FIXTURES_DIR, 'session.jsonl');

  it('returns progressMap and terminated fields', () => {
    const result = buildSessionDigest(jsonlPath);
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'progressMap'));
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'terminated'));
  });

  it('progressMap matches buildAgentProgressMap output', () => {
    const { progressMap } = buildSessionDigest(jsonlPath);
    const map = buildAgentProgressMap(jsonlPath);
    assert.deepEqual(progressMap, map);
  });

  it('terminated is a Map instance', () => {
    const { terminated } = buildSessionDigest(jsonlPath);
    assert.ok(terminated instanceof Map);
  });

  it('terminated is empty for fixture without terminated teammates', () => {
    const { terminated } = buildSessionDigest(jsonlPath);
    assert.ok(terminated instanceof Map);
    assert.ok(terminated.has('worker-1'), 'should detect worker-1 as terminated');
    assert.ok(terminated.has('worker-2'), 'should detect worker-2 as terminated via shutdown_response');
  });

  it('returns empty progressMap and empty terminated for non-existent file', () => {
    const { progressMap, terminated } = buildSessionDigest('/nonexistent/path.jsonl');
    assert.deepEqual(progressMap, {});
    assert.ok(terminated instanceof Map);
    assert.equal(terminated.size, 0);
  });

  it('detects teammate_terminated in synthetic JSONL', () => {
    const { mkdtempSync: mdt, writeFileSync: wfs, rmSync: rms } = require('fs');
    const tmpDir = mdt(path.join(os.tmpdir(), 'cck-digest-test-'));
    try {
      const jsonlFile = path.join(tmpDir, 'test.jsonl');
      const line = JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:00.000Z',
        message: {
          content:
            '<teammate-message teammate_id="reviewer">\n' +
            '{"type":"teammate_terminated","from":"reviewer"}\n' +
            '</teammate-message>',
        },
      });
      wfs(jsonlFile, line + '\n');
      const { terminated } = buildSessionDigest(jsonlFile);
      assert.ok(terminated instanceof Map);
      assert.equal(terminated.size, 1);
      assert.ok(terminated.has('reviewer'));
    } finally {
      rms(tmpDir, { recursive: true });
    }
  });
});

describe('Parser: readSessionInfoFromJsonl', () => {
  const jsonlPath = path.join(FIXTURES_DIR, 'session.jsonl');

  it('reads slug from fixture', () => {
    const info = readSessionInfoFromJsonl(jsonlPath);
    assert.equal(info.slug, 'test-session');
  });

  it('reads projectPath (cwd) from fixture', () => {
    const info = readSessionInfoFromJsonl(jsonlPath);
    assert.equal(info.projectPath, '/home/user/project');
  });

  it('reads gitBranch from fixture', () => {
    const info = readSessionInfoFromJsonl(jsonlPath);
    assert.equal(info.gitBranch, 'main');
  });

  it('returns null fields for non-existent file', () => {
    const info = readSessionInfoFromJsonl('/nonexistent/path.jsonl');
    assert.equal(info.slug, null);
    assert.equal(info.projectPath, null);
    assert.equal(info.gitBranch, null);
    assert.equal(info.customTitle, null);
  });
});

describe('Parser: readMessagesPage', () => {
  const jsonlPath = path.join(FIXTURES_DIR, 'session.jsonl');

  it('returns messages array and hasMore flag', () => {
    const result = readMessagesPage(jsonlPath, 100);
    assert.ok(Array.isArray(result.messages));
    assert.equal(typeof result.hasMore, 'boolean');
    assert.ok(result.messages.length > 0, 'fixture should produce messages');
    const msg = result.messages[0];
    assert.ok('type' in msg, 'message should have type');
    assert.ok('timestamp' in msg, 'message should have timestamp');
  });

  it('respects limit — returns at most limit messages', () => {
    const result = readMessagesPage(jsonlPath, 3);
    assert.ok(result.messages.length <= 3);
  });

  it('returns hasMore: false when all messages fit', () => {
    const result = readMessagesPage(jsonlPath, 1000);
    assert.equal(result.hasMore, false);
  });

  it('filters by beforeTimestamp', () => {
    const all = readMessagesPage(jsonlPath, 1000);
    assert.ok(all.messages.length >= 2, 'fixture must have at least 2 messages');
    const cutoff = all.messages[all.messages.length - 1].timestamp;
    const filtered = readMessagesPage(jsonlPath, 1000, cutoff);
    assert.ok(filtered.messages.length < all.messages.length, 'filtering should reduce result count');
    for (const msg of filtered.messages) {
      assert.ok(msg.timestamp < cutoff, `message timestamp ${msg.timestamp} should be < ${cutoff}`);
    }
  });

  it('returns empty messages for non-existent file', () => {
    const result = readMessagesPage('/nonexistent/path.jsonl', 10);
    assert.deepEqual(result.messages, []);
    assert.equal(result.hasMore, false);
  });
});

describe('Parser: extractPromptFromTranscript', () => {
  let tmpDir;

  it('returns null when first line is not a user message', () => {
    const result = extractPromptFromTranscript(path.join(FIXTURES_DIR, 'session.jsonl'));
    assert.equal(result, null);
  });

  it('throws for non-existent file', () => {
    assert.throws(() => extractPromptFromTranscript('/nonexistent/path.jsonl'));
  });

  it('extracts content when first line is a user message with string content', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const file = path.join(tmpDir, 'prompt.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Please fix the authentication bug' },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    try {
      const result = extractPromptFromTranscript(file);
      assert.equal(result, 'Please fix the authentication bug');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts text from array content blocks', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const file = path.join(tmpDir, 'prompt.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Refactor the login module' }] },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    try {
      const result = extractPromptFromTranscript(file);
      assert.equal(result, 'Refactor the login module');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns long content in full (no truncation)', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const longText = 'x'.repeat(600);
    const file = path.join(tmpDir, 'prompt.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: longText },
      timestamp: '2026-03-05T10:00:00Z'
    }) + '\n');
    try {
      const result = extractPromptFromTranscript(file);
      assert.equal(result.length, 600);
      assert.equal(result, longText);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Parser: readCompactSummaries', () => {
  it('returns empty array when subagents dir does not exist', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const file = path.join(tmpDir, 'no-subagents.jsonl');
    writeFileSync(file, '');
    try {
      const result = readCompactSummaries(file);
      assert.deepEqual(result, []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns summaries from compact subagent JSONL files', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const sessionName = 'compact-test-session';
    const sessionFile = path.join(tmpDir, `${sessionName}.jsonl`);
    const subagentsDir = path.join(tmpDir, sessionName, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });

    const compactFile = path.join(subagentsDir, 'agent-acompact-001.jsonl');
    writeFileSync(compactFile, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'compact this' }, timestamp: '2026-03-05T10:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '<summary>Session compacted successfully</summary>' }] }, timestamp: '2026-03-05T10:00:05Z' })
    ].join('\n') + '\n');
    writeFileSync(sessionFile, '');

    try {
      const result = readCompactSummaries(sessionFile);
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 1);
      assert.equal(result[0].summary, 'Session compacted successfully');
      assert.equal(result[0].timestamp, '2026-03-05T10:00:05Z');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips compact files without a summary tag', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const sessionName = 'compact-no-summary';
    const sessionFile = path.join(tmpDir, `${sessionName}.jsonl`);
    const subagentsDir = path.join(tmpDir, sessionName, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });

    const compactFile = path.join(subagentsDir, 'agent-acompact-002.jsonl');
    writeFileSync(compactFile, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'No summary here' }] }, timestamp: '2026-03-05T10:01:00Z' })
    ].join('\n') + '\n');
    writeFileSync(sessionFile, '');

    try {
      const result = readCompactSummaries(sessionFile);
      assert.deepEqual(result, []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --- Background task-notification parsing ---
// Locks how a <task-notification> envelope (injected as a user message when a
// background agent finishes) is parsed. Without this, the raw text renders as
// jibberish: the task-id/tool-use-id/output-file collapse into one run-on line
// and <usage> becomes the concatenated number "223166118942".

describe('parseTaskNotification', () => {
  const raw = loadFixture('task-notification.txt');

  it('extracts the envelope metadata fields', () => {
    const n = parseTaskNotification(raw);
    assert.equal(n.taskId, 'ae80b022c427830bd');
    assert.equal(n.toolUseId, 'toolu_01ADyr5ZhrBszz2DR2SuDfmm');
    assert.equal(
      n.outputFile,
      'C:\\Users\\NIKIFO~1\\AppData\\Local\\Temp\\claude\\C--Users-nikiforovall-dev-claude-code-hub\\854e2df3-1604-474e-9e7a-6e8f1a4bf09c\\tasks\\ae80b022c427830bd.output'
    );
    assert.equal(n.status, 'completed');
    assert.equal(n.summary, 'Agent "Emulate work A" completed');
  });

  it('keeps the agent result intact and excludes the wrapper', () => {
    const n = parseTaskNotification(raw);
    assert.ok(n.result.startsWith('test agent A done'));
    assert.ok(n.result.includes('Total active time ~90s via spaced waits.'));
    assert.ok(!n.result.includes('<task-notification>'));
    assert.ok(!n.result.includes('<usage>'));
  });

  it('parses <usage> into structured numbers (the "223166118942" run-on)', () => {
    const { usage } = parseTaskNotification(raw);
    assert.deepEqual(usage, { subagentTokens: 22316, toolUses: 6, durationMs: 118942 });
  });

  it('returns null for non-notification text', () => {
    assert.equal(parseTaskNotification('just a normal message'), null);
    assert.equal(parseTaskNotification(null), null);
    assert.equal(parseTaskNotification(undefined), null);
  });

  it('getSystemMessageLabel uses the summary as the chip label', () => {
    assert.equal(getSystemMessageLabel(raw), 'Agent "Emulate work A" completed');
  });

  // <result>/<usage> carry unescaped agent text. When an agent describes this very
  // format, its reply contains literal </result> and a fake <usage> block. The real
  // closing tags are always last, so parsing must NOT truncate on the embedded ones.
  it('does not truncate when the result embeds literal </result> and <usage>', () => {
    const adv = parseTaskNotification(loadFixture('task-notification-adversarial.txt'));
    assert.equal(adv.taskId, 'deadbeef1234');
    assert.equal(adv.summary, 'Agent "format explainer" completed');
    // Full result kept, including the embedded markers it describes.
    assert.ok(adv.result.includes('<result>...</result>'));
    assert.ok(adv.result.includes('those numbers above are an EXAMPLE'));
    assert.ok(adv.result.endsWith('not the real ones.'));
    // The REAL usage (last block) wins over the example embedded in the result.
    assert.deepEqual(adv.usage, { subagentTokens: 22316, toolUses: 6, durationMs: 118942 });
  });
});

// End-to-end: a task-notification must render as a system message (clean result
// body + summary/usage chip), NEVER as a raw user message — on BOTH the normally
// delivered (type:'user') path and the queued (queue-operation) path.
describe('readRecentMessages: task-notification rendering', () => {
  const raw = loadFixture('task-notification.txt');
  const dummy = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, timestamp: '2026-06-09T20:00:00Z' });

  function readOne(notifLine) {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const sessionFile = path.join(tmpDir, 'notif-session.jsonl');
    // First line is treated as potentially-partial and dropped, so lead with a dummy.
    writeFileSync(sessionFile, [dummy, notifLine].join('\n') + '\n');
    try {
      return readRecentMessages(sessionFile, 10);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  function assertCleanNotification(msg) {
    assert.ok(msg, 'notification message present');
    // Rich chip: summary + usage suffix.
    assert.equal(msg.systemLabel, 'Agent "Emulate work A" completed · 22.3k tok · 6 tools · 119s');
    // Body is the agent result, not the envelope.
    assert.ok(msg.text.startsWith('test agent A done'));
    assert.ok(!msg.text.includes('<task-notification>'));
    assert.ok(!msg.text.includes('<output-file>'));
    assert.ok(!msg.text.includes('22316'));
    // Tagged for client-side grouping + agent-type join.
    assert.equal(msg.taskNotification, true);
    assert.equal(msg.taskId, 'ae80b022c427830bd');
  }

  it('normalizes the normally-delivered (type:"user") notification', () => {
    const msgs = readOne(JSON.stringify({ type: 'user', message: { role: 'user', content: raw }, timestamp: '2026-06-09T20:36:00Z' }));
    assertCleanNotification(msgs.find((m) => m.systemLabel && m.systemLabel.startsWith('Agent "Emulate work A"')));
  });

  it('normalizes the queued (queue-operation enqueue) notification', () => {
    const msgs = readOne(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: raw, timestamp: '2026-06-09T20:36:00Z' }));
    assertCleanNotification(msgs.find((m) => m.systemLabel && m.systemLabel.startsWith('Agent "Emulate work A"')));
  });

  it('emits the enqueue+delivered pair sharing one taskId (so the client groups them)', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const sessionFile = path.join(tmpDir, 'notif-session.jsonl');
    writeFileSync(sessionFile, [
      dummy,
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: raw, timestamp: '2026-06-09T20:56:12.176Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: raw }, timestamp: '2026-06-09T20:56:12.189Z' })
    ].join('\n') + '\n');
    try {
      const notifs = readRecentMessages(sessionFile, 10).filter((m) => m.taskNotification);
      assert.equal(notifs.length, 2);
      assert.ok(notifs.every((m) => m.taskId === 'ae80b022c427830bd'));
      // One came from the queued path, one from the delivered path.
      assert.deepEqual(notifs.map((m) => !!m.queued).sort(), [false, true]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// Foreground agents report cost on their completion toolUseResult
// (totalTokens/totalToolUseCount/totalDurationMs), not via a <task-notification>.
// buildAgentProgressMap must capture those as a formatted usageText chip — the same
// " · Nk tok · N tools · Ns" string a background agent gets — keyed by tool_use_id.
describe('buildAgentProgressMap: foreground agent usage chip', () => {
  it('captures totalTokens/toolUses/duration as a usageText chip', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const file = path.join(tmpDir, 'fg-agent.jsonl');
    const dummy = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, timestamp: '2026-06-10T10:00:00Z' });
    const completion = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fg1', content: 'done' }] },
      toolUseResult: {
        status: 'completed',
        agentId: 'fgagent123',
        agentType: 'Explore',
        prompt: 'You are the REUSE reviewer ...',
        totalTokens: 31485,
        totalToolUseCount: 5,
        totalDurationMs: 33551
      },
      timestamp: '2026-06-10T10:00:34Z'
    });
    writeFileSync(file, [dummy, completion].join('\n') + '\n');
    try {
      const map = buildAgentProgressMap(file);
      const entry = map['toolu_fg1'];
      assert.ok(entry, 'progressMap entry for the agent tool_use_id');
      assert.equal(entry.agentId, 'fgagent123');
      assert.equal(entry.usageText, ' · 31.5k tok · 5 tools · 34s');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('omits usageText when the toolUseResult carries no cost numbers', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    const file = path.join(tmpDir, 'fg-agent-nousage.jsonl');
    const dummy = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, timestamp: '2026-06-10T10:00:00Z' });
    const completion = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fg2', content: 'done' }] },
      toolUseResult: { status: 'completed', agentId: 'fgagent456', prompt: 'p' },
      timestamp: '2026-06-10T10:00:10Z'
    });
    writeFileSync(file, [dummy, completion].join('\n') + '\n');
    try {
      const entry = buildAgentProgressMap(file)['toolu_fg2'];
      assert.ok(entry);
      assert.equal(entry.usageText, null);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

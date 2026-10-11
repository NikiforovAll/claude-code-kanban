const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCRIPTS = path.join(__dirname, '..', 'plugin', 'plugins', 'kanban-delm-swarm', 'scripts');
let hasSqlite = true;
try {
  require('node:sqlite');
} catch {
  hasSqlite = false;
}

const LIST = 'swarm-goal-abc123';
const roster = [{ name: 'w1-abc123', sessionId: 'sid-1' }, { name: 'w2-abc123', sessionId: 'sid-2' }];

function config() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-swarm-sup-')).replaceAll('\\', '/');
  fs.mkdirSync(`${dir}/.cck/swarm/${LIST}`, { recursive: true });
  fs.writeFileSync(`${dir}/.cck/swarm/${LIST}/swarm.json`, JSON.stringify({ listId: LIST, parent: 'sid-p', workers: roster, state: 'running' }));
  return { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sid-p' };
}

describe('swarm supervisor', { skip: !hasSqlite && 'node:sqlite needs Node 22.5 or later' }, () => {
  let sup;
  let store;
  before(async () => {
    sup = await import(pathToFileURL(path.join(SCRIPTS, 'supervisor.mjs')).href);
    store = await import(pathToFileURL(path.join(SCRIPTS, 'store.mjs')).href);
  });

  it('acts only for the session that started the swarm', () => {
    const env = config();
    assert.throws(() => sup.swarmRequest('../etc', env), /give the swarm id/);
    assert.throws(() => sup.swarmRequest('swarm-none-000000', env), /no swarm swarm-none-000000/);
    assert.throws(() => sup.swarmRequest(LIST, { ...env, CLAUDE_CODE_SESSION_ID: 'sid-1' }), /only the session that started the swarm/);
    const request = sup.swarmRequest(LIST, env);
    const created = sup.command('task_create', request, '{"title": "Docs", "description": "Write them", "assignee": "w2-abc123"}');
    assert.deepEqual([created.ok, created.result.owner], [true, 'w2-abc123']);
    assert.throws(() => sup.command('request', request, '{oops'), /one JSON object/);
  });

  it('prints one line per notice and exits at the end', async () => {
    const request = sup.swarmRequest(LIST, config());
    const worker = (actor, command, args) => assert.equal(store.main(command, { ...request, actor, ...args }).ok, true);
    worker({ id: 'sid-1', name: 'w1-abc123' }, 'complete', { idempotency_key: 'b', outcome: 'blocked', expected_revision: 1, summary: 'Need\nthe key' });
    const lines = [];
    const watching = sup.watch(request, (l) => lines.push(l), { pollMs: 10 });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(lines, ['w1-abc123 is blocked: Need the key']);
    sup.command('end', request, '{"outcome": "stopped", "summary": "Done"}');
    assert.equal(await watching, 0);
    assert.deepEqual(lines.slice(1), ['The swarm has ended.']);
    assert.equal(sup.noticeLine({ kind: 'complete', worker: 'w2', revision: 2, summary: 'x'.repeat(700) }).length, 'w2 declared the goal complete under revision 2: '.length + sup.SUMMARY_CHARS + '...'.length);
  });
});

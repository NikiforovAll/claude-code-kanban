const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { git, write, repoWithWorktrees } = require('./swarm-git-helpers');

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

// The swarm's project at its base commit, with each worker's Claude Code worktree.
function project(env) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cck-swarm-repo-'))).replaceAll('\\', '/');
  const { base, trees } = repoWithWorktrees(repo, { 'a.txt': 'a\n' }, roster.map((w) => w.name));
  const file = `${env.CLAUDE_CONFIG_DIR}/.cck/swarm/${LIST}/swarm.json`;
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), project: repo, base }));
  return { repo, trees: Object.fromEntries(Object.entries(trees).map(([name, t]) => [name, t.path])) };
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

  it("finds this session's running swarm and shows its board", () => {
    const env = config();
    assert.equal(sup.ownSwarm({ ...env, CLAUDE_CODE_SESSION_ID: 'sid-1' }), undefined);
    assert.equal(sup.ownSwarm(env), LIST);
    const request = sup.swarmRequest(LIST, env);
    store.main('complete', { ...request, actor: { id: 'sid-1', name: 'w1-abc123' }, idempotency_key: 'w', outcome: 'waiting', expected_revision: 1, summary: 'Waits', dependency: 'worker:w2-abc123' });
    sup.command('task_create', request, '{"title": "Docs", "description": "Write them"}');
    assert.equal(
      sup.boardText(LIST, store.main('status', request).board),
      [`Swarm ${LIST}: running, request revision 1`, '  w1-abc123: waiting on worker:w2-abc123, in a turn. Waits', '  w2-abc123: working, in a turn', 'Tasks 1, publications 0, findings 0', '  #1 available: Docs'].join('\n'),
    );
    sup.command('end', request, '{"outcome": "stopped", "summary": "Done"}');
    assert.equal(sup.ownSwarm(env), undefined);
  });

  const stopped = { outcome: 'stopped', summary: 'Stopped with /swarm-stop.' };

  // A cck whose dispatch end ends the terminal it names.
  function cckStub(live = ['sid-1', 'sid-2', 'other']) {
    const calls = [];
    const run = (args) => {
      calls.push(args.slice(0, 3).join(' '));
      if (args[1] === 'end') live = live.filter((s) => s !== args[2]);
      return JSON.stringify(live.map((session) => ({ session })));
    };
    return { run, calls };
  }

  it('stops the workers, waits until they end, saves their changes, removes the worktrees, then ends the swarm', async () => {
    const env = config();
    const p = project(env);
    write(p.trees['w1-abc123'], 'a.txt', 'a from w1\n');
    const request = sup.swarmRequest(LIST, env);
    store.main('task_create', { ...request, actor: { id: 'sid-1', name: 'w1-abc123' }, idempotency_key: 't', title: 'A', description: 'A' });
    store.main('task_claim', { ...request, actor: { id: 'sid-1', name: 'w1-abc123' }, idempotency_key: 'c', task_id: 1 });
    const { run, calls } = cckStub();
    const out = await sup.finish(request, stopped, { run, pollMs: 1 });
    assert.equal(out.ok, true);
    assert.deepEqual(calls.filter((c) => c.startsWith('dispatch end')), ['dispatch end sid-1', 'dispatch end sid-2']);
    const board = store.main('status', request).board;
    assert.deepEqual([board.state, board.outcome.outcome, board.tasks[0].state], ['ended', 'stopped', 'done']);
    const mirrored = JSON.parse(fs.readFileSync(path.join(request.tasksDir, '1.json'), 'utf8'));
    assert.deepEqual([mirrored.status, mirrored.metadata.closed], ['completed', true], 'the board shows the task as closed, not open');
    assert.deepEqual(board.workers.map((w) => w.state), ['stopped', 'stopped']);
    assert.match(sup.boardText(LIST, board), /\n {2}w1-abc123: stopped\. the supervisor stopped the swarm\n/);
    const manifest = JSON.parse(fs.readFileSync(path.join(out.result.recovery, 'complete.json'), 'utf8'));
    assert.deepEqual(manifest.workers.map((w) => [w.worker, Object.keys(w.changes)]), [['w1-abc123', ['a.txt']], ['w2-abc123', []]]);
    assert.equal(fs.existsSync(p.trees['w1-abc123']), false);
    assert.equal(fs.readFileSync(path.join(p.repo, 'a.txt'), 'utf8'), 'a\n');
    assert.match(sup.resultText(LIST, out.result), /ended as stopped\. Every worker's changes are saved in .*recovery; the worktrees are removed\.$/);
    assert.equal((await sup.finish(request, stopped, { run })).ok, true, 'a rerun replays the end');
  });

  it('leaves the swarm running when a worker does not end', async () => {
    const env = config();
    project(env);
    const request = sup.swarmRequest(LIST, env);
    const run = () => JSON.stringify([{ session: 'sid-2' }]);
    const out = await sup.finish(request, stopped, { run, waitMs: 5, pollMs: 1 });
    assert.match(out.error, /w2-abc123 still running/);
    assert.equal(store.main('status', request).board.state, 'running');
  });

  it('delivers the candidate into the project and ends the swarm as complete', async () => {
    const env = config();
    const p = project(env);
    const request = sup.swarmRequest(LIST, env);
    assert.match((await sup.finish(request, { outcome: 'complete', summary: 'Done' })).error, /no worker declared the goal complete/);
    write(p.trees['w2-abc123'], 'a.txt', 'a from w2\n');
    write(p.trees['w1-abc123'], 'b.txt', 'b from w1\n');
    store.main('task_create', { ...request, actor: { id: 'sid-1', name: 'w1-abc123' }, idempotency_key: 't', title: 'Dup', description: 'A duplicate' });
    store.main('complete', { ...request, actor: { id: 'sid-2', name: 'w2-abc123' }, idempotency_key: 'k', outcome: 'complete', expected_revision: 1, summary: 'Ready', artifacts: [] });
    assert.equal(store.main('status', request).board.candidate.worker, 'w2-abc123');
    assert.match((await sup.finish(request, { outcome: 'complete', summary: 'Done' }, { run: () => assert.fail('no worker is stopped') })).error, /review the open tasks first: #1 available: Dup\./);
    sup.command('task_close', request, '{"task_id": 1, "reason": "a duplicate"}');
    const out = await sup.finish(request, { outcome: 'complete', summary: 'Done' }, { run: cckStub().run, pollMs: 1 });
    assert.deepEqual([out.ok, out.result.outcome, out.result.changed], [true, 'complete', ['a.txt']]);
    assert.equal(fs.readFileSync(path.join(p.repo, 'a.txt'), 'utf8'), 'a from w2\n');
    assert.equal(fs.existsSync(path.join(p.repo, 'b.txt')), false, 'only the candidate is delivered');
    assert.equal(git(p.repo, 'worktree', 'list').split('\n').length, 1);
    assert.equal(store.main('status', request).board.outcome.outcome, 'complete');
    assert.equal(sup.resultText(LIST, out.result), `Delivered 1 file from w2-abc123 into ${p.repo}: a.txt.\nThe versions it replaced are in ${path.join(request.dir, 'delivery')}.\nSwarm ${LIST} ended as complete; the worktrees are removed.`);
  });

  it('ends the swarm as delivery_conflict with a recovery bundle when the user edited the same lines', async () => {
    const env = config();
    const p = project(env);
    const request = sup.swarmRequest(LIST, env);
    write(p.trees['w1-abc123'], 'a.txt', 'a from w1\n');
    write(p.repo, 'a.txt', 'a from the user\n');
    store.main('complete', { ...request, actor: { id: 'sid-1', name: 'w1-abc123' }, idempotency_key: 'k', outcome: 'complete', expected_revision: 1, summary: 'Ready' });
    const out = await sup.finish(request, { outcome: 'complete', summary: 'Done' }, { run: cckStub().run, pollMs: 1 });
    assert.deepEqual([out.ok, out.result.outcome, out.result.conflicts], [true, 'delivery_conflict', ['a.txt']]);
    assert.equal(fs.readFileSync(path.join(p.repo, 'a.txt'), 'utf8'), 'a from the user\n');
    assert.equal(store.main('status', request).board.outcome.outcome, 'delivery_conflict');
    assert.match(sup.resultText(LIST, out.result), /^Not delivered\. Delivery needs conflict resolution for: a\.txt\. Your edits and the proposed changes are preserved in .*recovery\./);
    assert.equal(fs.existsSync(p.trees['w1-abc123']), false);
  });

  it('a rerun after a failed apply finishes the delivery, whatever outcome it is given', async () => {
    const env = config();
    const p = project(env);
    const request = sup.swarmRequest(LIST, env);
    write(p.trees['w1-abc123'], 'a.txt', 'a from w1\n');
    store.main('complete', { ...request, actor: { id: 'sid-1', name: 'w1-abc123' }, idempotency_key: 'k', outcome: 'complete', expected_revision: 1, summary: 'Ready' });
    fs.mkdirSync(path.join(request.dir, 'delivery'));
    fs.writeFileSync(path.join(request.dir, 'delivery', 'journal.json'), '{oops');
    await assert.rejects(sup.finish(request, { outcome: 'complete', summary: 'Done' }, { run: cckStub().run, pollMs: 1 }), /JSON/);
    fs.rmSync(path.join(request.dir, 'delivery'), { recursive: true });
    const out = await sup.finish(request, stopped, { run: cckStub([]).run });
    assert.deepEqual([out.ok, out.result.outcome, out.result.changed], [true, 'complete', ['a.txt']]);
    assert.equal(fs.readFileSync(path.join(p.repo, 'a.txt'), 'utf8'), 'a from w1\n');
    assert.equal(fs.existsSync(p.trees['w1-abc123']), false);
  });
});

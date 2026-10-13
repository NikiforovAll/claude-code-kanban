const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const STORE = path.join(__dirname, '..', 'store.mjs');
// node:sqlite ships from Node 22.5; CI also runs Node 20.
let hasSqlite = true;
try {
  require('node:sqlite');
} catch {
  hasSqlite = false;
}

// A git hook runs the tests with GIT_DIR and friends set, which would aim the temp repo's git calls at cck.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-swarm-'));
  return { root, dir: path.join(root, 'swarm'), tasksDir: path.join(root, 'tasks', 'swarm-g') };
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();

// A base commit with the seeded files, and two worker copies of it, like the swarm's worktrees.
function workspaces(w, seeds = {}, executable = []) {
  const repo = path.join(w.root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, '.keep'), '');
  for (const [p, data] of Object.entries(seeds)) {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    fs.writeFileSync(path.join(repo, p), data);
  }
  git(repo, 'add', '.');
  for (const p of executable) {
    git(repo, 'update-index', '--chmod=+x', p);
    fs.chmodSync(path.join(repo, p), 0o755);
  }
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const [wa, wb] = ['wa', 'wb'].map((n) => path.join(w.root, n));
  for (const wt of [wa, wb]) fs.cpSync(repo, wt, { recursive: true });
  return { base, wa, wb };
}

const a = { id: 'sid-a', name: 'worker-a' };
const b = { id: 'sid-b', name: 'worker-b' };
const observer = { id: 'observer' };

// Most cases below carry the name of the DeLM board test (src/board/tests.rs) they port.
describe('swarm store', { skip: !hasSqlite && 'node:sqlite needs Node 22.5 or later' }, () => {
  let main;
  before(async () => {
    ({ main } = await import(pathToFileURL(STORE).href));
  });

  const run = (w, command, actor, args = {}) => main(command, { dir: w.dir, tasksDir: w.tasksDir, actor, ...w.extra, ...args });
  const ok = (w, command, actor, args) => {
    const out = run(w, command, actor, args);
    assert.equal(out.ok, true, out.error);
    return out.result;
  };
  const create = (w, actor, key, kind = 'implementation', extra = {}) =>
    ok(w, 'task_create', actor, { idempotency_key: key, title: `Task ${key}`, description: 'Do it', kind, ...extra }).task_id;
  const claim = (w, actor, key, taskId) => ok(w, 'task_claim', actor, { idempotency_key: key, task_id: taskId }).version;
  const publish = (w, actor, key, paths, extra = {}) =>
    ok(w, 'publish', actor, { idempotency_key: key, summary: `Publication ${key}`, paths, ...extra }).publication_id;
  const taskFile = (w, n) => JSON.parse(fs.readFileSync(path.join(w.tasksDir, `${n}.json`), 'utf8'));
  const tasks = (w) => ok(w, 'list', observer, { collection: 'tasks', limit: 24 }).items;
  const view = (w) => run(w, 'status', observer).board;
  const events = (w, since) => main('export', { dir: w.dir, since }).events;

  it('numbers tasks as Claude Code task ids and mirrors each state into the task file', () => {
    const w = world();
    fs.mkdirSync(w.tasksDir, { recursive: true });
    fs.writeFileSync(path.join(w.tasksDir, '4.json'), '{}');
    const id = create(w, a, 'c1', 'implementation', { interface: 'parse(csv)', done_when: 'tests pass' });
    assert.equal(id, 5);
    assert.equal(taskFile(w, 5).status, 'pending');
    assert.match(taskFile(w, 5).description, /\*\*Interface:\*\* parse\(csv\)[\s\S]*\*\*Done when:\*\* tests pass/);
    const version = claim(w, b, 'k1', id);
    assert.deepEqual([taskFile(w, 5).status, taskFile(w, 5).owner, taskFile(w, 5).metadata.version], ['in_progress', 'worker-b', version]);
    const done = ok(w, 'task_finish', b, { idempotency_key: 'f1', task_id: id, expected_version: version, summary: 'parsed' });
    assert.deepEqual([done.state, done.whole_task_complete], ['done', false]);
    assert.equal(taskFile(w, 5).status, 'completed');
    assert.match(taskFile(w, 5).description, /\*\*Done:\*\* parsed/);
    assert.equal(fs.readFileSync(path.join(w.tasksDir, '4.json'), 'utf8'), '{}');
  });

  it('task_tools_explain_size_limits_and_reject_task_ids_as_publication_dependencies', () => {
    const w = world();
    const task = create(w, a, 'first-task');
    const args = { idempotency_key: 'second-task', title: 'Reusable parser', description: 'Contribute the parser interface', interface: 'é'.repeat(1024), dependencies: [task] };
    const refused = run(w, 'task_create', a, args).error;
    assert.match(refused, /not task IDs/);
    assert.match(refused, /swarm_publish/);
    assert.equal(tasks(w).length, 1);
    const publication = publish(w, b, 'interface', [], { interfaces: 'parse(csv) returns rows' });
    assert.match(run(w, 'task_create', a, { ...args, idempotency_key: 'k2', dependencies: [publication], interface: 'é'.repeat(1025) }).error, /interface must be a string of at most 2048 bytes/);
    ok(w, 'task_create', a, { ...args, idempotency_key: 'k3', dependencies: [publication] });
    assert.equal(tasks(w).length, 2);
    assert.match(run(w, 'task_create', a, { idempotency_key: 'k4', title: ' ', description: 'd' }).error, /title must be nonempty and at most 256 bytes/);
    assert.match(run(w, 'task_create', a, { idempotency_key: 'k5', title: 't', description: 'd', kind: 'review' }).error, /invalid task kind/);
    assert.match(run(w, 'task_create', a, { title: 't', description: 'd' }).error, /idempotency_key must be a string/);
    assert.match(run(w, 'status', a, { idempotency_key: 'k6', finding: 'x'.repeat(130 * 1024) }).error, /exceeds 128 KiB/);
  });

  it('concurrent_claims_have_exactly_one_owner_and_a_lost_claim_names_its_task', async () => {
    const w = world();
    const id = create(w, a, 'create');
    const spawnClaim = (i) =>
      new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [STORE, 'task_claim'], (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
        child.stdin.end(JSON.stringify({ dir: w.dir, tasksDir: w.tasksDir, actor: { id: `w${i}`, name: `w${i}` }, idempotency_key: 'claim', task_id: id }));
      });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => spawnClaim(i)));
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1);
    const owner = { id: winners[0].result.owner, name: winners[0].result.owner };
    const refusal = new RegExp(`task ${id} is already owned by ${owner.name}; pick other work`);
    assert.ok(results.filter((r) => !r.ok).every((r) => refusal.test(r.error)));
    const lost = events(w).filter((e) => e.kind === 'claim_lost');
    assert.equal(lost.length, 7);
    assert.deepEqual(lost[0].payload, { task_id: id, owner: owner.id, state: 'claimed' });
    assert.equal(taskFile(w, id).owner, owner.name);
    assert.deepEqual(run(w, 'task_claim', owner, { idempotency_key: 'claim', task_id: id }).result, winners[0].result);
    assert.match(run(w, 'task_finish', a, { idempotency_key: 'finish', task_id: id, expected_version: winners[0].result.version, summary: 'Done' }).error, new RegExp(`task ${id}: only the current owner`));
    assert.match(run(w, 'task_claim', owner, { idempotency_key: 'claim2', task_id: id + 1 }).error, /unknown task/);
  });

  it('refuses an idempotency key reused with other arguments', () => {
    const w = world();
    const id = create(w, a, 'k');
    assert.match(run(w, 'task_create', a, { idempotency_key: 'k', title: 'Other', description: 'Do it' }).error, /already used with different arguments/);
    assert.match(run(w, 'task_claim', a, { idempotency_key: 'k', task_id: id }).error, /already used with different arguments/);
    assert.equal(create(w, b, 'k'), id + 1);
    assert.equal(events(w).filter((e) => e.kind === 'task_create').length, 2);
  });

  it('released_claims_fence_old_owners_and_same_owner_reclaims', () => {
    const w = world();
    const task = create(w, a, 'task');
    const old = claim(w, a, 'claim', task);
    const release = { idempotency_key: 'release', task_id: task, expected_version: old, summary: 'No code yet; the interface is ready' };
    const released = run(w, 'task_release', a, release);
    assert.deepEqual(run(w, 'task_release', a, release), released);
    assert.match(taskFile(w, task).description, /\*\*Handoff:\*\* No code yet/);
    assert.equal(run(w, 'task_finish', a, { idempotency_key: 'late', task_id: task, expected_version: old, summary: 'Stale completion' }).ok, false);
    const fresh = claim(w, a, 'reclaim', task);
    assert.notEqual(old, fresh);
    assert.match(run(w, 'task_finish', a, { idempotency_key: 'late2', task_id: task, expected_version: old, summary: 'Still stale' }).error, /stale task version/);
    ok(w, 'task_release', a, { idempotency_key: 'release2', task_id: task, expected_version: fresh, summary: 'Ready for peer' });
    const peer = claim(w, b, 'peer', task);
    assert.match(run(w, 'task_update', a, { idempotency_key: 'intrude', task_id: task, expected_version: peer, description: 'Other owner' }).error, /only the current owner/);
    ok(w, 'task_finish', b, { idempotency_key: 'done', task_id: task, expected_version: peer, summary: 'Complete' });
  });

  it('a release checkpoint must be published by the releasing worker', () => {
    const w = world();
    const task = create(w, a, 'task');
    const version = claim(w, a, 'claim', task);
    const theirs = publish(w, b, 'p', []);
    const mine = publish(w, a, 'p', []);
    const release = { idempotency_key: 'r1', task_id: task, expected_version: version, summary: 'half done' };
    assert.match(run(w, 'task_release', a, { ...release, publication_id: theirs }).error, /published by the releasing worker/);
    assert.match(run(w, 'task_release', a, { ...release, idempotency_key: 'r2', publication_id: mine + 100 }).error, /unknown checkpoint publication/);
    assert.match(run(w, 'task_release', a, { ...release, idempotency_key: 'r3', publication_id: String(mine) }).error, /publication_id must be a positive integer/);
    ok(w, 'task_release', a, { ...release, idempotency_key: 'r4', publication_id: mine });
    assert.equal(tasks(w)[0].checkpoint, mine);
  });

  it('updated_interfaces_have_a_new_version_and_reject_stale_finishes', () => {
    const w = world();
    const task = create(w, a, 'task');
    const before = claim(w, a, 'claim', task);
    assert.match(run(w, 'task_update', a, { idempotency_key: 'empty', task_id: task, expected_version: before }).error, /must change at least one task field/);
    const update = ok(w, 'task_update', a, { idempotency_key: 'update', task_id: task, expected_version: before, interface: 'parse(csv) returns Result<Contact[], ImportError[]>' });
    assert.equal(run(w, 'task_finish', a, { idempotency_key: 'old-finish', task_id: task, expected_version: before, summary: 'Old contract' }).ok, false);
    assert.equal(ok(w, 'expand', b, { task_id: task }).interface, 'parse(csv) returns Result<Contact[], ImportError[]>');
    ok(w, 'task_finish', a, { idempotency_key: 'finish', task_id: task, expected_version: update.version, summary: 'Current contract' });
  });

  it('split_is_atomic_and_keeps_only_the_smaller_parent_claim', () => {
    const w = world();
    const task = create(w, a, 'task');
    const version = claim(w, a, 'claim', task);
    const args = {
      idempotency_key: 'split',
      task_id: task,
      expected_version: version,
      remaining: { title: 'Parse input', description: 'Keep the parser only' },
      tasks: [
        { title: 'Save records', description: 'Persist validated records', interface: 'Accept parser output' },
        { title: 'Present errors', description: 'Show field-level validation feedback' },
      ],
    };
    const split = run(w, 'task_split', a, args);
    assert.deepEqual(run(w, 'task_split', a, args), split);
    let all = tasks(w);
    assert.equal(all.length, 3);
    assert.equal(all.filter((t) => t.state === 'available').length, 2);
    assert.equal(all.find((t) => t.task_id === task).title, 'Parse input');
    const child = split.result.created[0].task_id;
    claim(w, b, 'peer', child);
    const current = split.result.version;
    const invalid = {
      idempotency_key: 'bad-split',
      task_id: task,
      expected_version: current,
      remaining: { title: 'Parse input', description: 'Still own parser' },
      tasks: [{ title: 'Should roll back', description: 'Valid first child' }, { title: 'Invalid child' }],
    };
    assert.equal(run(w, 'task_split', a, invalid).ok, false);
    all = tasks(w);
    assert.equal(all.length, 3);
    assert.equal(all.find((t) => t.task_id === task).version, current);
    assert.equal(fs.existsSync(path.join(w.tasksDir, `${child + 2}.json`)), false);
    assert.match(run(w, 'task_split', a, { ...invalid, idempotency_key: 'kind', tasks: [{ title: 't', description: 'd' }], remaining: { title: 'r', description: 'd', kind: 'verification' } }).error, /cannot change the current task kind/);
    assert.match(run(w, 'task_split', a, { ...invalid, idempotency_key: 'none', tasks: [] }).error, /one to sixteen/);
  });

  it('only_one_temporary_integration_claim_exists', () => {
    const w = world();
    const first = create(w, a, 'assembly1', 'integration');
    const second = create(w, b, 'assembly2', 'integration');
    const version = claim(w, a, 'claim1', first);
    assert.match(run(w, 'task_claim', b, { idempotency_key: 'claim2', task_id: second }).error, new RegExp(`integration is already claimed as task ${first}`));
    ok(w, 'task_release', a, { idempotency_key: 'handoff', task_id: first, expected_version: version, summary: 'Peer can assemble from published pieces' });
    claim(w, b, 'claim3', second);
  });

  it('lets a worker hold several claims', () => {
    const w = world();
    const one = create(w, a, 'one');
    const two = create(w, a, 'two');
    claim(w, a, 'c1', one);
    claim(w, a, 'c2', two);
    assert.deepEqual(tasks(w).map((t) => [t.state, t.owner]), [['claimed', 'worker-a'], ['claimed', 'worker-a']]);
  });

  it('discovery_reaches_old_tasks_without_changing_claims_or_including_later_creations', () => {
    const w = world();
    const ids = [];
    for (let n = 0; n < 40; n++) {
      ids.push(create(w, a, `task-${n}`));
      ok(w, 'status', b, { idempotency_key: `status-${n}`, summary: 'Inspecting' });
    }
    const before = view(w);
    assert.equal(before.tasks.length, 24);
    assert.deepEqual(before.collections.tasks, { total: 40, shown: 24, has_more: true });
    assert.equal(before.view_limit, 24);
    let page = ok(w, 'list', b, { collection: 'tasks', limit: 7 });
    assert.deepEqual(view(w), before, 'discovery must not append events or claim work');
    assert.equal(page.items[0].task_id, ids[0]);
    const later = create(w, b, 'new-after-first-page');
    const seen = [];
    for (;;) {
      assert.equal(page.total, 40);
      seen.push(...page.items.map((t) => t.task_id));
      if (!page.next_cursor) break;
      page = ok(w, 'list', b, { collection: 'tasks', limit: 7, cursor: page.next_cursor });
    }
    assert.deepEqual(seen, ids);
    assert.equal(page.new_events_available, true);
    assert.ok(!seen.includes(later));
    assert.ok(tasks(w).every((t) => t.state === 'available'));
  });

  it('filtered_discovery_refreshes_when_ownership_changes_and_cursors_cannot_cross_queries', () => {
    const w = world();
    const ids = Array.from({ length: 5 }, (_, n) => create(w, a, `task-${n}`));
    const page = ok(w, 'list', a, { collection: 'tasks', task_state: 'available', limit: 2 });
    claim(w, b, 'claim-last', ids[4]);
    assert.match(run(w, 'list', a, { collection: 'tasks', task_state: 'available', limit: 2, cursor: page.next_cursor }).error, /ownership changed/);
    const claimed = ok(w, 'list', a, { collection: 'tasks', task_state: 'claimed', owner: 'peer' });
    assert.deepEqual([claimed.total, claimed.items[0].task_id], [1, ids[4]]);
    assert.equal(ok(w, 'list', b, { collection: 'tasks', owner: 'self' }).total, 1);
    assert.equal(ok(w, 'list', b, { collection: 'tasks', owner: 'peer' }).total, 0);
    const fresh = ok(w, 'list', a, { collection: 'tasks', limit: 2 });
    assert.match(run(w, 'list', a, { collection: 'findings', cursor: fresh.next_cursor }).error, /restart without a cursor/);
    assert.match(run(w, 'list', a, { collection: 'tasks', owner: 'peer', cursor: fresh.next_cursor }).error, /restart without a cursor/);
    assert.match(run(w, 'list', b, { collection: 'tasks', limit: 2, cursor: fresh.next_cursor }).error, /restart without a cursor/);
    assert.equal(ok(w, 'list', a, { collection: 'tasks', limit: 2, cursor: fresh.next_cursor }).items[0].task_id, ids[2]);
  });

  it('discovery_pages_all_explicit_sharing_with_bounded_summaries', () => {
    const w = world();
    for (let n = 0; n < 27; n++) {
      publish(w, a, `publication-${n}`, [], { summary: `${'s'.repeat(600)} ${n}` });
      ok(w, 'status', b, { idempotency_key: `finding-${n}`, finding: `Useful finding ${n}` });
    }
    for (const collection of ['publications', 'findings']) {
      const before = view(w);
      assert.equal(before.collections[collection].total, 27);
      assert.equal(before[collection].length, 24);
      const first = ok(w, 'list', b, { collection, limit: 24 });
      const second = ok(w, 'list', b, { collection, limit: 24, cursor: first.next_cursor });
      assert.equal(first.items.length, 24);
      assert.equal(second.items.length, 3);
      assert.equal(second.next_cursor, null);
      assert.deepEqual(view(w), before);
    }
    assert.ok(ok(w, 'list', b, { collection: 'publications' }).items[0].summary.length <= 515);
    for (const args of [
      { collection: 'tasks', limit: 25 },
      { collection: 'tasks', limit: 0 },
      { collection: 'findings', task_state: 'available' },
      { collection: 'tasks', cursor: 'not-json' },
      { collection: 'checks' },
    ]) {
      assert.equal(run(w, 'list', a, args).ok, false, JSON.stringify(args));
    }
  });

  it('findings_are_append_only_and_waiting_requires_a_dependency', () => {
    const w = world();
    const wait = { outcome: 'waiting', expected_revision: 1, summary: 'Waiting' };
    assert.match(run(w, 'complete', a, { idempotency_key: 'wait', ...wait }).error, /waiting requires a named dependency/);
    const first = run(w, 'status', a, { idempotency_key: 'one', finding: 'Interface uses stable IDs' });
    ok(w, 'status', b, { idempotency_key: 'two', finding: 'Reload needs migration' });
    ok(w, 'complete', b, { idempotency_key: 'two-wait', ...wait, dependency: 'worker:worker-a' });
    assert.deepEqual(run(w, 'status', a, { idempotency_key: 'one', finding: 'Interface uses stable IDs' }).result, first.result);
    const board = view(w);
    assert.equal(board.findings.length, 2);
    assert.deepEqual(board.findings.map((f) => [f.author, f.text]), [['worker-b', 'Reload needs migration'], ['worker-a', 'Interface uses stable IDs']]);
    assert.deepEqual(board.workers.find((x) => x.worker === 'worker-b').dependency, 'worker:worker-a');
    assert.equal(ok(w, 'expand', b, { finding_id: first.result.finding_id }).text, 'Interface uses stable IDs');
    ok(w, 'status', b, { idempotency_key: 'three', summary: 'Still waiting' });
    const row = view(w).workers.find((x) => x.worker === 'worker-b');
    assert.deepEqual([row.state, row.summary, row.dependency], ['waiting', 'Still waiting', 'worker:worker-a'], 'a summary keeps the declared outcome');
  });

  it('a status read only reads', () => {
    const w = world();
    const before = view(w).sequence;
    assert.deepEqual(ok(w, 'status', a), { worker: 'worker-a' });
    assert.equal(view(w).sequence, before);
  });

  it('immutable_publication_is_selective_and_preserves_binary_executable_and_deletion', () => {
    const w = world();
    const { base, wa, wb } = workspaces(w, { 'main.txt': 'original', 'remove.txt': 'remove', 'run.sh': 'echo 1\n' }, ['run.sh']);
    const ctx = { base };
    fs.writeFileSync(path.join(wa, 'main.txt'), 'published');
    fs.writeFileSync(path.join(wa, 'asset.bin'), Buffer.from([0, 255, 128, 1]));
    fs.writeFileSync(path.join(wa, 'run.sh'), 'echo 2\n');
    fs.rmSync(path.join(wa, 'remove.txt'));
    const args = { idempotency_key: 'publish', summary: 'parser', paths: ['main.txt', 'asset.bin', 'remove.txt', 'run.sh'], cwd: wa, ...ctx };
    const published = run(w, 'publish', a, args);
    const id = published.result.publication_id;
    assert.deepEqual(published.result, { publication_id: id, summary: 'parser', file_count: 4 });
    fs.writeFileSync(path.join(wa, 'main.txt'), 'author continues');
    assert.deepEqual(run(w, 'publish', a, args), published);
    const event = events(w).find((e) => e.seq === id);
    assert.deepEqual(event.payload.files.map((f) => [f.path, f.change]), [['main.txt', 'modified'], ['asset.bin', 'added'], ['remove.txt', 'deleted'], ['run.sh', 'modified']]);

    const expanded = ok(w, 'expand', b, { publication_id: id, paths: ['main.txt'] });
    assert.deepEqual([expanded.files.length, expanded.files[0].text], [1, 'published']);
    const binary = ok(w, 'expand', b, { publication_id: id, paths: ['asset.bin'] }).files[0];
    assert.deepEqual([binary.binary, binary.text], [true, undefined]);
    const slice = ok(w, 'expand', b, { publication_id: id, paths: ['main.txt'], offset: 3, max_bytes: 2 }).files[0];
    assert.deepEqual([slice.text, slice.returned_bytes, slice.total_bytes], ['li', 2, 9]);
    assert.match(run(w, 'expand', b, { publication_id: id, task_id: 1 }).error, /exactly one/);
    assert.match(run(w, 'expand', b, { publication_id: id, max_bytes: 32769 }).error, /max_bytes/);

    const first = run(w, 'apply', b, { idempotency_key: 'import-one', publication_id: id, paths: ['main.txt'], cwd: wb, ...ctx });
    assert.deepEqual(first.result, { publication_id: id, paths: ['main.txt'], confirmed: true });
    assert.equal(fs.readFileSync(path.join(wb, 'main.txt'), 'utf8'), 'published');
    assert.equal(fs.readFileSync(path.join(wb, 'remove.txt'), 'utf8'), 'remove');
    assert.equal(fs.existsSync(path.join(wb, 'asset.bin')), false);
    assert.deepEqual(run(w, 'apply', b, { idempotency_key: 'import-one', publication_id: id, paths: ['main.txt'], cwd: wb, ...ctx }), first);
    ok(w, 'apply', b, { idempotency_key: 'import-rest', publication_id: id, paths: ['asset.bin', 'remove.txt', 'run.sh'], cwd: wb, ...ctx });
    assert.deepEqual([...fs.readFileSync(path.join(wb, 'asset.bin'))], [0, 255, 128, 1]);
    assert.equal(fs.existsSync(path.join(wb, 'remove.txt')), false);
    assert.equal(fs.readFileSync(path.join(wb, 'run.sh'), 'utf8'), 'echo 2\n');
    const pub = ok(w, 'expand', b, { publication_id: id, paths: ['run.sh'] }).files[0];
    assert.equal(pub.result.executable, true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(wb, 'run.sh')).mode & 0o111, 0o111);
    assert.match(run(w, 'apply', b, { idempotency_key: 'x', publication_id: id, paths: ['other.txt'], cwd: wb, ...ctx }).error, /not in publication/);
    assert.match(run(w, 'publish', a, { idempotency_key: 'nothing', summary: 's', paths: ['ghost.txt'], cwd: wa, ...ctx }).error, /neither in your workspace nor in the base/);
  });

  it('published_local_versions_are_compatible_but_unpublished_edits_are_refused', () => {
    const w = world();
    const { base, wa, wb } = workspaces(w, { 'main.txt': 'baseline' });
    const ctx = { base };
    fs.writeFileSync(path.join(wa, 'main.txt'), 'first');
    const first = publish(w, a, 'first', ['main.txt'], { cwd: wa, ...ctx });
    ok(w, 'apply', b, { idempotency_key: 'first-import', publication_id: first, cwd: wb, ...ctx });
    fs.writeFileSync(path.join(wa, 'main.txt'), 'second');
    const second = publish(w, a, 'second', ['main.txt'], { cwd: wa, ...ctx });
    ok(w, 'apply', b, { idempotency_key: 'second-import', publication_id: second, cwd: wb, ...ctx });
    ok(w, 'apply', b, { idempotency_key: 'back-to-first', publication_id: first, cwd: wb, ...ctx });
    assert.equal(fs.readFileSync(path.join(wb, 'main.txt'), 'utf8'), 'first');
    fs.writeFileSync(path.join(wb, 'main.txt'), 'private unpublished edit');
    assert.match(run(w, 'apply', b, { idempotency_key: 'conflict', publication_id: first, cwd: wb, ...ctx }).error, /diverged/);
    assert.equal(fs.readFileSync(path.join(wb, 'main.txt'), 'utf8'), 'private unpublished edit');
  });

  it('tampered_publications_fail_before_import', () => {
    const w = world();
    const { base, wa, wb } = workspaces(w, { 'main.txt': 'baseline' });
    fs.writeFileSync(path.join(wa, 'main.txt'), 'published');
    const id = publish(w, a, 'publish', ['main.txt'], { cwd: wa, base });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(w.dir, 'swarm.db'));
    db.prepare('UPDATE blobs SET content = ? WHERE sha256 = ?').run(Buffer.from('tampered!'), crypto.createHash('sha256').update('published').digest('hex'));
    db.close();
    assert.match(run(w, 'apply', b, { idempotency_key: 'import', publication_id: id, cwd: wb, base }).error, /does not match its recorded hash/);
    assert.equal(fs.readFileSync(path.join(wb, 'main.txt'), 'utf8'), 'baseline');
  });

  it('traversal_symlink_and_git_paths_are_rejected', (t) => {
    const w = world();
    const { base, wa, wb } = workspaces(w, { 'main.txt': 'baseline' });
    const outside = path.join(w.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret'), 'secret');
    fs.symlinkSync(outside, path.join(wa, 'escape'), 'junction');
    let fileLink = true;
    try {
      fs.symlinkSync(path.join(outside, 'secret'), path.join(wa, 'linked'));
    } catch {
      fileLink = false;
    }
    const refused = ['../outside/secret', '/etc/passwd', 'C:\\Windows\\win.ini', 'escape/secret', '.git/config', '.GiT/config', 'sub/.GIT/config', 'a/../main.txt', ...(fileLink ? ['linked'] : [])];
    for (const [i, p] of refused.entries()) {
      assert.equal(run(w, 'publish', a, { idempotency_key: `p${i}`, summary: 's', paths: [p], cwd: wa, base }).ok, false, p);
    }
    if (!fileLink) t.diagnostic('no file symlink: this account cannot create one');

    fs.mkdirSync(path.join(wa, 'sub'));
    fs.writeFileSync(path.join(wa, 'sub', 'secret'), 'published');
    const id = publish(w, a, 'real', ['sub/secret'], { cwd: wa, base });
    fs.symlinkSync(outside, path.join(wb, 'sub'), 'junction');
    assert.match(run(w, 'apply', b, { idempotency_key: 'in', publication_id: id, cwd: wb, base }).error, /symlinks/);
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'secret');
  });

  it('interrupted_import_is_never_reported_as_success_without_matching_files', () => {
    const w = world();
    const { base, wa, wb } = workspaces(w, { 'main.txt': 'baseline' });
    fs.writeFileSync(path.join(wa, 'main.txt'), 'published');
    const id = publish(w, a, 'publish', ['main.txt'], { cwd: wa, base });
    const files = ok(w, 'expand', b, { publication_id: id }).files.map((f) => ({ path: f.path, result: f.result }));
    const args = { idempotency_key: 'lost', publication_id: id };
    const digest = crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(w.dir, 'swarm.db'));
    db.prepare("INSERT INTO requests(actor, key, name, digest, state, detail) VALUES (?, 'lost', 'apply', ?, 'applying', ?)").run(b.id, digest, JSON.stringify({ publication_id: id, files }));
    db.close();
    assert.match(run(w, 'apply', b, { ...args, cwd: wb, base }).error, /outcome is unknown/);
    assert.equal(fs.readFileSync(path.join(wb, 'main.txt'), 'utf8'), 'baseline');
    fs.writeFileSync(path.join(wb, 'main.txt'), 'published');
    assert.equal(ok(w, 'apply', b, { ...args, cwd: wb, base }).confirmed, true);
  });

  it('export and diff read the store without writing to it', () => {
    const w = world();
    assert.deepEqual(main('export', { dir: w.dir }), { ok: true, sequence: 0, events: [], workers: [] });
    assert.equal(fs.existsSync(w.dir), false);
    const { base, wa } = workspaces(w, { 'main.txt': 'one\n' });
    fs.writeFileSync(path.join(wa, 'main.txt'), 'two\n');
    fs.writeFileSync(path.join(wa, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
    const id = publish(w, a, 'p', ['main.txt', 'logo.png'], { cwd: wa, base });
    const all = main('export', { dir: w.dir });
    assert.equal(all.events.at(-1).kind, 'publication');
    assert.deepEqual(all.workers, [{ worker: 'worker-a', state: 'working', running: true, acked: 1 }]);
    assert.deepEqual(main('export', { dir: w.dir, since: all.sequence }).events, []);
    const diff = main('diff', { dir: w.dir, publication_id: id, path: 'main.txt' });
    assert.equal(diff.ok, true, diff.error);
    assert.match(diff.diff, /--- a\/main\.txt\n\+\+\+ b\/main\.txt\n@@ -1 \+1 @@\n-one\n\+two/);
    assert.equal(main('diff', { dir: w.dir, publication_id: id, path: 'logo.png' }).binary, true);
    assert.match(main('diff', { dir: w.dir, publication_id: id, path: 'none.txt' }).error, /not in publication/);
    assert.equal(main('export', { dir: w.dir }).sequence, all.sequence);
  });

  const parent = { id: 'sid-p' };
  const roster = [
    { name: 'worker-a', sessionId: a.id },
    { name: 'worker-b', sessionId: b.id },
  ];
  const team = (w) => ({ ...w, extra: { parent: parent.id, roster } });
  const done = (t, command, actor, args) => {
    const out = run(t, command, actor, args);
    assert.equal(out.ok, true, out.error);
    return out;
  };
  const worker = (out, name) => out.board.workers.find((x) => x.worker === name);
  const waitOn = (t, actor, key, dependency) =>
    done(t, 'complete', actor, { idempotency_key: key, outcome: 'waiting', expected_revision: 1, summary: 'Waiting', dependency });

  it('completion_requires_current_observed_revision, and a worker gets each request change once', () => {
    const t = team(world());
    done(t, 'status', a, { idempotency_key: 'start', summary: 'reading' });
    assert.deepEqual(done(t, 'request', parent, { idempotency_key: 'r2', text: 'Also support dark mode' }).result, { request_revision: 2 });
    const read = done(t, 'status', a);
    assert.equal(read.board.request_revision, 2);
    assert.deepEqual(read.request_updates, [{ revision: 2, text: 'Also support dark mode' }]);
    const stale = run(t,'complete', a, { idempotency_key: 'old', outcome: 'complete', expected_revision: 1, summary: 'Done' });
    assert.match(stale.error, /stale/);
    const current = done(t, 'complete', a, { idempotency_key: 'new', outcome: 'complete', expected_revision: 2, summary: 'Done' });
    assert.equal(current.result.expected_revision, 2);
    assert.deepEqual(current.request_updates, [{ revision: 2, text: 'Also support dark mode' }], 'the acknowledging call still shows the change');
    assert.equal(done(t, 'status', a).request_updates, undefined);
    assert.equal(done(t, 'status', b).request_updates.length, 1, 'a worker that never acted sees every change');
    assert.equal(events(t).find((e) => e.kind === 'outcome').revision, 2);
  });

  it('logs a stale declaration as outcome_refused, which acknowledges no revision', () => {
    const t = team(world());
    done(t, 'status', a, { idempotency_key: 'start', summary: 'reading' });
    done(t, 'request', parent, { idempotency_key: 'r2', text: 'Also support dark mode' });
    assert.match(run(t, 'complete', a, { idempotency_key: 'old', outcome: 'complete', expected_revision: 1, summary: 'Done' }).error, /stale/);
    const refused = events(t).filter((e) => e.kind === 'outcome_refused');
    assert.deepEqual(refused.map((e) => [e.actor, e.revision, e.payload]), [[a.id, 2, { worker: 'worker-a', outcome: 'complete', expected_revision: 1, revision: 2 }]]);
    assert.equal(run(t, 'complete', a, { idempotency_key: 'bad', outcome: 'nope', summary: 'x' }).ok, false);
    assert.deepEqual(events(t).at(-1).payload, { worker: 'worker-a', outcome: null, expected_revision: null, revision: 2 });
    const worker = (name) => main('export', { dir: t.dir }).workers.find((w) => w.worker === name);
    assert.equal(worker('worker-a').acked, 1, 'the refusal sent no request update');
    assert.deepEqual(done(t, 'status', a, { idempotency_key: 'next', summary: 'reading' }).request_updates, [{ revision: 2, text: 'Also support dark mode' }]);
    assert.equal(worker('worker-a').acked, 2);
  });

  it('a complete result must be on the board: each change in the workspace matches a publication', () => {
    const w = world();
    const { base, wa, wb } = workspaces(w, { '.gitignore': 'out/\n', 'main.txt': 'original', 'remove.txt': 'remove' });
    const ctx = { base };
    const complete = (actor, key, cwd) => run(w, 'complete', actor, { idempotency_key: key, outcome: 'complete', expected_revision: 1, summary: 'Done', cwd, ...ctx });
    fs.writeFileSync(path.join(wa, 'main.txt'), 'fixed');
    fs.writeFileSync(path.join(wa, 'new.txt'), 'new');
    fs.rmSync(path.join(wa, 'remove.txt'));
    fs.mkdirSync(path.join(wa, 'out'));
    fs.writeFileSync(path.join(wa, 'out', 'plan.json'), '{}');
    assert.match(complete(a, 'c1', wa).error, /publish your result before you declare it complete; not on the board: main\.txt, remove\.txt, new\.txt$/);
    publish(w, a, 'p1', ['main.txt', 'new.txt'], { cwd: wa, ...ctx });
    assert.match(complete(a, 'c2', wa).error, /not on the board: remove\.txt$/);
    publish(w, a, 'p2', ['remove.txt'], { cwd: wa, ...ctx });
    fs.writeFileSync(path.join(wa, 'main.txt'), 'fixed again');
    assert.match(complete(a, 'c3', wa).error, /not on the board: main\.txt$/);
    assert.equal(ok(w, 'complete', a, { idempotency_key: 'p', outcome: 'partial', expected_revision: 1, summary: 'More to do', cwd: wa, ...ctx }).outcome, 'partial', 'only complete is checked');
    fs.writeFileSync(path.join(wb, 'main.txt'), 'fixed');
    assert.equal(complete(b, 'c4', wb).result.outcome, 'complete', "a peer's publication puts an applied file on the board");
  });

  it('the spec is request revision 1, written once and never delivered as an update', () => {
    const t = team(world());
    assert.match(run(t, 'spec', a, { text: 'Ship it' }).error, /a worker has no spec/);
    assert.match(run(t, 'spec', parent, { text: ' ' }).error, /text must be nonempty/);
    assert.equal(done(t, 'spec', parent, { text: 'Ship it' }).result.request_revision, 1);
    assert.match(run(t, 'spec', parent, { text: 'Again' }).error, /has its spec; send a request/);
    const read = done(t, 'status', a);
    assert.equal(read.board.request_revision, 1);
    assert.equal(read.request_updates, undefined);
    assert.deepEqual(events(t).filter((e) => e.kind === 'request').map((e) => [e.revision, e.payload.text]), [[1, 'Ship it']]);
  });

  it('the spec brings the first tasks, all open, or none when it has none', () => {
    const t = team(world());
    assert.match(run(t, 'spec', parent, { text: 'Ship it', tasks: { title: 'x' } }).error, /tasks must be a list/);
    assert.match(run(t, 'spec', parent, { text: 'Ship it', tasks: [{ title: 'No description' }] }).error, /description/);
    assert.equal(done(t, 'status', a).board.tasks.length, 0, 'a refused spec writes no task');
    done(t, 'spec', parent, { text: 'Ship it', tasks: [{ title: 'Split', description: 'Make the split' }] });
    assert.deepEqual(done(t, 'status', a).board.tasks.map((x) => [x.task_id, x.title, x.state]), [[1, 'Split', 'available']]);
    const bare = team(world());
    done(bare, 'spec', parent, { text: 'Ship it' });
    assert.equal(done(bare, 'status', a).board.tasks.length, 0);
  });

  it('a list cursor from an older request revision is refused', () => {
    const t = team(world());
    for (let i = 0; i < 3; i++) create(t, a, `t${i}`);
    const page = done(t, 'list', a, { collection: 'tasks', limit: 1 }).result;
    assert.equal(page.request_revision, 1);
    done(t, 'request', parent, { idempotency_key: 'r2', text: 'Change' });
    assert.match(run(t,'list', a, { collection: 'tasks', limit: 1, cursor: page.next_cursor }).error, /request changed/);
  });

  it('waiting_dependencies_bind_to_real_peer_work', () => {
    const t = team(world());
    const task = create(t, b, 'storage');
    claim(t, b, 'claim', task);
    const wait = { outcome: 'waiting', expected_revision: 1, summary: 'Integrate peer storage' };
    done(t, 'complete', a, { idempotency_key: 'wait', ...wait, dependency: `task:${task}` });
    const mine = create(t, a, 'mine');
    claim(t, a, 'claim-mine', mine);
    for (const [i, dependency] of ['worker:worker-a', 'worker:worker-c', 'task:99999', 'storage publication', `task:${mine}`, undefined].entries()) {
      assert.equal(run(t,'complete', a, { idempotency_key: `bad-${i}`, ...wait, dependency }).ok, false, String(dependency));
    }
    const fin = create(t, b, 'fin');
    const v = claim(t, b, 'claim-fin', fin);
    ok(t, 'task_finish', b, { idempotency_key: 'fin-done', task_id: fin, expected_version: v, summary: 'ok' });
    assert.match(run(t,'complete', a, { idempotency_key: 'late', ...wait, dependency: `task:${fin}` }).error, /already finished/);
    assert.equal(worker(done(t, 'complete', a, { idempotency_key: 'peer', ...wait, dependency: 'worker:worker-b' }), 'worker-a').dependency, 'worker:worker-b');
  });

  it('wait_ready: a peer publication does not finish the named task, and its finish does', () => {
    const t = team(world());
    const { base, wb } = workspaces(t, { 'source.txt': 'one' });
    const task = create(t, b, 'storage');
    const version = claim(t, b, 'claim', task);
    done(t, 'complete', a, { idempotency_key: 'wait', outcome: 'waiting', expected_revision: 1, summary: 'Waiting for storage', dependency: `task:${task}` });
    const waiting = worker(done(t, 'status', a), 'worker-a');
    assert.deepEqual([waiting.state, waiting.ready, waiting.stalled], ['waiting', false, false]);
    fs.writeFileSync(path.join(wb, 'source.txt'), 'two');
    publish(t, b, 'unrelated', ['source.txt'], { cwd: wb, base });
    assert.equal(worker(done(t, 'status', a), 'worker-a').ready, false, 'a peer publication does not finish the named task');
    ok(t, 'task_finish', b, { idempotency_key: 'finish', task_id: task, expected_version: version, summary: 'Storage ready' });
    assert.equal(worker(done(t, 'status', a), 'worker-a').ready, true);
  });

  it('newly_available_work_wakes_but_already_claimed_work_does_not; a worker dependency wakes on its publication', () => {
    const t = team(world());
    const { base, wb } = workspaces(t, { 'api.txt': 'one' });
    create(t, b, 'old');
    waitOn(t, a, 'wait', 'worker:worker-b');
    assert.equal(worker(done(t, 'status', a), 'worker-a').ready, false, 'work available before the wait does not wake it');
    const task = create(t, b, 'new');
    assert.equal(worker(done(t, 'status', a), 'worker-a').ready, true);
    claim(t, b, 'claim', task);
    assert.equal(worker(done(t, 'status', a), 'worker-a').ready, false, 'already claimed work does not wake, and the old task predates the wait');
    const t2 = team(world());
    const ws = workspaces(t2, { 'api.txt': 'one' });
    done(t2, 'status', b, { idempotency_key: 'b', summary: 'building' });
    waitOn(t2, a, 'wait', 'worker:worker-b');
    fs.writeFileSync(path.join(ws.wb, 'api.txt'), 'two');
    publish(t2, b, 'api', ['api.txt'], { cwd: ws.wb, base: ws.base });
    assert.equal(worker(done(t2, 'status', a), 'worker-a').ready, true);
    assert.ok(base && wb);
  });

  const answer = ({ changes, ...rest }) => (assert.equal(typeof changes, 'number'), rest);
  const turn = (t, actor, running) => answer(ok(t, 'turn', actor, { running }));
  const wake = (t, actor) => answer(ok(t, 'wake', actor));

  it('only a response that carries a request revision acknowledges it', () => {
    const t = team(world());
    assert.equal(turn(t, a, false).reason, 'repair');
    done(t, 'request', parent, { idempotency_key: 'r2', text: 'More' });
    const woken = turn(t, a, false);
    assert.deepEqual([woken.reason, woken.message.startsWith('Request revision 2: More')], ['request', true], 'the automatic blocked does not swallow it');
  });

  it('a task the supervisor assigns wakes its idle worker', () => {
    const t = team(world());
    waitOn(t, a, 'wait-a', 'worker:worker-b');
    assert.equal(turn(t, a, false).wake, false, 'worker-b still runs');
    done(t, 'task_create', parent, { idempotency_key: 'assign', title: 'Mine', description: 'For a', assignee: 'worker-a' });
    assert.equal(wake(t, a).reason, 'assigned');
    turn(t, a, true);
    waitOn(t, a, 'wait-again', 'worker:worker-b');
    assert.equal(turn(t, a, false).wake, false, 'an assignment it already had does not wake it again');
  });

  it('a waiting worker is stalled while no worker has a turn running, as the no-producer wake decides', () => {
    const t = team(world());
    const task = create(t, b, 'open');
    const stalled = () => worker(done(t, 'status', parent), 'worker-b').stalled;
    waitOn(t, a, 'wait-a', `task:${task}`);
    waitOn(t, b, 'wait-b', `task:${task}`);
    assert.equal(turn(t, b, false).wake, false, 'worker-a still runs');
    assert.equal(stalled(), false);
    assert.equal(turn(t, a, false).reason, 'no_producer');
    waitOn(t, a, 'wait-a2', `task:${task}`);
    assert.equal(turn(t, a, false).wake, false, 'worker-a was repaired in this revision');
    assert.equal(stalled(), true, 'no turn runs and worker-b was not repaired');
    assert.equal(wake(t, b).reason, 'no_producer');
  });

  it('the store counts its changes in a file, and a turn start on a running worker writes nothing', () => {
    const t = team(world());
    const count = () => Number(fs.readFileSync(path.join(t.dir, 'changes'), 'utf8'));
    create(t, b, 'one');
    const before = count();
    assert.equal(ok(t, 'turn', a, { running: true }).changes, before, 'a fresh worker already runs');
    assert.equal(count(), before);
    const ended = ok(t, 'turn', a, { running: false });
    assert.equal(ended.changes, count());
    assert.ok(ended.changes > before);
    assert.equal(ok(t, 'wake', a).changes, count(), 'a wake with nothing to do changes nothing');
  });

  it('a worker wakes on its ready dependency or new work, never while its turn runs, and once per wake', () => {
    const t = team(world());
    const task = create(t, b, 'storage');
    const version = claim(t, b, 'claim', task);
    waitOn(t, a, 'wait', `task:${task}`);
    assert.deepEqual(turn(t, a, false), { wake: false }, 'the producer still runs its first turn');
    ok(t, 'task_finish', b, { idempotency_key: 'finish', task_id: task, expected_version: version, summary: 'Storage ready' });
    const woke = wake(t, a);
    assert.deepEqual([woke.wake, woke.reason], [true, 'ready']);
    assert.match(woke.message, /^Shared work changed/);
    const row = worker(done(t, 'status', b), 'worker-a');
    assert.deepEqual([row.state, row.running, row.dependency], ['working', true, null]);
    assert.deepEqual(wake(t, a), { wake: false }, 'a wake counts as the next turn');
    waitOn(t, a, 'wait-b', 'worker:worker-b');
    assert.deepEqual(turn(t, a, false), { wake: false }, 'nothing new since that turn');
    create(t, b, 'more');
    assert.equal(wake(t, a).reason, 'ready', 'a waiter wakes for work that became available after its wait');
    turn(t, a, true);
    create(t, b, 'busy');
    assert.deepEqual(wake(t, a), { wake: false }, 'a running turn is never woken');
    assert.deepEqual(events(t).filter((e) => e.kind === 'worker_woken').map((e) => [e.payload.worker, e.payload.reason, e.payload.state]), [
      ['worker-a', 'ready', 'waiting'],
      ['worker-a', 'ready', 'waiting'],
    ]);
  });

  it('no producer: with no turn running, one waiter wakes, once per request revision', () => {
    const t = team(world());
    waitOn(t, a, 'wait-a', 'worker:worker-b');
    waitOn(t, b, 'wait-b', 'worker:worker-a');
    assert.deepEqual(turn(t, a, false), { wake: false }, 'worker-b still runs');
    const first = turn(t, b, false);
    assert.deepEqual([first.reason, first.message], ['no_producer', 'Your dependency has no active producer. Resolve available work now, or declare blocked with the concrete input needed.']);
    assert.deepEqual(wake(t, a), { wake: false }, 'the woken worker now runs');
    waitOn(t, b, 'wait-b2', 'worker:worker-a');
    assert.deepEqual(turn(t, b, false), { wake: false });
    assert.equal(wake(t, a).reason, 'no_producer', 'the other waiter wakes in its turn');
    waitOn(t, a, 'wait-a2', 'worker:worker-b');
    assert.deepEqual(turn(t, a, false), { wake: false }, 'only once per revision');
    done(t, 'request', parent, { idempotency_key: 'r2', text: 'Also support dark mode' });
    const update = wake(t, a);
    assert.equal(update.reason, 'request');
    assert.match(update.message, /^Request revision 2: Also support dark mode\n\nRead the board/);
    assert.equal(done(t, 'status', a).request_updates, undefined, 'the wake delivered the change');
    assert.match(run(t, 'turn', parent, { running: false }).error, /the supervisor has no turn/);
    assert.match(run(t, 'notices', a).error, /a worker has no notices/);
    assert.match(run(t, 'turn', a, {}).error, /running must be true or false/);
  });

  it('nothing wakes after a complete outcome or the end, or a stopped worker', () => {
    const t = team(world());
    const held = done(t, 'task_create', parent, { idempotency_key: 'held', title: 'Held', description: 'x', assignee: 'worker-a' }).result;
    done(t, 'complete', b, { idempotency_key: 'done', outcome: 'complete', expected_revision: 1, summary: 'Goal met' });
    assert.match(run(t, 'task_create', b, { idempotency_key: 'late', title: 'Late', description: 'x' }).error, /declared the goal complete/);
    assert.equal(done(t, 'complete', b, { idempotency_key: 'done', outcome: 'complete', expected_revision: 1, summary: 'Goal met' }).result.outcome, 'complete', 'a resent call still replays');
    assert.deepEqual(turn(t, a, false), { wake: false }, 'no repair while a candidate waits');
    assert.deepEqual(answer(ok(t, 'notices', parent)).notices, [
      { kind: 'complete', worker: 'worker-b', summary: 'Goal met', revision: 1, open: [{ task_id: held.task_id, state: 'claimed', owner: 'worker-a', title: 'Held' }] },
    ]);
    done(t, 'worker_stop', a, { idempotency_key: 'stop', reason: 'session ended' });
    done(t, 'request', parent, { idempotency_key: 'r2', text: 'More' });
    assert.deepEqual(wake(t, a), { wake: false }, 'a stopped worker is not woken');
    assert.equal(turn(t, b, false).reason, 'request', 'a new revision reopens the goal');
    done(t, 'end', parent, { idempotency_key: 'end', outcome: 'complete', summary: 'Goal met' });
    assert.deepEqual(wake(t, b), { wake: false, ended: true });
  });

  it('the parent adds, assigns, closes and releases tasks, and cannot do worker work', () => {
    const t = team(world());
    const open = done(t, 'task_create', parent, { idempotency_key: 'open', title: 'Open', description: 'Anyone' }).result;
    assert.deepEqual([open.state, open.owner], ['available', undefined]);
    const assigned = done(t, 'task_create', parent, { idempotency_key: 'assigned', title: 'Mine', description: 'For a', assignee: 'worker-a' }).result;
    assert.deepEqual([assigned.state, assigned.owner], ['claimed', 'worker-a']);
    assert.equal(taskFile(t, assigned.task_id).owner, 'worker-a');
    assert.equal(events(t).find((e) => e.kind === 'task_create').name, 'supervisor');
    assert.match(run(t,'task_create', a, { idempotency_key: 'x', title: 'X', description: 'X', assignee: 'worker-b' }).error, /only the supervisor assigns/);
    assert.match(run(t,'task_create', parent, { idempotency_key: 'y', title: 'Y', description: 'Y', assignee: 'worker-z' }).error, /unknown assignee/);
    const update = { task_id: assigned.task_id, expected_version: assigned.version, title: 'Renamed' };
    const updated = done(t, 'task_update', a, { idempotency_key: 'u1', ...update }).result;
    done(t, 'task_release', parent, { idempotency_key: 'take', task_id: assigned.task_id, summary: 'Scope changed' });
    assert.match(run(t,'task_update', a, { idempotency_key: 'u2', ...update, expected_version: updated.version }).error, /only the current owner/);
    assert.equal(run(t,'task_close', parent, { idempotency_key: 'close-claimed', task_id: open.task_id, reason: 'x' }).ok, true);
    assert.equal(ok(t, 'expand', a, { task_id: open.task_id }).summary, 'Closed: x');
    assert.match(run(t,'task_close', parent, { idempotency_key: 'again', task_id: open.task_id, reason: 'x' }).error, /already finished/);
    claim(t, b, 'c', assigned.task_id);
    assert.match(run(t,'task_close', parent, { idempotency_key: 'busy', task_id: assigned.task_id, reason: 'x' }).error, /release it first/);
    assert.match(run(t,'task_close', a, { idempotency_key: 'w', task_id: assigned.task_id, reason: 'x' }).error, /only the supervisor/);
    assert.match(run(t,'task_claim', parent, { idempotency_key: 'p', task_id: open.task_id }).error, /the supervisor cannot task_claim/);
    assert.match(run(t,'status', parent, { idempotency_key: 'p', summary: 'x' }).error, /the supervisor cannot status/);
    assert.equal(done(t, 'status', parent).result.worker, 'supervisor');
    assert.equal(done(t, 'status', parent).board.workers.some((x) => x.worker === 'supervisor'), false);
  });

  it('a stopped worker releases its claims with a handoff (release_worker_claims)', () => {
    const t = team(world());
    const one = create(t, a, 'one');
    const two = create(t, a, 'two');
    claim(t, a, 'c1', one);
    claim(t, a, 'c2', two);
    assert.match(run(t,'worker_stop', a, { idempotency_key: 's', worker: 'worker-b', reason: 'x' }).error, /stops only itself/);
    const stopped = done(t, 'worker_stop', parent, { idempotency_key: 'stop', worker: 'worker-a', reason: 'session exited' });
    assert.deepEqual(stopped.result, { worker: 'worker-a', state: 'stopped', released: [one, two] });
    assert.equal(worker(stopped, 'worker-a').state, 'stopped');
    const task = ok(t, 'expand', b, { task_id: one });
    assert.deepEqual([task.state, task.owner], ['available', null]);
    assert.match(task.handoff, /^Owner stopped: session exited\. Reuse published contributions/);
    assert.equal(taskFile(t, one).status, 'pending');
    assert.deepEqual(events(t).filter((e) => e.kind === 'task_owner_stopped').map((e) => e.payload.task_id), [one, two]);
    assert.deepEqual(done(t, 'worker_stop', b, { idempotency_key: 'self', reason: 'done' }).result, { worker: 'worker-b', state: 'stopped', released: [] });
  });

  it('the end records an outcome and refuses every later change', () => {
    const t = team(world());
    const id = create(t, a, 'one');
    assert.match(run(t,'end', a, { idempotency_key: 'e', outcome: 'complete', summary: 'x' }).error, /only the supervisor/);
    assert.match(run(t,'end', parent, { idempotency_key: 'bad', outcome: 'done', summary: 'x' }).error, /outcome must be/);
    const end = done(t, 'end', parent, { idempotency_key: 'end', outcome: 'complete', summary: 'Goal met' });
    assert.deepEqual([end.board.state, end.board.outcome.outcome, end.board.outcome.summary], ['ended', 'complete', 'Goal met']);
    assert.deepEqual(done(t, 'end', parent, { idempotency_key: 'end', outcome: 'complete', summary: 'Goal met' }).result, end.result, 'a resent end replays');
    assert.match(run(t,'task_claim', b, { idempotency_key: 'late', task_id: id }).error, /This swarm has ended/);
    assert.equal(done(t, 'status', b).board.state, 'ended', 'reads still work');
    assert.equal(events(t).at(-1).kind, 'end');
  });

  it('a turn with no outcome gets one repair resume, then counts as blocked; an interrupted turn gets none', () => {
    const t = team(world());
    const first = turn(t, a, false);
    assert.deepEqual([first.wake, first.reason], [true, 'repair']);
    assert.match(first.message, /^State the whole-request outcome with swarm_complete/);
    assert.deepEqual(turn(t, a, false), { wake: false });
    const row = worker(done(t, 'status', b), 'worker-a');
    assert.deepEqual([row.state, row.summary], ['blocked', 'Ended a second turn without an outcome.']);
    assert.equal(events(t).filter((e) => e.kind === 'outcome').at(-1).payload.outcome, 'blocked');
    assert.deepEqual(answer(ok(t, 'turn', b, { running: false, reason: 'aborted' })), { wake: false });
    assert.equal(worker(done(t, 'status', b), 'worker-b').state, 'working', 'the user interrupted it');
    done(t, 'request', parent, { idempotency_key: 'r2', text: 'Use KEY_NAME' });
    assert.equal(wake(t, a).reason, 'request', 'a request resumes a blocked worker');
  });

  it('partial resumes the same worker, and a new outcome resets the repair', () => {
    const t = team(world());
    done(t, 'complete', a, { idempotency_key: 'p', outcome: 'partial', expected_revision: 1, summary: 'Parser done, CLI left', checks: ['npm test: 12 pass'], artifacts: [] });
    const resumed = turn(t, a, false);
    assert.deepEqual([resumed.wake, resumed.reason], [true, 'partial']);
    assert.match(resumed.message, /^Continue the concrete unfinished requirement/);
    assert.equal(turn(t, a, false).reason, 'repair');
    const outcome = events(t).find((e) => e.kind === 'outcome').payload;
    assert.deepEqual([outcome.checks, outcome.artifacts], [['npm test: 12 pass'], []]);
    for (const bad of [{ checks: 'npm test' }, { checks: [''] }, { artifacts: ['../out'] }]) {
      assert.equal(run(t, 'complete', b, { idempotency_key: JSON.stringify(bad), outcome: 'partial', expected_revision: 1, summary: 'x', ...bad }).ok, false, JSON.stringify(bad));
    }
  });

  it('the supervisor gets blocked and stopped workers once, a stall once per change, and the end', () => {
    const t = team(world());
    const notices = () => answer(ok(t, 'notices', parent));
    assert.deepEqual(notices(), { ended: false, notices: [] }, 'both workers still run their first turn');
    done(t, 'complete', a, { idempotency_key: 'blk', outcome: 'blocked', expected_revision: 1, summary: 'Need the API key name' });
    waitOn(t, b, 'w', 'worker:worker-a');
    const counted = ok(t, 'notices', parent);
    assert.deepEqual(counted.notices, [{ kind: 'blocked', worker: 'worker-a', summary: 'Need the API key name', revision: 1 }]);
    assert.deepEqual(notices().notices, [], 'the cursor repeats nothing');
    assert.equal(ok(t, 'notices', parent).changes, counted.changes, 'a cursor write wakes no worker');
    assert.deepEqual(turn(t, a, false), { wake: false });
    assert.equal(turn(t, b, false).reason, 'no_producer');
    assert.deepEqual(notices().notices, [], 'worker-b runs');
    waitOn(t, b, 'w2', 'worker:worker-a');
    assert.deepEqual(turn(t, b, false), { wake: false });
    assert.deepEqual(notices().notices, [{ kind: 'stalled', summary: 'No active worker can continue.' }]);
    assert.deepEqual(notices().notices, [], 'once per change');
    done(t, 'request', parent, { idempotency_key: 'r2', text: 'Use KEY_NAME' });
    assert.deepEqual(notices().notices, [], 'the request wakes both');
    done(t, 'worker_stop', parent, { idempotency_key: 's', worker: 'worker-b', reason: 'session exited' });
    assert.deepEqual(notices().notices, [{ kind: 'stopped', worker: 'worker-b', summary: 'session exited' }]);
    done(t, 'end', parent, { idempotency_key: 'e', outcome: 'stopped', summary: 'Stopped' });
    assert.deepEqual(notices(), { ended: true, notices: [] });
  });
});

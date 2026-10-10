const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const STORE = path.join(__dirname, '..', 'plugin', 'plugins', 'kanban-delm-swarm', 'scripts', 'store.mjs');
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

  const run = (w, command, actor, args = {}) => main(command, { dir: w.dir, tasksDir: w.tasksDir, actor, ...args });
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
    assert.match(run(w, 'status', a, { idempotency_key: 'wait', state: 'waiting' }).error, /waiting requires a named dependency/);
    const first = run(w, 'status', a, { idempotency_key: 'one', finding: 'Interface uses stable IDs' });
    ok(w, 'status', b, { idempotency_key: 'two', state: 'waiting', dependency: 'persistence publication', finding: 'Reload needs migration' });
    assert.deepEqual(run(w, 'status', a, { idempotency_key: 'one', finding: 'Interface uses stable IDs' }).result, first.result);
    const board = view(w);
    assert.equal(board.findings.length, 2);
    assert.deepEqual(board.findings.map((f) => [f.author, f.text]), [['worker-b', 'Reload needs migration'], ['worker-a', 'Interface uses stable IDs']]);
    assert.deepEqual(board.workers.find((x) => x.worker === 'worker-b').dependency, 'persistence publication');
    assert.equal(ok(w, 'expand', b, { finding_id: first.result.finding_id }).text, 'Interface uses stable IDs');
    ok(w, 'status', b, { idempotency_key: 'three', state: 'working' });
    assert.equal(view(w).workers.find((x) => x.worker === 'worker-b').dependency, null);
  });

  it('a waiting status call wakes on a peer task after since and times out on its own writes', () => {
    const w = world();
    ok(w, 'status', a, { idempotency_key: 's', summary: 'busy' });
    const own = ok(w, 'status', a, { wait: 0.3 });
    assert.equal(own.woke_by, 'timeout');
    const since = view(w).sequence;
    create(w, b, 'new');
    const woke = ok(w, 'status', a, { wait: 5, since });
    assert.deepEqual([woke.woke_by, woke.woken.map((e) => [e.worker, e.kind])], ['update', [['worker-b', 'task_create']]]);
    assert.ok(woke.waited < 1);
    assert.equal(events(w, since).length, 1, 'a wait writes nothing');
  });

  it('a waiting status call wakes at once on a target already done', () => {
    const w = world();
    const id = create(w, b, 's');
    const version = claim(w, b, 'c', id);
    ok(w, 'task_finish', b, { idempotency_key: 'f', task_id: id, expected_version: version, summary: 'ok' });
    const woke = ok(w, 'status', a, { wait: 5, target: id });
    assert.equal(woke.woke_by, 'already');
    assert.ok(woke.waited < 1);
    assert.match(run(w, 'status', a, { wait: 1, target: String(id) }).error, /target must be a positive integer/);
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
    assert.deepEqual(main('export', { dir: w.dir }), { ok: true, sequence: 0, events: [] });
    assert.equal(fs.existsSync(w.dir), false);
    const { base, wa } = workspaces(w, { 'main.txt': 'one\n' });
    fs.writeFileSync(path.join(wa, 'main.txt'), 'two\n');
    fs.writeFileSync(path.join(wa, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
    const id = publish(w, a, 'p', ['main.txt', 'logo.png'], { cwd: wa, base });
    const all = main('export', { dir: w.dir });
    assert.equal(all.events.at(-1).kind, 'publication');
    assert.deepEqual(main('export', { dir: w.dir, since: all.sequence }).events, []);
    const diff = main('diff', { dir: w.dir, publication_id: id, path: 'main.txt' });
    assert.equal(diff.ok, true, diff.error);
    assert.match(diff.diff, /--- a\/main\.txt\n\+\+\+ b\/main\.txt\n@@ -1 \+1 @@\n-one\n\+two/);
    assert.equal(main('diff', { dir: w.dir, publication_id: id, path: 'logo.png' }).binary, true);
    assert.match(main('diff', { dir: w.dir, publication_id: id, path: 'none.txt' }).error, /not in publication/);
    assert.equal(main('export', { dir: w.dir }).sequence, all.sequence);
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');

const now = new Date().toISOString();
const SESSIONS = [
  { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'busy one', project: '/p/alpha', gitBranch: 'main', modifiedAt: now, active: true, inProgress: 1, completed: 0, taskCount: 1 },
  { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'old one', project: '/p/alpha', modifiedAt: now, active: false, inProgress: 0, completed: 0, taskCount: 0 },
  { id: 'cccccccc-0000-0000-0000-000000000003', name: 'pinned idle', project: '/p/beta', modifiedAt: now, active: false, inProgress: 0, completed: 0, taskCount: 0 },
];
const PINS = { [SESSIONS[2].id]: 'pinned' };
const GROUPS = {
  rev: 4,
  groups: [{
    id: 'g1',
    name: 'Work',
    parent: null,
    members: [
      { type: 'session', ref: SESSIONS[0].id },
      { type: 'session', ref: SESSIONS[1].id },
      { type: 'session', ref: 'dddddddd-0000-0000-0000-00000000dead' },
    ],
  }],
};

// Stands in for the board: it keeps the pins, `filter=active` keeps active sessions and the
// pinned/included ones, as the real route does; `include` adds the named ids; `project` keeps a
// project's sessions and the included ones; `pins=off` drops the pins.
async function withBoard(fn, { groups = GROUPS, sessions = SESSIONS } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(url);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/groups') return res.end(JSON.stringify(groups));
    if (url.pathname === '/api/sessions') {
      const pins = url.searchParams.get('pins') === 'off' ? {} : PINS;
      const include = new Set((url.searchParams.get('include') || '').split(','));
      const keep = new Set([...Object.keys(pins), ...include]);
      const active = url.searchParams.get('filter') === 'active';
      const project = url.searchParams.get('project');
      const rows = sessions
        .filter((s) => !active || s.active || keep.has(s.id))
        .filter((s) => !project || s.project === project || s.worktree?.repo === project || include.has(s.id))
        .map((s) => ({ ...s, pin: pins[s.id] || null }));
      return res.end(JSON.stringify(rows));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-cli-active-'));
    const run = (args) => new Promise((resolve) => {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, CCK_URL: `http://127.0.0.1:${srv.address().port}` };
      delete env.PORT;
      execFile(process.execPath, [SERVER, ...args], { env }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    await fn(run, hits);
  } finally {
    srv.close();
  }
}

const sessionHits = (hits) => hits.filter((u) => u.pathname === '/api/sessions');

describe('session list', () => {
  it('shows active sessions by default, through the server filter, with pinned ones', async () => {
    await withBoard(async (run, hits) => {
      const { code, stdout } = await run(['session', 'list', '--json']);
      assert.equal(code, 0);
      assert.equal(sessionHits(hits)[0].searchParams.get('filter'), 'active');
      const ids = JSON.parse(stdout).map((s) => s.id);
      assert.deepEqual(ids.sort(), [SESSIONS[0].id, SESSIONS[2].id].sort());
    });
  });

  it('takes pins from the server rows and makes one request', async () => {
    await withBoard(async (run, hits) => {
      const { stdout } = await run(['session', 'list', '--json']);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].searchParams.get('pinned'), null);
      const row = JSON.parse(stdout).find((s) => s.id === SESSIONS[2].id);
      assert.equal(row.pinState, 'pinned');
      assert.ok(!('pin' in row), 'one pin field');
    });
  });

  it('--no-pins asks the server to drop the pins', async () => {
    await withBoard(async (run, hits) => {
      const { stdout } = await run(['session', 'list', '--no-pins', '--json']);
      assert.equal(sessionHits(hits)[0].searchParams.get('pins'), 'off');
      assert.deepEqual(JSON.parse(stdout).map((s) => s.id), [SESSIONS[0].id]);
    });
  });

  it('--all shows every session', async () => {
    await withBoard(async (run, hits) => {
      const { stdout } = await run(['session', 'list', '--all', '--json']);
      assert.equal(sessionHits(hits)[0].searchParams.get('filter'), null);
      assert.equal(JSON.parse(stdout).length, 3);
    });
  });

  it('--active is an alias that does nothing', async () => {
    await withBoard(async (run) => {
      const a = await run(['session', 'list', '--json']);
      const b = await run(['session', 'list', '--active', '--json']);
      assert.equal(b.code, 0);
      assert.deepEqual(JSON.parse(b.stdout).map((s) => s.id), JSON.parse(a.stdout).map((s) => s.id));
    });
  });

  it("takes STATUS from the board's badge rule, not the visibility flag", async () => {
    const recent = { id: 'ffffffff-0000-0000-0000-000000000001', name: 'in grace window', project: '/p/alpha', modifiedAt: now, active: true, hasRecentActivity: true, inProgress: 0, completed: 0, taskCount: 0 };
    const logging = { ...recent, id: 'ffffffff-0000-0000-0000-000000000002', hasRecentLog: true };
    await withBoard(async (run) => {
      const { stdout } = await run(['session', 'list', '--all']);
      assert.match(stdout, /aaaaaaaa\s+busy/);
      assert.match(stdout, /bbbbbbbb\s+idle/);
      assert.match(stdout, /ffffffff\s+idle\s.*in grace window/);
      assert.match(stdout, /ffffffff\s+active\s/);
    }, { sessions: [...SESSIONS, recent, logging] });
  });
});

describe('group list', () => {
  it('shows only active members by default, with visible/total', async () => {
    await withBoard(async (run) => {
      const { code, stdout } = await run(['group', 'list', '--json']);
      assert.equal(code, 0);
      const [g] = JSON.parse(stdout).groups;
      assert.equal(g.visible, 1);
      assert.equal(g.total, 3);
      assert.deepEqual(g.members, [{ type: 'session', ref: SESSIONS[0].id, title: 'busy one', branch: 'main', status: 'busy', pinned: null, age: g.members[0].age }]);
      const table = await run(['group', 'list']);
      assert.match(table.stdout, /Work \(1\/3\)/);
    });
  });

  it('--all shows every member, and a member with no session as missing', async () => {
    await withBoard(async (run) => {
      const { stdout } = await run(['group', 'list', '--all', '--json']);
      const [g] = JSON.parse(stdout).groups;
      assert.equal(g.visible, 3);
      assert.equal(g.members[1].status, 'idle');
      assert.deepEqual(g.members[2], { type: 'session', ref: 'dddddddd-0000-0000-0000-00000000dead', missing: true });
    });
  });
});

describe('group list with dispatch groups', () => {
  const at = (n) => `eeeeeeee-0000-0000-0000-00000000000${n}`;
  const DISPATCHED = [
    { id: at(1), name: 'worker one', project: '/p/gamma', modifiedAt: now, active: true, dispatchGroup: 'cli-active-pins' },
    { id: at(2), name: 'worker two', project: '/p/gamma', modifiedAt: now, active: false, dispatchGroup: 'cli-active-pins' },
    { id: at(3), name: 'released', project: '/p/gamma', modifiedAt: now, active: true, dispatchGroup: 'cli-active-pins' },
    { ...SESSIONS[0], dispatchGroup: 'cli-active-pins' },
  ];
  const sessions = [...DISPATCHED, ...SESSIONS.slice(1)];
  const dispatch = Object.fromEntries(DISPATCHED.map((s) => [s.id, s.dispatchGroup]));
  const board = (groups) => ({ sessions, groups: { ...GROUPS, groups, released: [at(3)], dispatch } });

  it('lists a dispatch group after the user groups, without a released session or one a user group holds', async () => {
    await withBoard(async (run, hits) => {
      const { code, stdout } = await run(['group', 'list', '--json']);
      assert.equal(code, 0);
      const groups = JSON.parse(stdout).groups;
      assert.deepEqual(groups.map((g) => [g.id, g.name, g.dispatch, g.visible, g.total]), [
        ['g1', 'Work', undefined, 1, 3],
        ['dispatch:cli-active-pins', 'cli-active-pins', true, 1, 2],
      ]);
      assert.deepEqual(groups[1].members.map((m) => [m.ref, m.title]), [[at(1), 'worker one']]);
      assert.equal(hits.find((u) => u.pathname === '/api/groups').searchParams.get('dispatch'), '1');
      const include = sessionHits(hits)[0].searchParams.get('include').split(',');
      assert.ok([at(1), at(2)].every((id) => include.includes(id)), 'asks for the dispatched sessions');
      const all = await run(['group', 'list', '--all']);
      assert.match(all.stdout, /-\s+cli-active-pins \(dispatch\) \(2\/2\)/);
      assert.doesNotMatch(all.stdout, /released/);
    }, board(GROUPS.groups));
  });

  it('puts a dispatched session in the user group with the same name, in any case', async () => {
    const named = { id: 'g2', name: 'CLI-Active-Pins', parent: null, members: [{ type: 'session', ref: SESSIONS[1].id }] };
    await withBoard(async (run) => {
      const { stdout } = await run(['group', 'list', '--all', '--json']);
      const groups = JSON.parse(stdout).groups;
      assert.deepEqual(groups.map((g) => g.id), ['g1', 'g2']);
      assert.deepEqual(groups[1].members.map((m) => m.ref), [SESSIONS[1].id, at(1), at(2)]);
      assert.equal(groups[1].total, 3);
    }, board([GROUPS.groups[0], named]));
  });

  it('counts a project member as the sidebar does, from per-project lite requests', async () => {
    const sid = (n) => `99999999-0000-0000-0000-00000000000${n}`;
    const repoSessions = [
      { id: sid(1), name: 'held elsewhere', project: '/repo/wt', worktree: { repo: '/repo' }, modifiedAt: now, active: true },
      { id: sid(2), name: 'plain', project: '/repo', modifiedAt: now, active: true },
      { id: sid(3), name: 'other repo', project: '/repo', worktree: { repo: '/other' }, modifiedAt: now, active: true },
      { id: sid(4), name: 'worktree', project: '/repo/wt2', worktree: { repo: '/repo' }, modifiedAt: now, active: true },
    ];
    const groups = [
      { id: 'gp', name: 'Repo', parent: null, members: [{ type: 'project', ref: '/repo' }] },
      { id: 'gs', name: 'Mine', parent: null, members: [{ type: 'session', ref: sid(1) }] },
    ];
    await withBoard(async (run, hits) => {
      const { stdout } = await run(['group', 'list', '--all', '--json']);
      assert.equal(JSON.parse(stdout).groups[0].members[0].sessions, 2, 'plain and worktree; not one held by id or keyed by another repo');
      const projectHits = sessionHits(hits).filter((u) => u.searchParams.get('project'));
      assert.deepEqual(projectHits.map((u) => [u.searchParams.get('project'), u.searchParams.get('lite')]), [['/repo', '1']]);
      assert.ok(sessionHits(hits).every((u) => u.searchParams.get('project') || u.searchParams.get('limit') !== 'all'), 'no request for every session');
    }, { sessions: [...SESSIONS, ...repoSessions], groups: { rev: 1, groups } });
  });

  it('asks for many member ids in batches', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `abcdef00-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const groups = [{ id: 'big', name: 'Big', parent: null, members: ids.map((ref) => ({ type: 'session', ref })) }];
    await withBoard(async (run, hits) => {
      const { code, stdout } = await run(['group', 'list', '--all', '--json']);
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).groups[0].total, 450);
      const batches = sessionHits(hits).map((u) => u.searchParams.get('include').split(','));
      assert.ok(batches.every((b) => b.length <= 100));
      assert.equal(new Set(batches.flat()).size, 450);
    }, { groups: { rev: 1, groups } });
  });

  it('leaves a dispatched session in the user group that holds its project', async () => {
    const byProject = { id: 'g3', name: 'Gamma', parent: null, members: [{ type: 'project', ref: '/p/gamma' }] };
    await withBoard(async (run) => {
      const { stdout } = await run(['group', 'list', '--all', '--json']);
      const groups = JSON.parse(stdout).groups;
      assert.deepEqual(groups.map((g) => g.id), ['g3', 'dispatch:cli-active-pins']);
      assert.equal(groups[0].members[0].sessions, 3);
      assert.deepEqual(groups[1].members.map((m) => m.ref), [SESSIONS[0].id], 'a session of another project still goes to the dispatch group');
    }, board([byProject]));
  });
});

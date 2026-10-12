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
      const limit = Number(url.searchParams.get('limit'));
      res.setHeader('X-Total-Count', String(rows.length));
      return res.end(JSON.stringify(limit ? rows.filter((s, i) => i < limit || s.pin || include.has(s.id)) : rows));
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

  it('sends no limit for the active view and 20 with --all', async () => {
    await withBoard(async (run, hits) => {
      await run(['session', 'list', '--json']);
      await run(['session', 'list', '--all', '--json']);
      assert.deepEqual(sessionHits(hits).map((u) => u.searchParams.get('limit')), ['all', '20']);
    });
  });

  it('says how many rows a limit cut, on stderr with --json', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...SESSIONS[0], id: `eeeeeeee-0000-0000-0000-00000000000${i}`, name: `row ${i}` }));
    await withBoard(async (run) => {
      const json = await run(['session', 'list', '--limit', '2', '--json']);
      assert.equal(JSON.parse(json.stdout).length, 2);
      assert.match(json.stderr, /^2 of 6 shown; --limit all shows every row/m);
      const text = await run(['session', 'list', '--limit', '2']);
      assert.match(text.stdout, /2 of 6 shown/);
      const whole = await run(['session', 'list']);
      assert.doesNotMatch(whole.stdout + whole.stderr, /shown;/);
    }, { sessions: [...many, SESSIONS[2]] });
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

describe('group list members', () => {
  it('marks a transient group and asks the board for its members by id', async () => {
    const at = (n) => `eeeeeeee-0000-0000-0000-00000000000${n}`;
    const workers = [
      { id: at(1), name: 'worker one', project: '/p/gamma', modifiedAt: now, active: true },
      { id: at(2), name: 'worker two', project: '/p/gamma', modifiedAt: now, active: false },
    ];
    const swarm = { id: 'g2', name: 'swarm-1', parent: 'g1', transient: true, members: workers.map((s) => ({ type: 'session', ref: s.id })) };
    await withBoard(async (run, hits) => {
      const { code, stdout } = await run(['group', 'list', '--json']);
      assert.equal(code, 0);
      const groups = JSON.parse(stdout).groups;
      assert.deepEqual(groups.map((g) => [g.id, g.transient, g.visible, g.total]), [['g1', undefined, 1, 3], ['g2', true, 1, 2]]);
      assert.equal(hits.find((u) => u.pathname === '/api/groups').search, '');
      const all = await run(['group', 'list', '--all']);
      assert.match(all.stdout, /g2\s+swarm-1 \(transient\) \(2\/2\)/);
    }, { sessions: [...SESSIONS, ...workers], groups: { rev: 1, groups: [GROUPS.groups[0], swarm] } });
  });

  it('counts a project member as the sidebar does, from one lite request', async () => {
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
      assert.deepEqual(sessionHits(hits).map((u) => [u.searchParams.get('limit'), u.searchParams.get('lite'), u.searchParams.get('include')]), [['all', '1', null]]);
      hits.length = 0;
      const active = await run(['group', 'list', '--json']);
      assert.equal(JSON.parse(active.stdout).groups[0].members[0].sessions, 2);
      assert.ok(sessionHits(hits).every((u) => u.searchParams.get('lite') === '1'));
      assert.equal(sessionHits(hits).find((u) => u.searchParams.get('limit') === 'all').searchParams.get('filter'), 'active');
    }, { sessions: [...SESSIONS, ...repoSessions], groups: { rev: 1, groups } });
  });

  it('asks for many member ids in batches', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `abcdef00-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const groups = [{ id: 'big', name: 'Big', parent: null, members: ids.map((ref) => ({ type: 'session', ref })) }];
    await withBoard(async (run, hits) => {
      const { code, stdout } = await run(['group', 'list', '--json']);
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).groups[0].total, 450);
      const batches = sessionHits(hits).filter((u) => u.searchParams.get('include')).map((u) => u.searchParams.get('include').split(','));
      assert.ok(batches.every((b) => b.length <= 100));
      assert.equal(new Set(batches.flat()).size, 450);
    }, { groups: { rev: 1, groups } });
  });
});

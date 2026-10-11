const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const START = path.join(__dirname, '..', 'start.mjs');

// A git hook runs the tests with GIT_DIR and friends set, which would make the temp dir look like cck.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

const tempConfig =() => fs.mkdtempSync(path.join(os.tmpdir(), 'cck-swarm-start-')).replaceAll('\\', '/');

describe('swarm start', () => {
  let m;
  before(async () => {
    m = await import(pathToFileURL(START).href);
  });

  it('names the list after the goal', () => {
    assert.equal(m.slug('Fix the  Login redirect!'), 'fix-the-login-redirect');
    assert.equal(m.slug('A very long goal that goes on and on'), 'a-very-long-goal-that-go');
    assert.equal(m.slug('???'), 'goal');
    assert.equal(m.configDir({ CLAUDE_CONFIG_DIR: 'C:\\cfg' }), 'C:/cfg');
    assert.equal(m.configDir({ USERPROFILE: 'C:\\Users\\a' }), 'C:/Users/a/.claude');
  });

  it('refuses a name that a swarm, a task list or a group holds', () => {
    const config = tempConfig();
    const first = m.claim(config, 'swarm-fix-login');
    assert.ok(fs.statSync(first.dir).isDirectory());
    assert.throws(() => m.claim(config, 'swarm-fix-login'), /swarm-fix-login is taken by another swarm; run start again with --name/);
    fs.mkdirSync(`${config}/tasks/swarm-mine`, { recursive: true });
    assert.throws(() => m.claim(config, 'swarm-mine'), /taken by a task list/);
    assert.throws(() => m.claim(config, 'swarm-grouped', [{ name: 'swarm-grouped' }]), /taken by a group/);
    assert.deepEqual(fs.readdirSync(`${config}/.cck/swarm`), ['swarm-fix-login']);
  });

  it('gives one of two starts at the same moment the name', async () => {
    const config = tempConfig();
    const src = `import(${JSON.stringify(pathToFileURL(START).href)}).then((m) => m.claim(${JSON.stringify(config)}, 'swarm-same'))`;
    const run = () => new Promise((resolve) => {
      execFile(process.execPath, ['--input-type=module', '-e', src], (err) => resolve(!err));
    });
    const won = await Promise.all(Array.from({ length: 6 }, run));
    assert.equal(won.filter(Boolean).length, 1);
  });

  it('names workers adjective-scientist, distinct and free', async () => {
    const { workerNames } = await import(pathToFileURL(path.join(path.dirname(START), 'names.mjs')).href);
    const names = workerNames(4);
    assert.equal(new Set(names).size, 4);
    for (const n of names) assert.match(n, /^[a-z]+-[a-z]+$/);
    const picks = [0, 0, 1, 0, 1, 0, 0, 1];
    assert.deepEqual(workerNames(2, new Set(['bold-babbage']), () => picks.shift()), ['brave-babbage', 'bold-bohr']);
  });

  it('maps the supervisor to the new list only', () => {
    const config = tempConfig();
    const maps = `${config}/.cck/agent-activity/_task-maps`;
    const read = (list) => JSON.parse(fs.readFileSync(`${maps}/${list}.json`, 'utf8'));
    m.mapSupervisor(config, 'swarm-a', 'sup', 'C:/p');
    fs.writeFileSync(`${maps}/swarm-b.json`, JSON.stringify({ w1: { project: 'C:/p' } }));
    m.mapSupervisor(config, 'swarm-b', 'sup', 'C:/p');
    assert.equal(fs.existsSync(`${maps}/swarm-a.json`), false);
    assert.deepEqual(Object.keys(read('swarm-b')), ['w1', 'sup']);
    m.mapSupervisor(config, 'swarm-c', 'sup', 'C:/p');
    assert.deepEqual(Object.keys(read('swarm-b')), ['w1']);
    assert.equal(read('swarm-c').sup.project, 'C:/p');
  });

  it('removes swarm folders not written for cleanupPeriodDays', () => {
    const config = tempConfig();
    fs.writeFileSync(`${config}/settings.json`, JSON.stringify({ cleanupPeriodDays: 2 }));
    const old = m.claim(config, 'old').dir;
    const fresh = m.claim(config, 'fresh').dir;
    fs.writeFileSync(`${old}/swarm.json`, '{}');
    const past = new Date(Date.now() - 3 * 86_400_000);
    for (const p of [`${old}/swarm.json`, old]) fs.utimesSync(p, past, past);
    assert.deepEqual(m.prune(config), [path.basename(old)]);
    assert.deepEqual([fs.existsSync(old), fs.existsSync(fresh)], [false, true]);
  });

  it('nests the swarm group under the user group that holds the parent', () => {
    const groups = [
      { id: 'g1', name: 'work', parent: null, members: [] },
      { id: 'g2', name: 'auth', parent: 'g1', members: [{ type: 'session', ref: 'sid-p' }] },
      { id: 'dispatch:x', name: 'x', dispatch: true, members: [{ type: 'session', ref: 'sid-q' }] },
    ];
    assert.equal(m.groupPath(groups, 'sid-p'), 'work/auth');
    assert.equal(m.groupPath(groups, 'sid-q'), '');
  });

  it('gives each worker its name, its peers, the spec, its part in the first split and the swarm policy', () => {
    const names = ['w1-abc', 'w2-abc'];
    const first = m.workerSpec({ spec: 'Ship it\n', name: 'w1-abc', listId: 'swarm-ship-it-abc', names, transcript: 'C:/cfg/projects/p/sid.jsonl' });
    assert.match(first, /Peers: w2-abc\./);
    assert.match(first, /## Request \(revision 1\)\n\nShip it\n/);
    assert.match(first, /you make the first split/);
    assert.match(first, /conversation with the user: C:\/cfg\/projects\/p\/sid\.jsonl\./);
    assert.match(first, /declare swarm_complete\(waiting\) with the named dependency/);
    assert.doesNotMatch(first, /delm_|DeLM|SendMessage/);
    const second = m.workerSpec({ spec: 'Ship it', name: 'w2-abc', listId: 'swarm-ship-it-abc', names, transcript: null });
    assert.match(second, /w1-abc makes the first split/);
    assert.doesNotMatch(second, /conversation with the user/);
  });

  it('passes the claude args after -- to each worker', () => {
    const at = { cwd: 'C:/p', specFile: 's.md', name: 'w1-abc', listId: 'swarm-x-abc' };
    assert.equal(m.dispatchArgs(at).includes('--'), false);
    assert.deepEqual(m.dispatchArgs({ ...at, claudeArgs: ['--plugin-dir', 'C:/plug'] }).slice(-3), ['--', '--plugin-dir', 'C:/plug']);
    assert.deepEqual(m.dispatchArgs({ ...at, model: 'haiku' }).slice(-2), ['--model', 'haiku']);
    assert.equal(m.dispatchArgs(at).includes('--model'), false);
  });

  it('refuses a start with no spec, outside a session or outside a repository before it claims anything', () => {
    const config = tempConfig();
    const env = { CLAUDE_CONFIG_DIR: config };
    const spec = 'Ship it';
    assert.throws(() => m.start({ goal: 'g', env }), /--spec-file/);
    assert.throws(() => m.start({ goal: 'g', spec: ' \n', env }), /--spec-file/);
    assert.throws(() => m.start({ goal: 'g', spec, env }), /from a Claude Code session/);
    assert.throws(() => m.start({ goal: 'g', spec, n: 5, env }), /--n must be 2 to 4/);
    assert.throws(() => m.start({ goal: 'g', spec, n: 1, env }), /--n must be 2 to 4/);
    assert.throws(() => m.start({ goal: 'g', spec, cwd: config, env: { ...env, CLAUDE_CODE_SESSION_ID: 'sid' } }), /not a git repository/);
    assert.equal(fs.existsSync(`${config}/.cck/swarm`), false);
  });

  it('refuses a start with the install command when the cck CLI does not run, before it claims anything', () => {
    const config = tempConfig();
    const repo = tempConfig();
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base']);
    const saved = process.env.CCK_CLI;
    process.env.CCK_CLI = `${config}/missing/server.js`;
    try {
      assert.throws(
        () => m.start({ goal: 'g', spec: 'Ship it', cwd: repo, env: { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: 'sid' } }),
        /needs the claude-code-kanban CLI: install it with `npm install -g claude-code-kanban`/,
      );
    } finally {
      if (saved === undefined) delete process.env.CCK_CLI;
      else process.env.CCK_CLI = saved;
    }
    assert.equal(fs.existsSync(`${config}/.cck/swarm`), false);
  });
});

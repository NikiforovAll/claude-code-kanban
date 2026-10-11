const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const START = path.join(__dirname, '..', 'plugin', 'plugins', 'kanban-delm-swarm', 'scripts', 'start.mjs');

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

  it('takes a new suffix when the folder or the task list is taken', () => {
    const config = tempConfig();
    const suffixes = ['aaaaaa', 'aaaaaa', 'bbbbbb', 'cccccc'];
    const next = () => suffixes.shift();
    assert.equal(m.claim(config, 'Fix login', next).listId, 'swarm-fix-login-aaaaaa');
    fs.mkdirSync(`${config}/tasks/swarm-fix-login-bbbbbb`, { recursive: true });
    const second = m.claim(config, 'Fix login', next);
    assert.deepEqual([second.listId, second.suffix], ['swarm-fix-login-cccccc', 'cccccc']);
    assert.ok(fs.statSync(second.dir).isDirectory());
  });

  it('gives two starts at the same moment two folders', async () => {
    const config = tempConfig();
    const src = `import(${JSON.stringify(pathToFileURL(START).href)}).then((m) => console.log(m.claim(${JSON.stringify(config)}, 'same goal').listId))`;
    const run = () => new Promise((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', src], (err, out) => (err ? reject(err) : resolve(out.trim())));
    });
    const ids = await Promise.all(Array.from({ length: 6 }, run));
    assert.equal(new Set(ids).size, 6);
    assert.equal(fs.readdirSync(`${config}/.cck/swarm`).length, 6);
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

  it('gives each worker its name, its peers and the swarm policy', () => {
    const spec = m.workerSpec({ goal: 'Ship it', name: 'w1-abc', listId: 'swarm-ship-it-abc', names: ['w1-abc', 'w2-abc'] });
    assert.match(spec, /Peers: w2-abc\./);
    assert.match(spec, /declare swarm_complete\(waiting\) with the named dependency/);
    assert.doesNotMatch(spec, /delm_|DeLM|SendMessage/);
  });

  it('refuses a start outside a session or a repository before it claims anything', () => {
    const config = tempConfig();
    const env = { CLAUDE_CONFIG_DIR: config };
    assert.throws(() => m.start({ goal: 'g', env }), /from a Claude Code session/);
    assert.throws(() => m.start({ goal: 'g', n: 5, env }), /--n must be 2 to 4/);
    assert.throws(() => m.start({ goal: 'g', n: 1, env }), /--n must be 2 to 4/);
    assert.throws(() => m.start({ goal: 'g', cwd: config, env: { ...env, CLAUDE_CODE_SESSION_ID: 'sid' } }), /not a git repository/);
    assert.equal(fs.existsSync(`${config}/.cck/swarm`), false);
  });
});

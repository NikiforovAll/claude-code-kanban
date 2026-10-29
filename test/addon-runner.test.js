const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAddonRunner, urlPort } = require('../lib/addon-runner');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cck-addon-runner-'));

describe('add-on runner', () => {
  it('reads the port of a URL, with the protocol default', () => {
    assert.deepEqual(urlPort('http://localhost:4117/?cwd=x'), { host: 'localhost', port: 4117 });
    assert.deepEqual(urlPort('http://127.0.0.1/'), { host: '127.0.0.1', port: 80 });
    assert.deepEqual(urlPort('http://[::1]:5000/'), { host: '::1', port: 5000 });
  });

  it('starts nothing for an entry with no run, or when the port answers', async () => {
    const logDir = tmpDir();
    const runner = createAddonRunner({ logDir, probe: async () => true });
    assert.deepEqual(await runner.ensure({ id: 'a1', url: 'http://localhost:4117/' }), { state: 'none' });
    assert.deepEqual(await runner.ensure({ id: 'a1', url: 'http://localhost:4117/', run: 'node -e "process.exit(1)"' }), { state: 'up' });
    assert.equal(fs.existsSync(path.join(logDir, 'a1.log')), false);
  });

  it('runs the command with PORT set and is up once the port answers', async () => {
    const logDir = tmpDir();
    let up = false;
    const runner = createAddonRunner({ logDir, probe: async () => up });
    const entry = {
      id: 'a2',
      url: 'http://localhost:4118/{cwd}',
      run: `node -e "console.log('port ' + process.env.PORT); setInterval(() => {}, 1000)"`,
    };
    const pending = runner.ensure(entry);
    const second = runner.ensure(entry);
    setTimeout(() => {
      up = true;
    }, 400);
    assert.deepEqual(await pending, { state: 'up' });
    assert.deepEqual(await second, { state: 'up' });
    runner.shutdown();
    assert.match(fs.readFileSync(path.join(logDir, 'a2.log'), 'utf8'), /port 4118/);
    runner.stop('a2');
    assert.equal(fs.existsSync(path.join(logDir, 'a2.log')), false);
  });

  it('restarts its own server and leaves one it did not start', async () => {
    const logDir = tmpDir();
    const runner = createAddonRunner({ logDir });
    const entry = {
      id: 'a4',
      url: 'http://127.0.0.1:4121/',
      run: `node -e "console.log(process.pid); require('net').createServer().listen(+process.env.PORT, '127.0.0.1')"`,
    };
    const pid = () => fs.readFileSync(path.join(logDir, 'a4.log'), 'utf8').trim();
    try {
      assert.equal(await runner.status(entry), 'stopped');
      assert.deepEqual(await runner.ensure(entry), { state: 'up' });
      assert.equal(await runner.status(entry), 'running');
      const first = pid();
      assert.deepEqual(await runner.restart(entry), { state: 'up' });
      assert.notEqual(pid(), first);
      const other = createAddonRunner({ logDir: tmpDir() });
      assert.equal(await other.status(entry), 'external');
      assert.equal((await other.restart(entry)).state, 'external');
    } finally {
      runner.shutdown();
    }
  });

  it('keeps a server whose entry is the same, and stops it once the entry changes or goes', async () => {
    const runner = createAddonRunner({ logDir: tmpDir() });
    const entry = {
      id: 'a5',
      url: 'http://127.0.0.1:4122/',
      run: `node -e "require('net').createServer().listen(+process.env.PORT, '127.0.0.1')"`,
    };
    const gone = async () => {
      for (let i = 0; i < 30 && (await runner.status(entry)) !== 'stopped'; i++) await new Promise((r) => setTimeout(r, 100));
      return runner.status(entry);
    };
    try {
      assert.deepEqual(await runner.ensure(entry), { state: 'up' });
      runner.retain([{ ...entry, title: 'Renamed' }]);
      assert.equal(await runner.status(entry), 'running');
      runner.retain([{ ...entry, cwd: os.tmpdir() }]);
      assert.equal(await gone(), 'stopped');
      assert.deepEqual(await runner.ensure(entry), { state: 'up' });
      runner.retain([]);
      assert.equal(await gone(), 'stopped');
    } finally {
      runner.shutdown();
    }
  });

  it('fails with the exit code and the log when the command exits, and stops after 3 starts a minute', async () => {
    const logDir = tmpDir();
    const runner = createAddonRunner({ logDir, probe: async () => false });
    const entry = { id: 'a3', url: 'http://localhost:4119/', run: 'node -e "process.exit(3)"' };
    const r = await runner.ensure(entry);
    assert.equal(r.state, 'failed');
    assert.match(r.error, /code 3/);
    assert.equal(r.log, path.join(logDir, 'a3.log'));
    await runner.ensure(entry);
    await runner.ensure(entry);
    assert.match((await runner.ensure(entry)).error, /3 times in a minute/);
  });
});

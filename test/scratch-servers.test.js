const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createScratchServers } = require('../lib/scratch-servers');

// A fake `scratch ui --json`: prints its ready line on the next tick, answers health while alive.
function fakeScratch() {
  const procs = [];
  let nextPort = 5000;
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.unref = () => {};
    child.args = args;
    child.port = nextPort++;
    child.pid = 100 + procs.length;
    child.alive = true;
    child.kill = () => {
      if (!child.alive) return;
      child.alive = false;
      setImmediate(() => child.emit('exit', null));
    };
    const pad = `${args[3]}/${args[1]}`.replace(/\\/g, '/');
    child.pad = pad;
    procs.push(child);
    setImmediate(() => {
      const ready = { url: `http://127.0.0.1:${child.port}/?t=tok${child.pid}`, port: child.port, token: `tok${child.pid}`, pid: child.pid, pads: [pad] };
      child.stdout.write(`${JSON.stringify(ready)}\n`);
    });
    return child;
  };
  const fetch = async (url) => {
    const port = Number(new URL(url).port);
    const child = procs.find((c) => c.port === port && c.alive);
    if (!child) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ pid: child.pid, pads: [child.pad] }) };
  };
  return { procs, spawn, fetch };
}

const PAD = 'C:/pads/notes';

describe('scratch servers', () => {
  it('starts one viewer per pad and reuses it while it answers', async () => {
    const f = fakeScratch();
    const s = createScratchServers({ resolveBin: () => 'scratch.exe', spawn: f.spawn, fetch: f.fetch });
    const url = await s.serve(PAD);
    assert.equal(url, 'http://127.0.0.1:5000/?t=tok100');
    assert.deepEqual(f.procs[0].args, ['ui', 'notes', '--dir', 'C:/pads', '--json']);
    assert.equal(await s.serve('c:\\pads\\notes'), url);
    assert.equal(f.procs.length, 1);
  });

  it('spawns once for concurrent calls on the same pad', async () => {
    const f = fakeScratch();
    const s = createScratchServers({ resolveBin: () => 'scratch.exe', spawn: f.spawn, fetch: f.fetch });
    const [a, b] = await Promise.all([s.serve(PAD), s.serve(PAD)]);
    assert.equal(a, b);
    assert.equal(f.procs.length, 1);
  });

  it('reports an external kill and starts a new viewer on the next call', async () => {
    const f = fakeScratch();
    const exited = [];
    const s = createScratchServers({ resolveBin: () => 'scratch.exe', spawn: f.spawn, fetch: f.fetch, onExit: (p) => exited.push(p) });
    await s.serve(PAD);
    f.procs[0].kill();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(exited, ['c:/pads/notes']);
    assert.equal(s.size(), 0);
    assert.equal(await s.serve(PAD), 'http://127.0.0.1:5001/?t=tok101');
  });

  it('replaces a viewer that stops answering for its pad', async () => {
    const f = fakeScratch();
    const s = createScratchServers({ resolveBin: () => 'scratch.exe', spawn: f.spawn, fetch: f.fetch });
    await s.serve(PAD);
    f.procs[0].pad = 'C:/elsewhere';
    assert.equal(await s.serve(PAD), 'http://127.0.0.1:5001/?t=tok101');
    assert.equal(f.procs[0].alive, false);
  });

  it('stops the least recently used viewer past the limit', async () => {
    const f = fakeScratch();
    const s = createScratchServers({ resolveBin: () => 'scratch.exe', spawn: f.spawn, fetch: f.fetch, max: 2 });
    await s.serve('C:/pads/a');
    await s.serve('C:/pads/b');
    await s.serve('C:/pads/a');
    await s.serve('C:/pads/c');
    assert.deepEqual(
      f.procs.map((c) => c.alive),
      [true, false, true],
    );
  });

  it('fails with 501 when scratch cannot be launched, and with the reason when it exits before ready', async () => {
    const none = createScratchServers({ resolveBin: () => null, spawn: () => assert.fail('spawned'), fetch: async () => {} });
    await assert.rejects(none.serve(PAD), (e) => e.status === 501);
    const dying = createScratchServers({
      resolveBin: () => 'scratch.exe',
      fetch: async () => {},
      spawn: () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.unref = () => {};
        child.kill = () => {};
        setImmediate(() => {
          child.stderr.write('error: no pad "notes"\n');
          setImmediate(() => child.emit('exit', 1));
        });
        return child;
      },
    });
    await assert.rejects(dying.serve(PAD), /exited \(1\): error: no pad "notes"/);
  });
});

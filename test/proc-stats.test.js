const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createProcStats, parseWindows, parsePs, parseCpuTime } = require('../lib/proc-stats');

describe('proc-stats', () => {
  it('parses Get-Process lines', () => {
    const m = parseWindows('123 104857600 2500\r\n456 2048 0\r\n\r\n');
    assert.deepEqual(m.get(123), { rss: 104857600, cpuMs: 2500 });
    assert.deepEqual(m.get(456), { rss: 2048, cpuMs: 0 });
  });

  it('parses ps lines from Linux and macOS', () => {
    const m = parsePs('  123 102400 01:02:03\n  456  2048 1-00:00:01\n  789 512 0:01.50\n');
    assert.deepEqual(m.get(123), { rss: 104857600, cpuMs: 3723000 });
    assert.equal(m.get(456).cpuMs, 86401000);
    assert.equal(m.get(789).cpuMs, 1500);
  });

  it('reads cumulative CPU time formats', () => {
    assert.equal(parseCpuTime('00:00:00'), 0);
    assert.equal(parseCpuTime('2:03.25'), 123250);
  });

  it('gives CPU from the second sample as a percent of one core', async () => {
    let t = 0;
    let cpuMs = 1000;
    const stats = createProcStats({
      now: () => t,
      run: async () => new Map([[42, { rss: 1024, cpuMs }]]),
    });
    assert.deepEqual(await stats([42]), { 42: { rss: 1024, cpu: null } });
    t = 5000;
    cpuMs = 3500;
    assert.deepEqual(await stats([42]), { 42: { rss: 1024, cpu: 50 } });
  });

  it('drops a CPU baseline that is too old to be representative', async () => {
    let t = 0;
    const stats = createProcStats({ now: () => t, run: async () => new Map([[7, { rss: 1, cpuMs: t }]]) });
    await stats([7]);
    t = 60000;
    assert.equal((await stats([7]))[7].cpu, null);
  });

  it('leaves out a pid that is gone and skips the call with no pids', async () => {
    let calls = 0;
    const stats = createProcStats({ run: async () => { calls++; return new Map(); } });
    assert.deepEqual(await stats([1, 2]), {});
    assert.deepEqual(await stats([]), {});
    assert.equal(calls, 1);
  });

  it('shares one call between overlapping asks', async () => {
    let calls = 0;
    const stats = createProcStats({ run: async () => { calls++; return new Map([[3, { rss: 1, cpuMs: 0 }]]); } });
    await Promise.all([stats([3]), stats([3])]);
    assert.equal(calls, 1);
  });

  it(`queries this process on ${process.platform}`, async () => {
    const stats = createProcStats();
    const r = await stats([process.pid]);
    assert.ok(r[process.pid].rss > 0);
  });
});

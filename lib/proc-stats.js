'use strict';

// Memory and CPU of a few processes in one OS call. Only the processes named: a process-tree walk
// costs more than the number is worth. CPU is the change in cumulative CPU time since the last
// call, so the first call for a pid has none.
const { execFile } = require('node:child_process');

const QUERY_TIMEOUT_MS = 10000;
// An older sample would turn the CPU number into an average over minutes.
const MAX_BASELINE_MS = 30000;

function parseCpuTime(text) {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  const seconds = clock.split(':').reduce((acc, part) => acc * 60 + Number.parseFloat(part), 0);
  return (Number(days) * 86400 + seconds) * 1000;
}

// Lines of "pid workingSetBytes cpuMs".
function parseWindows(stdout) {
  const out = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, rss, cpuMs] = line.trim().split(/\s+/).map(Number);
    if (pid && Number.isFinite(rss) && Number.isFinite(cpuMs)) out.set(pid, { rss, cpuMs });
  }
  return out;
}

// Lines of `ps -o pid=,rss=,time=`: rss in KiB, time as [dd-]hh:mm:ss on Linux or mm:ss.ss on macOS.
function parsePs(stdout) {
  const out = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, rss, time] = line.trim().split(/\s+/);
    if (!time) continue;
    const cpuMs = parseCpuTime(time);
    if (Number(pid) && Number.isFinite(cpuMs)) out.set(Number(pid), { rss: Number(rss) * 1024, cpuMs });
  }
  return out;
}

function query(pids, platform = process.platform) {
  return new Promise((resolve) => {
    const ids = pids.join(',');
    const [file, args, parse] = platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.WorkingSet64) $([long]$_.TotalProcessorTime.TotalMilliseconds)" }`], parseWindows]
      : ['ps', ['-o', 'pid=,rss=,time=', '-p', ids], parsePs];
    // ps exits 1 when a pid is gone, and still prints the others.
    execFile(file, args, { windowsHide: true, timeout: QUERY_TIMEOUT_MS }, (_err, stdout) => resolve(parse(stdout || '')));
  });
}

function createProcStats({ run = query, now = Date.now } = {}) {
  let last = new Map();
  let inFlight = null;

  async function sample(pids) {
    const at = now();
    const found = await run(pids);
    const next = new Map();
    const result = {};
    for (const pid of pids) {
      const cur = found.get(pid);
      if (!cur) continue;
      const prev = last.get(pid);
      const fresh = prev && at - prev.at <= MAX_BASELINE_MS && cur.cpuMs >= prev.cpuMs;
      result[pid] = { rss: cur.rss, cpu: fresh ? Math.round(((cur.cpuMs - prev.cpuMs) / (at - prev.at)) * 100) : null };
      next.set(pid, { at, cpuMs: cur.cpuMs });
    }
    last = next;
    return result;
  }

  // Asks that overlap share one OS call.
  return function stats(pids) {
    const valid = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
    if (!valid.length) return Promise.resolve({});
    inFlight ??= sample(valid).finally(() => { inFlight = null; });
    return inFlight;
  };
}

module.exports = { createProcStats, parseWindows, parsePs, parseCpuTime };

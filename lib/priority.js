'use strict';

// Windows boosts the threads of the foreground window, and a process behind a hidden ConPTY never
// gets that, so the one the user types into competes on equal terms with every busy agent.
// Elsewhere a raise needs root, and a raised nice value would pass on to every child, so this is
// Windows only. There a child of an above-normal process starts at normal, so the tools it runs
// stay unboosted.
const { execFile } = require('node:child_process');
const os = require('node:os');

const { PRIORITY_ABOVE_NORMAL } = os.constants.priority;

function enabled(platform, env) {
  return platform === 'win32' && env.CCK_PRIORITY_BOOST !== '0';
}

function raise(pid = 0, platform = process.platform, env = process.env) {
  if (!enabled(platform, env)) return null;
  try {
    const before = os.getPriority(pid);
    if (before <= PRIORITY_ABOVE_NORMAL) return null;
    os.setPriority(pid, PRIORITY_ABOVE_NORMAL);
    return before;
  } catch {
    return null;
  }
}

function restore(pid, before) {
  try { os.setPriority(pid, before); } catch { /* the process is gone */ }
}

// ConPTY's console host relays every byte between cck and the shell, and node-pty does not expose
// its pid. Under load a normal-priority host starves for seconds, until Windows' anti-starvation
// boost picks it up.
function raiseConsoleHosts(done) {
  if (!enabled(process.platform, process.env)) return done?.();
  const query = `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND (Name='conhost.exe' OR Name='OpenConsole.exe')").ProcessId`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true, timeout: 30000 }, (err, stdout) => {
    if (!err) for (const pid of stdout.split(/\s+/).filter(Boolean)) raise(Number(pid));
    done?.();
  });
}

module.exports = { raise, restore, raiseConsoleHosts };

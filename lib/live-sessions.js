'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Claude Code's live-session registry: one <pid>.json per interactive claude.
function readLiveSessions(sessionsDir) {
  const sessions = [];
  let files;
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return sessions;
  }
  for (const file of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
      if (s?.sessionId && s.kind === 'interactive') {
        sessions.push({ sessionId: s.sessionId, pid: s.pid || null, cwd: s.cwd || null, startedAt: s.startedAt || 0, status: s.status || null, name: s.name || null });
      }
    } catch { /* skip invalid */ }
  }
  return sessions;
}

// EPERM means the process exists but belongs to someone else.
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// A registry file outlives a crashed claude, so the pid is probed rather than trusted.
function isSessionLive(sessions, sessionId, exceptPid = null) {
  return sessions.some((s) => {
    if (s.sessionId !== sessionId || !s.pid || s.pid === exceptPid) return false;
    return isPidAlive(s.pid);
  });
}

module.exports = { readLiveSessions, isPidAlive, isSessionLive };

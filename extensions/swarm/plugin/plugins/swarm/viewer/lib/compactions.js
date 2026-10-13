'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Claude Code writes this line into the transcript each time it compacts the session.
const MARK = '"subtype":"compact_boundary"';
// A compaction takes minutes, so a count up to this old is fine, and the model rebuilds often.
const CHECK_MS = 30_000;
// A transcript not found yet is searched for less and less often, as the search reads every project dir.
const MAX_MISS_MS = 10 * 60_000;
const FORGET_MS = 60 * 60_000;
const CHUNK = 1 << 20;

// Counts each worker's compactions from its transcript, reading only the bytes added since the last check.
function compactionCounter(config, { checkMs = CHECK_MS, now = Date.now } = {}) {
  const projects = path.join(config, 'projects');
  const seen = new Map();
  const buf = Buffer.alloc(CHUNK);

  const locate = (sessionId) => {
    let dirs;
    try {
      dirs = fs.readdirSync(projects);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const file = path.join(projects, d, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  };

  // Reads whole lines only, so a mark is never split; a line longer than a chunk holds no mark.
  const scan = (s) => {
    let fd;
    try {
      fd = fs.openSync(s.file, 'r');
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < s.offset) Object.assign(s, { offset: 0, count: 0 });
      while (s.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - s.offset), s.offset);
        const end = buf.lastIndexOf(10, n - 1) + 1;
        if (end === 0) {
          if (n < CHUNK) break;
          s.offset += n - MARK.length;
          continue;
        }
        s.count += buf.toString('utf8', 0, end).split(MARK).length - 1;
        s.offset += end;
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  const count = (sessionId, t) => {
    let s = seen.get(sessionId);
    if (s && t < s.next) return s.file ? s.count : null;
    s ??= { file: null, offset: 0, count: 0, miss: checkMs };
    seen.set(sessionId, s);
    s.checked = t;
    s.file ??= locate(sessionId);
    if (!s.file) {
      s.next = t + s.miss;
      s.miss = Math.min(s.miss * 2, MAX_MISS_MS);
      return null;
    }
    s.next = t + checkMs;
    scan(s);
    return s.count;
  };

  return (workers = []) => {
    const t = now();
    for (const [id, s] of seen) if (t - s.checked > FORGET_MS) seen.delete(id);
    const out = new Map();
    for (const w of workers) if (w.sessionId) out.set(w.name, count(w.sessionId, t));
    return out;
  };
}

module.exports = { compactionCounter };

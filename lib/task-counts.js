const fs = require('fs');
const path = require('path');

// A task file's status is reused while its size, mtime and inode are unchanged. An mtime can be
// as coarse as 2 s (FAT), so a file read within that window of its last write could be written
// again with the same stamp and size. Such a file is not stored and is read again next time.
const RACY_MS = 3000;
const SKIP = 'skip';
const STATUSES = new Set(['completed', 'in_progress', 'pending', SKIP]);

const dirs = new Map();
let dirty = false;

function readStatus(taskPath) {
  const text = fs.readFileSync(taskPath, 'utf8');
  let task;
  try {
    task = JSON.parse(text);
  } catch (_) {
    return SKIP;
  }
  if (task == null || task.metadata?._internal) return SKIP;
  if (task.status === 'completed' || task.status === 'in_progress') return task.status;
  return 'pending';
}

function countTaskDir(dir) {
  const prev = dirs.get(dir);
  const next = new Map();
  const now = Date.now();
  const tally = { completed: 0, in_progress: 0, pending: 0 };
  let newestTaskMtime = null;

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const taskPath = path.join(dir, file);
    let st;
    try {
      st = fs.statSync(taskPath);
    } catch (_) {
      continue;
    }
    const e = prev?.get(file);
    let status;
    if (e && e.size === st.size && e.mtimeMs === st.mtimeMs && e.ino === st.ino) {
      status = e.status;
      next.set(file, e);
    } else {
      try {
        status = readStatus(taskPath);
      } catch (_) {
        continue;
      }
      if (now - st.mtimeMs >= RACY_MS) {
        next.set(file, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, status });
        dirty = true;
      }
    }
    if (status === SKIP) continue;
    tally[status]++;
    if (!newestTaskMtime || st.mtime > newestTaskMtime) newestTaskMtime = st.mtime;
  }

  if (prev && prev.size !== next.size) dirty = true;
  dirs.set(dir, next);
  return { completed: tally.completed, inProgress: tally.in_progress, pending: tally.pending, newestTaskMtime };
}

const taskCountsDirty = () => dirty;

function exportTaskCounts() {
  dirty = false;
  return [...dirs].filter(([dir]) => fs.existsSync(dir)).map(([dir, files]) => [dir, [...files]]);
}

function importTaskCounts(entries) {
  if (!Array.isArray(entries)) return;
  const num = (x) => typeof x === 'number';
  for (const pair of entries) {
    if (typeof pair?.[0] !== 'string' || !Array.isArray(pair[1])) continue;
    const files = new Map();
    for (const item of pair[1]) {
      const [file, e] = Array.isArray(item) ? item : [];
      if (typeof file !== 'string' || !e || !num(e.size) || !num(e.mtimeMs) || !num(e.ino) || !STATUSES.has(e.status)) continue;
      files.set(file, e);
    }
    dirs.set(pair[0], files);
  }
}

module.exports = { countTaskDir, taskCountsDirty, exportTaskCounts, importTaskCounts };

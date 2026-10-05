// Which project paths are linked worktrees, and of which repo. The rule and the sweep:
// docs/retention.md.

const fs = require('node:fs');
const path = require('node:path');
const { GRACE_MS } = require('./retention');
const { encodeProjectDirName } = require('./claude-dir');

// A linked worktree's `.git` is a file holding `gitdir: <main>/.git/worktrees/<name>`, so the
// main checkout is readable without spawning git. Path shape alone would not do: only some
// worktrees live under `<repo>/.claude/worktrees/`, the rest sit beside the repo.
const GITDIR_WORKTREE_RE = /^gitdir:\s*(.*)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)[/\\]?$/;
// A submodule's worktree points into the superproject: `<super>/.git/modules/<sub>/worktrees/<name>`,
// nested as `<a>/modules/<b>`. The checkout is taken to sit at `<super>/<sub>`, which holds while
// the submodule's name is its path, the git default; reading `core.worktree` would cost a read.
const GITDIR_SUBMODULE_WORKTREE_RE =
  /^gitdir:\s*(.*)[/\\]\.git[/\\]modules[/\\](.+?)[/\\]worktrees[/\\]([^/\\]+)[/\\]?$/;
// Where `claude -w` puts a worktree. Used only once the `.git` file is gone, because Claude
// Code removes worktrees while their transcripts stay.
const CLAUDE_WORKTREE_RE = /^(.*)[/\\]\.claude[/\\]worktrees[/\\]([^/\\]+)[/\\]?$/;
const MISS_CACHE_MAX = 500;

function readGitFile(dir) {
  return fs.readFileSync(path.join(dir, '.git'), 'utf8');
}

function fromGitFile(dir, text) {
  const pointer = text.trim();
  const m = GITDIR_WORKTREE_RE.exec(pointer);
  // Git writes the pointer with forward slashes on Windows; the project path uses the OS spelling.
  if (m) return { repo: path.resolve(dir, m[1]), name: m[2] };
  const sub = GITDIR_SUBMODULE_WORKTREE_RE.exec(pointer);
  if (!sub) return null;
  return { repo: path.resolve(dir, sub[1], ...sub[2].split(/[/\\]modules[/\\]/)), name: sub[3] };
}

function fromPathShape(dir) {
  const m = CLAUDE_WORKTREE_RE.exec(dir);
  return m ? { repo: m[1], name: m[2] } : null;
}

/**
 * Hits are saved, so a worktree keeps its repo after Claude Code deletes the checkout. Misses
 * stay in memory: an ordinary checkout cannot become a linked worktree without being recreated.
 * @param {object} o
 * @param {() => object|null} o.load returns `{version: 1, worktrees: {[dir]: {repo, name, at}}}` or null
 * @param {(data: object) => void} o.save
 * @param {(fn: () => void) => void} [o.defer] when to save; one session list can resolve many new worktrees
 */
function createWorktreeStore({ load, save, read = readGitFile, now = Date.now, defer = setImmediate }) {
  const hits = new Map();
  const misses = new Set();
  const saved = load()?.worktrees;
  if (saved && typeof saved === 'object') {
    for (const [dir, e] of Object.entries(saved)) {
      if (e && typeof e.repo === 'string' && typeof e.name === 'string' && Number.isFinite(e.at)) hits.set(dir, e);
    }
  }

  let pending = false;
  function persist() {
    if (pending) return;
    pending = true;
    defer(() => {
      pending = false;
      save({ version: 1, worktrees: Object.fromEntries(hits) });
    });
  }

  function resolve(dir) {
    if (!dir) return null;
    const hit = hits.get(dir);
    if (hit) return { repo: hit.repo, name: hit.name };
    if (misses.has(dir)) return null;

    let worktree = null;
    try {
      worktree = fromGitFile(dir, read(dir));
    } catch (e) {
      // An ordinary checkout's `.git` is a directory, so the read throws EISDIR. That is the
      // answer, and it costs one syscall instead of a stat followed by a read.
      if (e.code === 'ENOENT') worktree = fromPathShape(dir);
    }

    if (!worktree) {
      misses.add(dir);
      if (misses.size > MISS_CACHE_MAX) misses.delete(misses.values().next().value);
      return null;
    }
    hits.set(dir, { ...worktree, at: now() });
    persist();
    return worktree;
  }

  // `knownDirs` holds the project dir names that still have a transcript, or null when the scan
  // found none, so a failed scan never drops every entry. Returns how many entries went.
  function prune(knownDirs) {
    if (!knownDirs) return 0;
    const t = now();
    let removed = 0;
    for (const [dir, e] of hits) {
      if (t - e.at >= GRACE_MS && !knownDirs.has(encodeProjectDirName(dir))) {
        hits.delete(dir);
        removed++;
      }
    }
    if (removed) persist();
    return removed;
  }

  return { resolve, prune };
}

module.exports = { createWorktreeStore };

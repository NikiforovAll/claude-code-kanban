// Where the harness puts a session's scratchpad. The rule and its probes: docs/session-scanning.md.

const path = require('node:path');
const { existsSync, opendirSync } = require('node:fs');
const { encodeProjectDirName } = require('./claude-dir');

// Claude Code's rule, from code.claude.com/docs/en/env-vars (CLAUDE_CODE_TMPDIR) and its 2.1.294
// macOS, Linux and Windows builds. `overrides` are
// candidate CLAUDE_CODE_TMPDIR values, first wins; a relative one is skipped.
function scratchpadRoot({ platform, overrides, tmpdir, uid }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const base = overrides.find((v) => typeof v === 'string' && p.isAbsolute(v)) || (platform === 'darwin' ? '/tmp' : tmpdir);
  return p.join(base, platform === 'win32' || uid == null ? 'claude' : `claude-${uid}`);
}

function isEmptyDir(dir) {
  let handle;
  try {
    handle = opendirSync(dir);
    return handle.readSync() === null;
  } catch {
    return true;
  } finally {
    handle?.closeSync();
  }
}

function createScratchpadDirResolver({ root, resolveWorktree, toLong = (p) => p, exists = existsSync, isEmpty = isEmptyDir }) {
  // A by-project dir that holds an entry always wins, so that answer is kept and never probed again.
  const settled = new Map();
  // Long form per root, not per session: the recorded dir is <root>/<project>/<id>/scratchpad.
  const longRoots = new Map();

  return function getScratchpadDir(id, meta) {
    const recorded = meta.scratchpadDir;
    if (recorded) {
      const root = path.dirname(path.dirname(path.dirname(recorded)));
      if (!longRoots.has(root)) longRoots.set(root, toLong(root));
      return longRoots.get(root) + recorded.slice(root.length);
    }
    if (!meta.jsonlPath) return null;
    const byProject = path.join(root, path.basename(path.dirname(meta.jsonlPath)), id, 'scratchpad');
    if (settled.get(id) === byProject) return byProject;

    // Claude Code keys the scratchpad on the process's original cwd, while entering a worktree
    // moves the transcript under the worktree.
    const wt = resolveWorktree(meta.project);
    const launch = wt ? wt.repo : meta.project;
    if (!launch) return byProject;
    const byLaunch = path.join(root, encodeProjectDirName(launch), id, 'scratchpad');
    if (byLaunch === byProject || !exists(byLaunch)) return byProject;
    if (isEmpty(byProject)) return byLaunch;
    settled.set(id, byProject);
    return byProject;
  };
}

module.exports = { createScratchpadDirResolver, scratchpadRoot };

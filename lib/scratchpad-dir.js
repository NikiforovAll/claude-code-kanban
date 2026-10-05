// Where the harness puts a session's scratchpad. The rule and its probes: docs/session-scanning.md.

const path = require('node:path');
const { existsSync, opendirSync } = require('node:fs');
const { encodeProjectDirName } = require('./claude-dir');

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

function createScratchpadDirResolver({ root, resolveWorktree, exists = existsSync, isEmpty = isEmptyDir }) {
  // A by-project dir that holds an entry always wins, so that answer is kept and never probed again.
  const settled = new Map();

  return function getScratchpadDir(id, meta) {
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

module.exports = { createScratchpadDirResolver };

// Read from HEAD rather than by spawning git: a sync spawn on the session-list path blocks the
// event loop for up to half a second per cwd on Windows, and terminal input waits behind it.

const fs = require('node:fs');
const path = require('node:path');

const REF_RE = /^ref:\s*refs\/heads\/(.+)$/;
const GITDIR_RE = /^gitdir:\s*(.+)$/;

// `.git` is a directory in an ordinary checkout and a `gitdir:` pointer file in a linked
// worktree or a submodule.
function headFile(dir, readFile) {
  const dotGit = path.join(dir, '.git');
  let text;
  try {
    text = readFile(dotGit);
  } catch (e) {
    if (e.code === 'EISDIR') return path.join(dotGit, 'HEAD');
    return null;
  }
  const m = GITDIR_RE.exec(text.trim());
  return m ? path.join(path.resolve(dir, m[1]), 'HEAD') : null;
}

/**
 * @param {string} cwd
 * @param {(file: string) => string} [readFile]
 * @returns {string|null} null outside a repo and on a detached HEAD
 */
function readGitBranch(cwd, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  for (let dir = path.resolve(cwd); ; ) {
    const head = headFile(dir, readFile);
    if (head) {
      try {
        const m = REF_RE.exec(readFile(head).trim());
        return m ? m[1] : null;
      } catch {
        return null;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

module.exports = { readGitBranch };

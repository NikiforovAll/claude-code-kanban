const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readGitBranch, sessionGitBranch } = require('../lib/git-branch');

const ROOT = path.resolve('/dev');
const REPO = path.join(ROOT, 'repo');

function fakeFs(files, dirs = []) {
  return (file) => {
    if (dirs.includes(file)) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    if (file in files) return files[file];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
}

describe('readGitBranch', () => {
  const repoGit = path.join(REPO, '.git');

  it('reads the branch of an ordinary checkout from a subdirectory', () => {
    const read = fakeFs({ [path.join(repoGit, 'HEAD')]: 'ref: refs/heads/feat/x\n' }, [repoGit]);
    assert.equal(readGitBranch(path.join(REPO, 'src', 'lib'), read), 'feat/x');
  });

  it('follows a relative gitdir pointer, as a submodule has', () => {
    const sub = path.join(REPO, 'cck');
    const read = fakeFs({
      [path.join(sub, '.git')]: 'gitdir: ../.git/modules/cck\n',
      [path.join(repoGit, 'modules', 'cck', 'HEAD')]: 'ref: refs/heads/main\n',
      [path.join(repoGit, 'HEAD')]: 'ref: refs/heads/master\n',
    }, [repoGit]);
    assert.equal(readGitBranch(sub, read), 'main');
  });

  it('follows an absolute gitdir pointer, as a linked worktree has', () => {
    const wt = path.join(ROOT, 'repo-wt');
    const gitdir = path.join(repoGit, 'worktrees', 'repo-wt');
    const read = fakeFs({
      [path.join(wt, '.git')]: `gitdir: ${gitdir.replaceAll('\\', '/')}`,
      [path.join(gitdir, 'HEAD')]: 'ref: refs/heads/side',
    });
    assert.equal(readGitBranch(wt, read), 'side');
  });

  it('returns null on a detached HEAD', () => {
    const read = fakeFs({ [path.join(repoGit, 'HEAD')]: '0123456789abcdef0123456789abcdef01234567\n' }, [repoGit]);
    assert.equal(readGitBranch(REPO, read), null);
  });

  it('returns null outside a repo', () => {
    assert.equal(readGitBranch(REPO, fakeFs({})), null);
  });

  it('reads this checkout like git does', () => {
    const { execFileSync } = require('node:child_process');
    let expected;
    try {
      expected = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();
    } catch {
      return;
    }
    assert.equal(readGitBranch(__dirname), expected === 'HEAD' ? null : expected);
  });
});

describe('sessionGitBranch', () => {
  const wt = path.join(REPO, '.claude', 'worktrees', 'fix-a');
  const branchAt = (cwd) => (cwd.startsWith(wt) ? 'worktree-fix-a' : 'feature');

  it('reads HEAD for a worktree session whose transcript records the main branch', () => {
    const meta = { project: wt, cwd: wt, gitBranch: 'main' };
    assert.equal(sessionGitBranch(meta, true, branchAt), 'worktree-fix-a');
  });

  it('trusts the transcript in an ordinary checkout that cwd never left', () => {
    const meta = { project: REPO, cwd: REPO, gitBranch: 'main' };
    assert.equal(sessionGitBranch(meta, false, branchAt), 'main');
  });

  it('reads HEAD when cwd left the project', () => {
    const meta = { project: REPO, cwd: path.join(ROOT, 'other'), gitBranch: 'main' };
    assert.equal(sessionGitBranch(meta, false, branchAt), 'feature');
  });

  it('falls back to the transcript when HEAD has no branch', () => {
    const meta = { project: wt, cwd: wt, gitBranch: 'main' };
    assert.equal(sessionGitBranch(meta, true, () => null), 'main');
  });
});

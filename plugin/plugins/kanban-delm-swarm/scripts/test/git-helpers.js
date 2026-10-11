const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// A git hook runs the tests with GIT_DIR and friends set, which would aim the temp repo's git calls at cck.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
const write = (root, p, data) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), data);
};

// A repo at a base commit with the seeded files and one Claude Code worktree per worker.
function repoWithWorktrees(repo, seeds, workers, { autocrlf = 'false' } = {}) {
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', autocrlf);
  for (const [p, data] of Object.entries({ '.gitignore': '.claude/\n', ...seeds })) write(repo, p, data);
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const trees = {};
  for (const name of workers) {
    const at = `${repo}/.claude/worktrees/${name}`;
    git(repo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, at, base);
    trees[name] = { path: at, branch: `worktree-${name}` };
  }
  return { base, trees };
}

module.exports = { git, write, repoWithWorktrees };

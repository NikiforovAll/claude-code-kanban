// Loaded by the page as a plain script and by server.js through require, so the sidebar and
// the API (and the CLI, which sends `project=`) filter projects by one rule.
const projectMatch = (() => {
  function normalizeProjectPath(p) {
    return p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  }
  function isExactProjectPath(normalized) {
    return /^([a-z]:)?\//.test(normalized);
  }
  function isExactProjectFilter(query) {
    return isExactProjectPath(normalizeProjectPath(query.trim()));
  }
  // An absolute path selects that one project and its linked worktrees (`repo` is the main
  // checkout of a worktree project), so the hub's scope does not also pull in `app-2` next to
  // `app`; any other text matches a part of the path.
  function projectMatcher(query) {
    const q = normalizeProjectPath(query.trim());
    const exact = isExactProjectPath(q);
    return (project, repo) => {
      if (!project) return false;
      const p = normalizeProjectPath(project);
      if (!exact) return p.includes(q);
      return p === q || (!!repo && normalizeProjectPath(repo) === q);
    };
  }
  // The project a session is listed under. A worktree transcript is filed under the worktree
  // path, so `session.project` alone would show each worktree as a project of its own.
  function sessionProjectKey(session) {
    return session?.worktree?.repo || session?.project || null;
  }
  return { normalizeProjectPath, isExactProjectPath, isExactProjectFilter, projectMatcher, sessionProjectKey };
})();

if (typeof module === 'object' && module.exports) module.exports = projectMatch;

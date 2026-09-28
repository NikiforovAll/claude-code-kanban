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
  // An absolute path selects that one project, so the hub's scope does not also pull in
  // `app-2` next to `app`; any other text matches a part of the path.
  function projectMatcher(query) {
    const q = normalizeProjectPath(query.trim());
    const exact = isExactProjectPath(q);
    return (project) => {
      if (!project) return false;
      const p = normalizeProjectPath(project);
      return exact ? p === q : p.includes(q);
    };
  }
  return { normalizeProjectPath, isExactProjectPath, isExactProjectFilter, projectMatcher };
})();

if (typeof module === 'object' && module.exports) module.exports = projectMatch;

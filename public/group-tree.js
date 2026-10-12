// Loaded by the page as a plain script and by lib/user-groups.js through require, so the board's
// transient sweep and the server's prune and expiry delete nested groups by one rule.
const groupTree = (() => {
  // The groups `goes` names whose child groups all go too.
  function cascade(groups, goes) {
    const children = new Map();
    for (const g of groups) {
      if (!children.has(g.parent)) children.set(g.parent, []);
      children.get(g.parent).push(g);
    }
    const memo = new Map();
    const all = (g) => {
      if (!memo.has(g)) memo.set(g, goes(g) && (children.get(g.id) || []).every(all));
      return memo.get(g);
    };
    return new Set(groups.filter(all));
  }
  return { cascade };
})();

if (typeof module === 'object' && module.exports) module.exports = groupTree;

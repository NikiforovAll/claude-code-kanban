// Dispatch: a Claude Code session one session started in cck's terminal. In memory on
// purpose: an entry lives as long as its PTY, which dies with the server.

function createDispatchRegistry({ now = Date.now } = {}) {
  const entries = new Map();

  function add({ session, parent, cwd, name, group, worktree }) {
    entries.set(session, {
      session,
      parent: parent || null,
      cwd,
      name: name || null,
      group: group || null,
      worktree: worktree || null,
      startedAt: now(),
    });
  }

  function list({ parent } = {}) {
    const out = [...entries.values()];
    return parent ? out.filter((e) => e.parent === parent) : out;
  }

  return {
    add,
    list,
    has: (session) => entries.has(session),
    remove: (session) => entries.delete(session),
  };
}

module.exports = { createDispatchRegistry };

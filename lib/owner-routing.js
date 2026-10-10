// `dispatched` is the store from lib/retention.js; `listToSessions[listId]` is `{[sessionId]: …}`
// from the plugin's task maps; `metadata` is a getter for session metadata.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const linkKey = (list, owner) => `${list}\n${owner}`;

// A list's candidates are the sessions the list's session dispatched (a session's own list)
// and the sessions mapped to the list (a shared list). `owner` matches the live `agentName`,
// which follows /rename the same way SendMessage does. A name two candidates share gets no link.
function ownerLinks(listIds, { dispatched, listToSessions, metadata }) {
  const candidates = new Map();
  const add = (list, id) => {
    if (!candidates.has(list)) candidates.set(list, new Set());
    candidates.get(list).add(id);
  };
  for (const [id, e] of dispatched.entries()) if (listIds.has(e?.parent)) add(e.parent, id);
  for (const list of listIds) for (const id of Object.keys(listToSessions[list] || {})) add(list, id);

  const links = new Map();
  if (candidates.size) {
    const meta = metadata();
    for (const [list, ids] of candidates) {
      for (const id of ids) {
        const name = meta[id]?.agentName;
        if (!name) continue;
        const key = linkKey(list, name);
        links.set(key, links.has(key) ? null : id);
      }
    }
  }
  return (list, owner) => links.get(linkKey(list, owner)) || null;
}

// Who gets a board move on a shared list: the owner, else the one session that dispatched the
// list's sessions, else no one, because a line to every worker makes them race for the task.
// Null when the rule does not apply: a session's own list goes to that session, the orchestrator,
// even for a child's card, and a list with no task map (a team board) keeps its old routing.
function moveRecipients(listId, owner, inputs) {
  const mapped = !UUID_RE.test(listId) && inputs.listToSessions[listId];
  if (!mapped) return null;
  const id = owner && ownerLinks(new Set([listId]), inputs)(listId, owner);
  if (id) return [id];
  const onList = Object.keys(mapped);
  const on = new Set(onList);
  const parentOf = (s) => inputs.dispatched.get(s)?.parent || null;
  // A session on the list that dispatched others on it is the orchestrator; its own parent is
  // outside the swarm and does not count.
  const orchestrators = new Set(onList.map(parentOf).filter((p) => on.has(p)));
  const parents = new Set(onList.filter((s) => !orchestrators.has(s)).map(parentOf).filter(Boolean));
  return parents.size === 1 ? [...parents] : [];
}

module.exports = { ownerLinks, moveRecipients };

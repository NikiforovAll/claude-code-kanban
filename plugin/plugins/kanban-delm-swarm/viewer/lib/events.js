'use strict';

// The only module that knows the store's event shapes (scripts/store.mjs). It turns what `export`
// returns into one event form the model reads, so a store change is a change here only.

const ms = (ts) => Date.parse(ts.endsWith('Z') ? ts : `${ts}Z`);

function parseEvent(e) {
  const p = e.payload ?? {};
  const base = { seq: e.seq, t: ms(e.ts), actor: e.actor, name: e.name ?? null };
  switch (e.kind) {
    case 'task_create':
      return { ...base, kind: 'task', taskId: p.task_id, title: p.title, description: p.description, taskKind: p.kind };
    case 'task_claim':
      return { ...base, kind: 'claim', taskId: p.task_id };
    case 'task_update':
      return { ...base, kind: 'update', taskId: p.task_id, title: p.title };
    case 'task_release':
      return { ...base, kind: 'release', taskId: p.task_id, handoff: p.handoff, checkpoint: p.checkpoint ?? null };
    case 'task_split':
      return { ...base, kind: 'split', taskId: p.task_id, title: p.task?.title };
    case 'task_finish':
      return { ...base, kind: 'finish', taskId: p.task_id, summary: p.summary };
    case 'claim_lost':
      return { ...base, kind: 'lost', taskId: p.task_id, owner: p.owner ?? null, taskState: p.state };
    case 'publication':
      return { ...base, kind: 'publish', publicationId: e.seq, summary: p.summary, files: p.files ?? [] };
    case 'finding':
      return { ...base, kind: 'finding', findingId: e.seq, text: p.text };
    case 'status':
      return { ...base, kind: 'status', state: p.state, summary: p.summary ?? '', dependency: p.dependency ?? null };
    case 'apply':
      return { ...base, kind: 'apply', publicationId: p.publication_id, paths: p.paths ?? [], confirmed: p.confirmed !== false };
    default:
      return null;
  }
}

const cut = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// One plain sentence per event for the log view. `label` turns an actor id into a worker name.
// The wording keeps `#N` for tasks only, so the page can link every `#N` to a task.
function describeEvent(e, label = (id) => id) {
  const p = e.payload ?? {};
  switch (e.kind) {
    case 'task_create':
      return `added #${p.task_id} ${cut(p.title, 80)}${p.kind && p.kind !== 'work' ? ` (${p.kind})` : ''}`;
    case 'task_claim':
      return `claimed #${p.task_id}`;
    case 'task_update':
      return `updated #${p.task_id}${p.title ? `: ${cut(p.title, 80)}` : ''}`;
    case 'task_release':
      return `released #${p.task_id}: ${cut(p.handoff)}${p.checkpoint ? ` (checkpoint publication ${p.checkpoint})` : ''}`;
    case 'task_split':
      return `split #${p.task_id} into ${[p.task_id, ...(p.created ?? []).map((c) => c.task_id ?? c)].map((i) => `#${i}`).join(', ')}`;
    case 'task_finish':
      return `finished #${p.task_id}: ${cut(p.summary)}`;
    case 'claim_lost':
      return `lost the claim on #${p.task_id}${p.owner ? `, held by ${label(p.owner)}` : p.state ? `, task ${p.state}` : ''}`;
    case 'publication':
      return `publication ${e.seq}: ${(p.files ?? []).map((f) => `${f.path} (${f.change})`).join(', ')}. ${cut(p.summary, 100)}`;
    case 'finding':
      return `finding ${e.seq}: ${cut(p.text)}`;
    case 'status':
      return `${p.state}${p.dependency ? ` for ${cut(p.dependency, 60)}` : ''}${p.summary ? `: ${cut(p.summary, 100)}` : ''}`;
    case 'apply':
      return `applied publication ${p.publication_id}: ${(p.paths ?? []).join(', ')}`;
    default:
      return cut(JSON.stringify(p));
  }
}

const GROUPS = { publication: 'change', apply: 'change', finding: 'finding', status: 'status', claim_lost: 'lost' };
const groupOf = (kind) => GROUPS[kind] ?? (kind.startsWith('task_') ? 'task' : 'other');

// Worker names: the name an event carries wins over the registry's.
function nameMap(events, registry = {}) {
  const names = new Map();
  for (const w of registry.workers ?? []) if (w.sessionId) names.set(w.sessionId, w.name);
  for (const e of events) if (e.name) names.set(e.actor, e.name);
  return names;
}

function logRow(e, names) {
  const label = (id) => names.get(id) ?? id;
  return { seq: e.seq, t: ms(e.ts), who: label(e.actor), kind: e.kind, group: groupOf(e.kind), text: describeEvent(e, label), payload: e.payload };
}

function parseExport(result) {
  const raw = result.events ?? [];
  return { events: raw.map(parseEvent).filter(Boolean), raw, sequence: result.sequence ?? 0 };
}

module.exports = { parseExport, describeEvent, nameMap, logRow, ms };

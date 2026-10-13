'use strict';

const { ms, nameMap } = require('./events');

// Turns the parsed event log (lib/events.js) plus swarm.json into what the views draw.
const QUIET_MS = 10 * 60_000;
const GAP_MS = 8 * 60_000;
const OUTCOME_STATE = { waiting: 'waiting', blocked: 'blocked' };

// `running` maps a worker name to whether its turn runs now, and `acked` to the last request
// revision it acknowledged (parseExport), and `compacted` to how many times its session was
// compacted (lib/compactions.js); each is null when unknown.
function buildModel(events, registry = {}, now = Date.now(), { running = null, acked = null, compacted = null } = {}) {
  const names = nameMap(events, registry);
  const label = (id) => names.get(id) ?? id;
  const isParent = (id) => id === registry.parent || ['parent', 'supervisor'].includes(names.get(id));

  const tasks = new Map();
  const findings = [];
  const publications = new Map();
  const applies = [];
  const races = [];
  const releases = [];
  const requests = [];
  const statuses = {};
  const timeline = {};
  let end = null;
  const lane = (name) => {
    timeline[name] ??= [];
    return timeline[name];
  };
  // What happened under each request revision, by the revision each event was written under.
  const effects = new Map();
  const seen = new Set();
  const fx = (rev) => {
    if (!effects.has(rev)) effects.set(rev, { tasks: [], retitles: [], woken: [], publications: [], outcomes: [], refused: [], first: [] });
    return effects.get(rev);
  };

  for (const e of events) {
    const { t } = e;
    const who = label(e.actor);
    const mark = (type, extra = {}, name = who) => lane(name).push({ type, t, seq: e.seq, rev: e.revision, ...extra });
    const task = tasks.get(e.taskId);
    if (e.kind !== 'woken' && !isParent(e.actor) && !seen.has(`${e.revision}:${e.actor}`)) {
      seen.add(`${e.revision}:${e.actor}`);
      fx(e.revision).first.push({ who, t });
    }
    switch (e.kind) {
      case 'task':
        tasks.set(e.taskId, {
          id: e.taskId,
          subject: e.title,
          detail: e.description,
          createdBy: who,
          createdAt: t,
          revision: e.revision,
          retitles: [],
          state: 'open',
          races: [],
        });
        fx(e.revision).tasks.push(e.taskId);
        break;
      case 'claim':
        if (task) Object.assign(task, { state: 'claimed', owner: who, claimedAt: t });
        mark('claim', { item: e.taskId });
        break;
      case 'update':
      case 'split':
        if (task && e.title && e.title !== task.subject) {
          const retitle = { taskId: task.id, from: task.subject, to: e.title, who, t, revision: e.revision };
          task.retitles.push(retitle);
          fx(e.revision).retitles.push(retitle);
          task.subject = e.title;
        }
        break;
      case 'release':
        if (task) Object.assign(task, { state: 'open', owner: null, claimedAt: null, handoff: e.handoff });
        releases.push({ who, t, taskId: e.taskId, handoff: e.handoff, checkpoint: e.checkpoint });
        mark('release', { item: e.taskId, handoff: e.handoff });
        break;
      case 'finish':
        if (task) Object.assign(task, { state: 'done', owner: who, doneAt: t, summary: e.summary });
        mark('done', { item: e.taskId });
        break;
      case 'lost': {
        const race = { who, t, taskId: e.taskId, owner: e.owner ? label(e.owner) : null, taskState: e.taskState };
        races.push(race);
        task?.races.push(race);
        mark('lost', { item: e.taskId, owner: race.owner });
        break;
      }
      case 'finding':
        findings.push({ id: e.findingId, text: e.text, actor: who, t });
        mark('finding', { id: e.findingId, text: e.text });
        break;
      case 'publish':
        publications.set(e.publicationId, { id: e.publicationId, author: who, t, summary: e.summary, files: e.files });
        fx(e.revision).publications.push({ id: e.publicationId, who, t, summary: e.summary });
        mark('publish', { id: e.publicationId, summary: e.summary });
        break;
      case 'status':
        statuses[who] = { state: e.state, summary: e.summary, dependency: e.dependency, t };
        mark('status', { state: e.state, summary: e.summary, dependency: e.dependency });
        break;
      case 'apply':
        applies.push({ actor: who, t, id: e.publicationId, paths: e.paths, author: publications.get(e.publicationId)?.author });
        mark('apply', { id: e.publicationId, paths: e.paths });
        break;
      case 'close':
        if (task) Object.assign(task, { state: 'done', closed: true, owner: null, doneAt: t, summary: e.summary });
        break;
      case 'stopped':
        statuses[e.worker] = { state: 'stopped', summary: e.reason, dependency: null, t };
        mark('stopped', { reason: e.reason }, e.worker);
        break;
      case 'outcome':
        statuses[who] = { state: OUTCOME_STATE[e.outcome] ?? 'working', outcome: e.outcome, summary: e.summary, dependency: e.dependency, t };
        fx(e.revision).outcomes.push({ who, t, outcome: e.outcome, summary: e.summary });
        mark('outcome', { outcome: e.outcome, summary: e.summary });
        break;
      case 'refused':
        fx(e.revision).refused.push({ who, t, outcome: e.outcome, expected: e.expected });
        mark('refused', { outcome: e.outcome, expected: e.expected });
        break;
      case 'woken':
        statuses[who] = { state: 'working', summary: statuses[who]?.summary ?? '', dependency: null, woken: e.reason, wokeFor: e.dependency, t };
        if (e.reason === 'request') fx(e.revision).woken.push({ who, t });
        mark('woken', { reason: e.reason, from: e.from, dependency: e.dependency });
        break;
      case 'request':
        // Revision 1 is the swarm's spec, written by start.mjs; later revisions change it. The texts
        // are served by /api/request, so the model that every stream frame carries holds none.
        requests.push({ revision: e.revision, seq: e.seq, who, t });
        break;
      case 'end':
        end = { outcome: e.outcome, summary: e.summary, who, t };
        break;
    }
  }

  const first = events.length ? events[0].t : now;
  const last = events.length ? events.at(-1).t : now;
  const ended = !!end || registry.state === 'ended';
  const ref = ended ? Math.max(last, registry.endedAt ? ms(registry.endedAt) : 0) : now;
  const start = registry.startedAt ? Math.min(ms(registry.startedAt), first) : first;

  const actorIds = [
    ...new Set([...(registry.workers ?? []).map((w) => w.sessionId).filter(Boolean), ...events.map((e) => e.actor)]),
  ].filter((id) => !isParent(id));
  const taskList = [...tasks.values()];
  const byActor = new Map();
  for (const e of events) {
    if (!byActor.has(e.actor)) byActor.set(e.actor, []);
    byActor.get(e.actor).push(e);
  }
  const workers = actorIds.map((id) => {
    const name = label(id);
    const mine = byActor.get(id) ?? [];
    const lastT = mine.length ? mine.at(-1).t : null;
    const holding = taskList.find((x) => x.state === 'claimed' && x.owner === name);
    const status = statuses[name] ?? null;
    const gaps = [];
    for (let k = 1; k < mine.length; k++) {
      if (mine[k].t - mine[k - 1].t >= GAP_MS) gaps.push({ from: mine[k - 1].t, to: mine[k].t });
    }
    const silence = lastT == null ? null : ref - lastT;
    const turn = running?.get(name) ?? null;
    let health;
    if (status?.state === 'stopped') health = 'stopped';
    else if (status?.outcome === 'complete') health = 'finished';
    else if (silence == null) health = 'not started';
    // A worker between turns sleeps until the store wakes it, so its silence alone is no alarm,
    // and an outcome it declared explains a claim it still holds.
    else if (turn === false && (status?.outcome || !(holding && silence >= QUIET_MS))) health = status?.state === 'blocked' || status?.state === 'waiting' ? status.state : 'idle';
    else if (silence >= QUIET_MS) health = holding ? 'stuck' : 'quiet';
    else if (status?.state === 'blocked') health = 'blocked';
    else if (status?.state === 'waiting') health = 'waiting';
    else if (holding) health = 'working';
    else health = 'idle';
    return {
      id,
      name,
      health,
      running: turn,
      acked: acked?.get(name) ?? null,
      compacted: compacted?.get(name) ?? null,
      lastT,
      silence,
      holding: holding ? { id: holding.id, subject: holding.subject, since: holding.claimedAt } : null,
      status,
      gaps,
    };
  });

  const pubList = [...publications.values()];
  const done = taskList.filter((x) => x.state === 'done').length;
  const revisions = requests.map((r) => ({ ...r, ...fx(r.revision) }));

  return {
    swarm: {
      listId: registry.listId,
      goal: registry.goal,
      base: registry.base,
      state: registry.state ?? 'unknown',
      startedAt: start,
      endedAt: ended ? ref : null,
      ref,
      events: events.length,
      seq: events.length ? events.at(-1).seq : 0,
      revision: Math.max(1, ...requests.map((r) => r.revision)),
      outcome: end,
      delivery: registry.delivery ?? null,
    },
    progress: {
      total: taskList.length,
      open: taskList.filter((x) => x.state === 'open').length,
      claimed: taskList.filter((x) => x.state === 'claimed').length,
      done,
      closed: taskList.filter((x) => x.closed).length,
      goalReached: end ? end.outcome === 'complete' : ended && taskList.length > 0 && done === taskList.length,
    },
    workers,
    tasks: taskList,
    spec: requests.find((r) => r.revision === 1) ?? null,
    revisions,
    races,
    releases,
    findings,
    publications: pubList,
    applies,
    files: filesByWorker(workers, pubList, applies),
    timeline,
  };
}

// What version of each published path every worker holds, as far as the log tells:
// its own publication, a peer's publication it applied, or nothing logged (base or unknown).
function filesByWorker(workers, pubs, applies) {
  const steps = [];
  for (const p of pubs)
    for (const f of p.files) steps.push({ t: p.t, worker: p.author, path: f.path, pub: p.id, author: p.author, own: true });
  for (const a of applies)
    for (const f of a.paths) steps.push({ t: a.t, worker: a.actor, path: f, pub: a.id, author: a.author, own: false });
  steps.sort((a, b) => a.t - b.t);
  const paths = [...new Set(steps.map((s) => s.path))].sort();
  return paths.map((path) => {
    const mine = steps.filter((s) => s.path === path);
    const latest = mine.filter((s) => s.own).at(-1);
    const held = {};
    for (const w of workers) {
      const s = mine.filter((x) => x.worker === w.name).at(-1);
      held[w.name] = s ? { pub: s.pub, author: s.author, own: s.own, current: s.pub === latest?.pub } : null;
    }
    return {
      path,
      versions: new Set(mine.filter((s) => s.own).map((s) => s.pub)).size,
      held,
    };
  });
}

module.exports = { buildModel };

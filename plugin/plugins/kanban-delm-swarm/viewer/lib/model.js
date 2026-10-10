'use strict';

const { ms, nameMap } = require('./events');

// Turns the parsed event log (lib/events.js) plus swarm.json into what the views draw.
const QUIET_MS = 10 * 60_000;
const GAP_MS = 8 * 60_000;

function buildModel(events, registry = {}, now = Date.now()) {
  const names = nameMap(events, registry);
  const label = (id) => names.get(id) ?? id;

  const tasks = new Map();
  const findings = [];
  const publications = new Map();
  const applies = [];
  const races = [];
  const releases = [];
  const statuses = {};
  const timeline = {};
  const lane = (id) => {
    timeline[label(id)] ??= [];
    return timeline[label(id)];
  };

  for (const e of events) {
    const { t } = e;
    const who = label(e.actor);
    const mark = (type, extra = {}) => lane(e.actor).push({ type, t, seq: e.seq, ...extra });
    const task = tasks.get(e.taskId);
    switch (e.kind) {
      case 'task':
        tasks.set(e.taskId, {
          id: e.taskId,
          subject: e.title,
          detail: e.description,
          createdBy: who,
          createdAt: t,
          state: 'open',
          races: [],
        });
        break;
      case 'claim':
        if (task) Object.assign(task, { state: 'claimed', owner: who, claimedAt: t });
        mark('claim', { item: e.taskId });
        break;
      case 'update':
      case 'split':
        if (task && e.title) task.subject = e.title;
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
    }
  }

  const first = events.length ? events[0].t : now;
  const last = events.length ? events.at(-1).t : now;
  const ended = registry.state === 'ended';
  const ref = ended ? Math.max(last, registry.endedAt ? ms(registry.endedAt) : 0) : now;
  const start = registry.startedAt ? Math.min(ms(registry.startedAt), first) : first;

  const actorIds = [
    ...new Set([...(registry.workers ?? []).map((w) => w.sessionId).filter(Boolean), ...events.map((e) => e.actor)]),
  ];
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
    let health;
    if (/^goal met/i.test(status?.summary ?? '')) health = 'finished';
    else if (silence == null) health = 'not started';
    else if (silence >= QUIET_MS) health = holding ? 'stuck' : 'quiet';
    else if (status?.state === 'blocked') health = 'blocked';
    else if (status?.state === 'waiting') health = 'waiting';
    else if (holding) health = 'working';
    else health = 'idle';
    return {
      id,
      name,
      health,
      lastT,
      silence,
      holding: holding ? { id: holding.id, subject: holding.subject, since: holding.claimedAt } : null,
      status,
      gaps,
    };
  });

  const pubList = [...publications.values()];
  const done = taskList.filter((x) => x.state === 'done').length;

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
    },
    progress: {
      total: taskList.length,
      open: taskList.filter((x) => x.state === 'open').length,
      claimed: taskList.filter((x) => x.state === 'claimed').length,
      done,
      goalReached: ended && taskList.length > 0 && done === taskList.length,
    },
    workers,
    tasks: taskList,
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

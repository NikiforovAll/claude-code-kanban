'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { configDir } = require('../../scripts/start.mjs');

const swarmRoot = (env = process.env) => `${configDir(env)}/.cck/swarm`;

const ID_RE = /^\w[\w.-]*$/;

function readRegistry(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'swarm.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The supervisor's <dir>/result.json (scripts/supervisor.mjs), written before the swarm's end event.
function readDelivery(dir) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    return r.delivery ? { ...r.delivery, worker: r.worker ?? null, project: r.project ?? null } : null;
  } catch {
    return null;
  }
}

function readOutcome(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).outcome ?? null;
  } catch {
    return null;
  }
}

// The store's end writes the ended state to swarm.json, and nothing writes it after, so an
// ended swarm's file time is its end.
function describe(dir) {
  const r = readRegistry(dir);
  if (!r) return null;
  const ended = r.state === 'ended';
  let endedAt = null;
  if (ended) {
    try {
      endedAt = fs.statSync(path.join(dir, 'swarm.json')).mtime.toISOString();
    } catch {}
  }
  return {
    id: path.basename(dir),
    goal: r.goal ?? '',
    state: r.state ?? 'unknown',
    startedAt: r.startedAt ?? null,
    endedAt,
    outcome: ended ? readOutcome(dir) : null,
    workers: (r.workers ?? []).map((w) => w.name),
    project: r.project ?? null,
  };
}

// Running swarms first, then newest start first.
function listSwarms(root) {
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && ID_RE.test(d.name));
  } catch {}
  return names
    .map((d) => describe(path.join(root, d.name)))
    .filter(Boolean)
    .sort(
      (a, b) =>
        (b.state === 'running') - (a.state === 'running') || String(b.startedAt).localeCompare(String(a.startedAt)),
    );
}

module.exports = { configDir, swarmRoot, listSwarms, describe, readRegistry, readDelivery, ID_RE };

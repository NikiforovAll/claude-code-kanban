'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalPath } = require('./paths');

/** The pads opened last, newest first: [{dir, project, session, openedAt}]. */
function createHistory(file, max = 50) {
  let items = read();

  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data.pads) ? data.pads.filter((p) => typeof p?.dir === 'string').slice(0, max) : [];
    } catch {
      return [];
    }
  }

  function write() {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp,JSON.stringify({ pads: items }, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`history not saved: ${e.message}`);
    }
  }

  function add({ dir, project, session }) {
    const key = canonicalPath(dir);
    const old = items.find((p) => canonicalPath(p.dir) === key);
    const entry = {
      dir,
      project: project || old?.project || null,
      session: session || old?.session || null,
      openedAt: Date.now(),
    };
    items = [entry, ...items.filter((p) => p !== old)].slice(0, max);
    write();
  }

  /** The history grouped by project, the project with the newest pad first and "Other" last. */
  function groups() {
    const byProject = new Map();
    for (const p of items) {
      const key = p.project ? canonicalPath(p.project) : '';
      if (!byProject.has(key)) byProject.set(key, { project: p.project, label: p.project ? path.basename(p.project) : 'Other', pads: [] });
      byProject.get(key).pads.push(p);
    }
    return [...byProject.values()].sort((a, b) => (a.project ? 0 : 1) - (b.project ? 0 : 1));
  }

  return { add, groups, all: () => items };
}

module.exports = { createHistory };

'use strict';

// A message to a stopped subagent spawns it again under the same id, and the plugin appends
// another start line. Each start line begins a new run, so nothing of the run before it shows.
function foldAgentLines(raw) {
  let merged = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (obj.event === 'start') merged = {};
    Object.assign(merged, obj);
  }
  return merged;
}

module.exports = { foldAgentLines };

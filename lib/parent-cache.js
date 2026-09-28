const fs = require('fs');
const path = require('path');
const { countTranscriptsBornBefore } = require('./parsers');

// Verdicts of lookupParentSession in server.js. A verdict depends on the child's head and on
// the transcripts of its folder born before it, because only those can be its parent. So a new
// transcript cannot change it, but a replaced child or parent, a compact anchor seen later, or
// an older transcript moved into the folder can. Each entry records these and is checked on use.
const verdicts = new Map();
let dirty = false;

function getParentVerdict(sessionId, meta) {
  const v = verdicts.get(sessionId);
  if (!v || !meta?.jsonlPath || v.childPath !== meta.jsonlPath) return null;
  if (v.logicalParentUuid !== (meta.logicalParentUuid || null)) return null;
  try {
    const self = fs.statSync(v.childPath);
    if (self.ino !== v.childIno) return null;
    if (v.parentIno !== null && fs.statSync(v.result.parentJsonlPath).ino !== v.parentIno) return null;
    if (countTranscriptsBornBefore(path.dirname(v.childPath), self.birthtimeMs) !== v.olderCount) return null;
  } catch (_) {
    return null;
  }
  return v.result;
}

// self: the child's stat from the lookup. parentIno: null when no parent was found.
function setParentVerdict(sessionId, meta, self, parentIno, result) {
  verdicts.set(sessionId, {
    childPath: meta.jsonlPath,
    childIno: self.ino,
    logicalParentUuid: meta.logicalParentUuid || null,
    parentIno,
    olderCount: countTranscriptsBornBefore(path.dirname(meta.jsonlPath), self.birthtimeMs),
    result,
  });
  dirty = true;
}

const parentVerdictsDirty = () => dirty;

function exportParentVerdicts() {
  dirty = false;
  return [...verdicts].filter(([, v]) => fs.existsSync(v.childPath));
}

function importParentVerdicts(entries) {
  if (!Array.isArray(entries)) return;
  const num = (x) => typeof x === 'number';
  for (const pair of entries) {
    const v = Array.isArray(pair) ? pair[1] : null;
    if (typeof pair?.[0] !== 'string' || !v || typeof v.childPath !== 'string' || !num(v.childIno) || !num(v.olderCount)) continue;
    if (!(v.parentIno === null || num(v.parentIno)) || typeof v.result?.relation !== 'string') continue;
    verdicts.set(pair[0], v);
  }
}

module.exports = { getParentVerdict, setParentVerdict, parentVerdictsDirty, exportParentVerdicts, importParentVerdicts };

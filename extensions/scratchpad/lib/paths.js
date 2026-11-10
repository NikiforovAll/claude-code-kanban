'use strict';

/** One key per pad folder: forward slashes, and a Windows path lowercased. */
function canonicalPath(p) {
  const slashed = String(p).replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

module.exports = { canonicalPath };

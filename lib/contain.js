'use strict';

// Path containment check.
//
// The obvious implementation — `child.startsWith(root)` — is wrong twice over:
// it accepts a sibling directory that merely shares a prefix ("/plugins/foo-evil"
// passes a check for "/plugins/foo"), and it is blind to symlinks, `..`, casing
// and Windows 8.3 short names. This uses path.relative instead, and canonicalises
// both sides first.
//
// CANONICAL COPY: scripts/security-lib/contain.js in the claude-code-hub repo.
// Run scripts/sync-security-lib.sh after editing.

const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';

// realpath the deepest existing ancestor, then re-append the non-existent tail,
// so a not-yet-created file under a symlinked directory still canonicalises.
function realpathDeepest(target) {
  let cur = target;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return target; // reached the volume root, nothing resolvable
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function canonical(target, deepest) {
  let out = path.resolve(target);
  if (deepest) out = realpathDeepest(out);
  else { try { out = fs.realpathSync.native(out); } catch { /* may not exist yet */ } }
  // realpathSync.native has already expanded 8.3 short names (PROGRA~1) and fixed
  // the casing of the existing portion; lowercase covers the rest.
  return IS_WIN ? out.toLowerCase() : out;
}

function beneath(canonicalChild, root) {
  const rel = path.relative(canonical(root, false), canonicalChild);
  // '' means child === root. An absolute rel means a different drive or UNC share,
  // which path.relative signals by giving up — reject those.
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * True iff `child` is `root` itself or lies beneath it.
 * @param {string} child
 * @param {string} root
 */
function isContained(child, root) {
  if (typeof child !== 'string' || typeof root !== 'string' || !child || !root) return false;
  return beneath(canonical(child, true), root);
}

/**
 * True iff `child` is contained by any of `roots`. Canonicalises the child once
 * instead of once per root — callers testing a single path against several roots
 * were paying that walk repeatedly.
 * @param {string} child
 * @param {string[]} roots
 */
function isContainedAny(child, roots) {
  if (typeof child !== 'string' || !child || !Array.isArray(roots)) return false;
  const c = canonical(child, true);
  return roots.some((r) => typeof r === 'string' && r && beneath(c, r));
}

module.exports = { isContained, isContainedAny, realpathDeepest };

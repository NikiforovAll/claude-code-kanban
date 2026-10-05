'use strict';

// attr="${expr}" / attr='${expr}' — the first token of the expression is what tells us
// whether an escaper is involved.
const ATTR_INTERP = /([a-zA-Z-]+)\s*=\s*(["'])[^"'>]*?\$\{\s*([^}]*)/g;

// on*="fn('${expr}')" — ATTR_INTERP cannot see these because its value scan stops at
// the inner quote, which is why a raw task id in an onclick survived the first pass.
// Anything here needs escAttrJs, not just an HTML escaper.
const HANDLER = /\son([a-z]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
const INTERP = /\$\{\s*([^}]*)/g;

// Interpolations that need no escaper: values the code fully controls.
const SAFE_EXPR = [
  /^esc/, // esc, escapeHtml, escAttrJs, escJs
  /^ICONS\./,
  /^[A-Z][A-Z0-9_]*(\b|$)/, // SCREAMING_CASE constants (SVG blobs, class-name tables)
  /^(i|idx|index|n|count|len|num)\b/,
  /^\d/,
  /^(['"]).*\1$/, // a plain string literal
];

// Splits a ternary into its two branches, or returns null if the expression is not
// one. A blanket "contains ?" exemption was hiding every optional chain and every
// ternary with an unescaped branch, so each side is tested on its own instead.
function splitTernary(expr) {
  let depth = 0;
  let quote = null;
  let q = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '?' && depth === 0) {
      if (expr[i + 1] === '.' || expr[i + 1] === '?') { i++; continue; } // ?. / ??
      q = i;
      break;
    }
  }
  if (q === -1) return null;
  // Matching colon: skip past the nested ternaries a branch may itself contain.
  let nested = 0;
  depth = 0;
  quote = null;
  for (let i = q + 1; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?') nested++;
    else if (depth === 0 && c === ':') {
      if (nested) { nested--; continue; }
      return [expr.slice(q + 1, i), expr.slice(i + 1)];
    }
  }
  // Unbalanced — the value scan truncated the expression. Treat the tail as one branch.
  return [expr.slice(q + 1)];
}

// Locals assigned straight from an escaper — `const sid = escAttrJs(session.id)`.
// Hoisting one escape out of a template that interpolates it eight times is the
// right call, so the check follows the assignment rather than only the call site.
// A name is only trusted when *every* declaration of it in the file is escaped,
// which keeps generic names (text, label, attr) from being waved through because
// one unrelated function happened to escape one.
const ANY_ASSIGN = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;

function escapedLocals(src) {
  const escaped = new Set();
  const raw = new Set();
  for (const [, name, rhs] of src.matchAll(ANY_ASSIGN)) {
    (/^esc[A-Za-z]*\(/.test(rhs.trim()) ? escaped : raw).add(name);
  }
  for (const name of raw) escaped.delete(name);
  return escaped;
}

// The condition is never rendered, so only the branches matter.
function isSafe(expr, escLocals) {
  const e = expr.trim();
  if (!e) return true;
  if (SAFE_EXPR.some((re) => re.test(e))) return true;
  if (escLocals?.has(e.match(/^[A-Za-z_$][\w$]*/)?.[0])) return true;
  const branches = splitTernary(e);
  return branches ? branches.every((b) => isSafe(b, escLocals)) : false;
}

// Attributes whose value is never a string from disk or from a model.
const SAFE_ATTRS = new Set([
  'style', 'width', 'height', 'viewBox', 'stroke-width', 'd', 'points',
  'r', 'cx', 'cy', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'fill', 'transform',
  'aria-hidden', 'colspan', 'rowspan', 'tabindex',
]);

function scan(src) {
  const out = [];
  const escLocals = escapedLocals(src);
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const m of line.matchAll(ATTR_INTERP)) {
      const [, attr, , rawExpr] = m;
      const expr = rawExpr.trim();
      if (SAFE_ATTRS.has(attr)) continue;
      if (isSafe(expr, escLocals)) continue;
      out.push({ line: i + 1, attr, expr: expr.slice(0, 60) });
    }
    for (const h of line.matchAll(HANDLER)) {
      const attr = `on${h[1]}`;
      for (const m of h[2].matchAll(INTERP)) {
        const expr = m[1].trim();
        if (isSafe(expr, escLocals)) continue;
        if (out.some((o) => o.line === i + 1 && o.expr === expr.slice(0, 60))) continue;
        out.push({ line: i + 1, attr, expr: expr.slice(0, 60) });
      }
    }
  });
  return out;
}

const HINT = 'Wrap the value in escapeHtml() / esc(), or escAttrJs() if it lands inside a JS string.';

module.exports = { scan, HINT };

// UI-driven approvals (_plans/cck-ui-approvals/): approval-gate.sh writes the
// _waiting.json marker with a request id (D8) and polls for _decision-<id>.json.
// buildDecision validates a board response against the live marker and shapes
// the decision file; the route writes it. The hook deletes marker + decision on
// consumption; orphans from a terminal deny (D13) are left for the sweep.

// Ids are hook-minted (uuidgen or a time-pid-random compound) — anything outside
// this alphabet is either corruption or a path-traversal attempt (3.5).
function sanitizeRequestId(raw) {
  return typeof raw === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(raw) ? raw : null;
}

// A decision whose shape doesn't match the ask's kind produces hook output
// Claude Code rejects, surfacing as an opaque stall — reject at the API
// boundary instead (D7). Returns { error, status } or { decision }.
function buildDecision(marker, body) {
  if (!marker || marker.status !== 'waiting') {
    return { error: 'No pending ask', status: 410 };
  }
  const id = sanitizeRequestId(body && body.id);
  if (!id) return { error: 'Invalid or missing request id', status: 400 };
  if (marker.id !== id) return { error: 'Ask superseded by a newer one', status: 409 };

  if (marker.kind === 'question') {
    if (!body.answers || typeof body.answers !== 'object') {
      return { error: 'A question ask needs answers', status: 422 };
    }
    // Partial answers are allowed — Claude reads the answered keys and treats
    // the rest as skipped. Only a completely empty object is a no-op ask.
    // multiSelect answers arrive as arrays of labels — Claude Code validates
    // that shape natively.
    const usable = (v) =>
      (typeof v === 'string' && v) ||
      (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x));
    const given = Object.entries(body.answers).filter(([, v]) => usable(v));
    if (!given.length) {
      return { error: 'A question ask needs at least one answer', status: 422 };
    }
    return { decision: { answers: Object.fromEntries(given) } };
  }

  if (body.behavior !== 'allow' && body.behavior !== 'deny') {
    return { error: 'A permission ask needs behavior "allow" or "deny"', status: 422 };
  }
  const decision = { behavior: body.behavior };
  if (typeof body.message === 'string' && body.message) decision.message = body.message;
  if (body.updatedInput && typeof body.updatedInput === 'object') decision.updatedInput = body.updatedInput;
  if (Array.isArray(body.updatedPermissions)) decision.updatedPermissions = body.updatedPermissions;
  return { decision };
}

function decisionFileName(id) {
  return `_decision-${id}.json`;
}

// Keep in sync with decisionFileName — the cleanup sweep matches by shape
function isDecisionFile(name) {
  return name.startsWith('_decision-') && name.endsWith('.json');
}

// approval-gate.sh only polls for a decision for waitSeconds — after that the
// ask belongs to the terminal. Default and clamp mirror the gate's own parse
// (PERMISSION_TTL_MS hides the card at 30 min, so waiting longer than the UI
// can show the ask is strictly worse — D11); keep them in sync with
// approval-gate.sh.
const WAIT_SECONDS_DEFAULT = 30;
const WAIT_SECONDS_MAX = 1800;
// Small grace over the gate's own deadline so a race never 410s a live hook
const LAPSE_GRACE_MS = 5000;

function waitSecondsFrom(cfg) {
  const raw = cfg && cfg.waitSeconds;
  if (Number.isInteger(raw) && raw >= 0) return Math.min(raw, WAIT_SECONDS_MAX);
  return WAIT_SECONDS_DEFAULT;
}

function isLapsed(timestamp, waitMs, now = Date.now()) {
  if (!timestamp) return true;
  return now - new Date(timestamp).getTime() > waitMs + LAPSE_GRACE_MS;
}

module.exports = { sanitizeRequestId, buildDecision, decisionFileName, isDecisionFile, waitSecondsFrom, isLapsed };

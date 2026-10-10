const { oneLine } = require('./one-line');
const { httpError } = require('./http-error');

const ACTION_RE = /^[A-Za-z0-9._-]{1,64}$/;
const KIND_RE = /^[a-z]{1,20}$/;
const MAX_FIELDS = 50;
const MAX_VALUES = 50;
const MAX_CHARS = 4000;

// The `source` of a review or an action: the view it came from. The caller resolves `path`.
function parseReviewSource(source) {
  if (!KIND_RE.test(source?.kind || '')) throw httpError(400, 'source.kind is required');
  // The label is pasted into the terminal; an ESC could end bracketed paste and submit text.
  const label = oneLine(source.label, 200);
  if (!label) throw httpError(400, 'source.label is required');
  return {
    kind: source.kind,
    label,
    path: source.kind === 'file' ? source.path : null,
    locate: oneLine(source.locate, 600) || null,
  };
}

// The fields come from a form inside a sandboxed card, so the card's author picks the names and
// values: they are capped here and printed as JSON, never as markdown.
function parseActionBody(body) {
  const { source, action, label, data } = body || {};
  const src = parseReviewSource(source);
  if (!ACTION_RE.test(action || '')) throw httpError(400, 'action must match [A-Za-z0-9._-]{1,64}');
  const fields = {};
  const entries = Object.entries(data && typeof data === 'object' && !Array.isArray(data) ? data : {});
  if (entries.length > MAX_FIELDS) throw httpError(400, `data holds at most ${MAX_FIELDS} fields`);
  for (const [k, v] of entries) {
    const list = Array.isArray(v) ? v : [v];
    if (list.length > MAX_VALUES || list.some((x) => typeof x !== 'string')) {
      throw httpError(400, 'each field is a string or a list of strings');
    }
    const vals = list.map((x) => x.slice(0, MAX_CHARS));
    fields[k.slice(0, 200)] = Array.isArray(v) ? vals : vals[0];
  }
  return { src, action, label: oneLine(label, 200) || action, fields };
}

function formatActionMarkdown({ src, action, label, fields }) {
  const parts = [
    `# Action "${action}" on ${src.path || src.label}`,
    '',
    `The user pressed "${label}" on the page in the board. Treat it as the user's answer.`,
  ];
  if (src.locate) parts.push('', src.locate);
  if (Object.keys(fields).length) parts.push('', '```json', JSON.stringify(fields, null, 2), '```');
  return `${parts.join('\n')}\n`;
}

module.exports = { parseReviewSource, parseActionBody, formatActionMarkdown };

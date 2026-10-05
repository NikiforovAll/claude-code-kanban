// Whether a page lets the board frame it, from its response headers. The parent page gets no
// signal when a cross-origin frame is refused (Chrome fires `load` on its error page), so the
// server reads the headers instead. Rules: CSP3 frame-ancestors (it wins over X-Frame-Options
// when present) and the HTML spec's X-Frame-Options processing.

const { portOf } = require('./panes');

const PROBE_TIMEOUT_MS = 5000;

function parseOrigin(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

// CSP3 lets an http source match https too.
const schemeOk = (want, got) => want === got || (want === 'http:' && got === 'https:');

function matchesSource(source, ancestor, self) {
  const s = source.toLowerCase();
  if (s === "'self'") return ancestor.origin === self.origin;
  if (s === '*') return true;
  if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return schemeOk(s, ancestor.protocol);
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^:/]+)(?::(\d+|\*))?(?:\/.*)?$/.exec(s);
  if (!m) return false;
  const [, scheme, host, port] = m;
  const want = scheme ? `${scheme}:` : self.protocol;
  if (!schemeOk(want, ancestor.protocol)) return false;
  const hostOk = host === '*' || (host.startsWith('*.') ? ancestor.hostname.endsWith(host.slice(1)) : host === ancestor.hostname);
  if (!hostOk) return false;
  if (port === '*' || (!port && ancestor.port === '')) return true;
  return Number(port) === portOf(ancestor) || (port === '80' && ancestor.protocol === 'https:' && ancestor.port === '');
}

function frameAncestorsLists(csp) {
  const lists = [];
  for (const policy of String(csp || '').split(',')) {
    for (const directive of policy.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name?.toLowerCase() === 'frame-ancestors') {
        lists.push(sources);
        break;
      }
    }
  }
  return lists;
}

// headers: Fetch Headers. target: the final URL of the response. ancestors: every origin above
// the frame. Answers true, false, or null when it cannot tell.
function framingVerdict(headers, { target, ancestors }) {
  const self = parseOrigin(target);
  const chain = ancestors.map(parseOrigin).filter(Boolean);
  if (!self || !chain.length) return null;
  const lists = frameAncestorsLists(headers.get('content-security-policy'));
  if (lists.length) return lists.every((sources) => chain.every((a) => sources.some((src) => matchesSource(src, a, self))));
  const xfo = String(headers.get('x-frame-options') || '')
    .split(',')
    .map((v) => v.trim().toLowerCase());
  if (xfo.includes('deny')) return false;
  return !xfo.includes('sameorigin') || chain.every((a) => a.origin === self.origin);
}

// GETs the page and drops the body once the headers arrive. A network error or a timeout
// answers null, and the board frames the page anyway.
async function probeFraming(target, ancestors, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(target, { redirect: 'follow', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    res.body?.cancel().catch(() => {});
    return framingVerdict(res.headers, { target: res.url || target, ancestors });
  } catch {
    return null;
  }
}

module.exports = { framingVerdict, parseOrigin, probeFraming };

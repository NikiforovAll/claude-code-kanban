'use strict';

// Network boundary for a local-only dev server.
//
// Binding loopback is necessary but not sufficient. Three distinct attackers:
//
//   * LAN peer — http://192.168.1.42:3541/api/... The loopback bind stops this
//     outright; the handshake never completes off-box.
//   * DNS rebinding — the victim loads evil.com, the attacker re-resolves that
//     name to 127.0.0.1, and the page fetches http://evil.com:3541/api/...
//     The page's origin *is* evil.com:3541, so the request is same-origin and
//     CORS never fires; the connection is to loopback, so the bind is satisfied.
//     The only thing that differs from a legitimate request is the Host header,
//     which script cannot forge. A Host allowlist is the entire defense.
//   * Plain CSRF — evil.com POSTs straight at 127.0.0.1:3541. Host is a real
//     allowlisted value, so hostGuard passes it; this needs a separate Origin /
//     Sec-Fetch-Site check on state-changing methods.
//
// There is no authentication. Exposing this to a network means trusting everyone
// on it with the user's Claude Code history.
//
// CANONICAL COPY: scripts/security-lib/net-guard.js in the claude-code-hub repo.
// Run scripts/sync-security-lib.sh after editing.

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1',
]);

// Hoisted: parseHostHeader runs on every request, and neither the regex nor the
// predicate depends on the argument.
const PORT_RE = /^[0-9]{1,5}$/;
// The port is validated but not compared — the listen(0) fallbacks make the real
// port dynamic, so only the host is allowlisted.
const validPort = (p) => PORT_RE.test(p) && Number(p) >= 1 && Number(p) <= 65535;

function isLoopbackAddress(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h.startsWith('127.');
}

// Hand-parsed rather than via new URL(), which is far more permissive than we
// want here and happily accepts things no real client sends. Returns the bare
// hostname, lowercased, or null if the header is malformed.
//
// The port is deliberately ignored: ports are dynamic in these apps because of
// the listen(0) fallback when the default is busy, so pinning one would break
// the fallback path.
function parseHostHeader(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 259) return null;

  // Reject whitespace and control characters. Written as a code-point scan rather
  // than a character class so it cannot be misread — a stray range in a regex
  // here would silently reject legitimate hostnames containing a dash.
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  if (raw.includes('@')) return null; // userinfo has no business in a Host header

  let host;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return null;
    host = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest && !(rest.startsWith(':') && validPort(rest.slice(1)))) return null;
  } else {
    const parts = raw.split(':');
    if (parts.length > 2) return null; // bare IPv6 without brackets, or garbage
    host = parts[0];
    if (parts.length === 2 && !validPort(parts[1])) return null;
  }

  if (!host) return null;
  if (host.endsWith('.')) host = host.slice(0, -1); // one trailing root dot is legal
  if (!host) return null;
  return host.toLowerCase();
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function getFlag(name) {
  const idx = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return null;
  const arg = process.argv[idx];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  const next = process.argv[idx + 1];
  return next && !next.startsWith('--') ? next : null;
}

/**
 * @param {{appName?: string}} [config]
 */
function createNetGuard(config = {}) {
  const appName = config.appName || 'This app';

  const BIND_HOST = getFlag('host') || process.env.HOST || '127.0.0.1';
  const BIND_HOST_LC = BIND_HOST.toLowerCase();
  const EXPOSED = !isLoopbackAddress(BIND_HOST);
  // Resolved here and re-exported so the hub can forward the same value to its
  // children rather than re-parsing the flag with its own argv scanner — a parent
  // and child that disagree means the shell serves while every iframe 403s.
  const ALLOWED_HOSTS = getFlag('allowed-hosts') || process.env.ALLOWED_HOSTS || '';
  const extraHosts = new Set(parseList(ALLOWED_HOSTS));

  // The hub frames each sub-app, so its origin must be accepted as an Origin and
  // permitted as a framing ancestor.
  let hubOrigin = null;
  if (process.env.HUB_URL) {
    try { hubOrigin = new URL(process.env.HUB_URL).origin; } catch { /* ignore a malformed HUB_URL */ }
  }

  // Resolved only once listen() succeeds — the requested port may have been busy.
  let actualPort = null;

  function hostAllowed(host) {
    if (!host) return false;
    if (isLoopbackAddress(host)) return true;
    if (extraHosts.has(host)) return true;
    // Binding a specific non-loopback address implies that address is a valid name for us.
    if (EXPOSED && host === BIND_HOST_LC) return true;
    return false;
  }

  function hostGuard(req, res, next) {
    const host = parseHostHeader(req.headers.host);
    if (hostAllowed(host)) return next();
    res.status(403).type('text/plain').send(
      `403 Forbidden - unrecognized Host header: ${req.headers.host || '(none)'}\n\n` +
      `${appName} only answers requests addressed to localhost. This protects you\n` +
      `from DNS rebinding, where a website you visit re-points its own hostname at\n` +
      `127.0.0.1 in order to read your local data.\n\n` +
      `If you meant to reach this from another machine, restart with:\n` +
      `  --host 0.0.0.0 --allowed-hosts=${host || '<your-hostname>'}\n\n` +
      `Only do that on a network you trust - there is no authentication.\n`
    );
  }

  // true = allow, false = block, null = no Origin header, caller decides.
  function originVerdict(origin) {
    if (!origin || origin === 'null') return null;
    let parsed;
    try { parsed = new URL(origin); } catch { return false; }
    if (hubOrigin && parsed.origin === hubOrigin) return true;
    if (!isLoopbackAddress(parsed.hostname)) return false;
    // Same port, any loopback spelling. A different local port is a different app
    // and has no business driving this one.
    if (actualPort && parsed.port && Number(parsed.port) !== Number(actualPort)) return false;
    return true;
  }

  function originGuard(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    const verdict = originVerdict(req.headers.origin);
    if (verdict === true) return next();
    if (verdict === false) {
      return res.status(403).type('text/plain')
        .send(`403 Forbidden - cross-origin ${req.method} from ${req.headers.origin} is not allowed.\n`);
    }

    // No Origin header: a non-browser client (curl, the CLI, the hub's own fetch).
    // Trust it unless the browser explicitly tells us otherwise.
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      return res.status(403).type('text/plain')
        .send(`403 Forbidden - cross-site ${req.method} (Sec-Fetch-Site: ${site}) is not allowed.\n`);
    }
    return next();
  }

  // Constant for the life of the process, and frameGuard runs ahead of
  // express.static — so this is built once rather than per asset fetch.
  //
  // Under the hub, X-Frame-Options is deliberately omitted: it has no multi-origin
  // form, and sending SAMEORIGIN would break the hub's iframes.
  //
  // The port is wildcarded rather than pinned to HUB_URL's. The hub spawns its
  // children before it binds, so if its own preferred port is busy it hands them a
  // HUB_URL with the wrong port and every iframe would break. Any loopback port may
  // frame us; that is not the threat being addressed here — a remote page still
  // cannot, which is what matters.
  //
  // No IPv6 literal: Chrome rejects `http://[::1]:*` as a source expression and
  // logs it on every framed load. The hub's own origin is added verbatim instead,
  // which covers a hub reached over [::1].
  let CSP;
  if (hubOrigin) {
    const ancestors = ["'self'", 'http://localhost:*', 'http://127.0.0.1:*'];
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(hubOrigin)) ancestors.push(hubOrigin);
    CSP = `frame-ancestors ${ancestors.join(' ')}`;
  } else {
    CSP = "frame-ancestors 'none'";
  }

  function frameGuard(_req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    if (!hubOrigin) res.setHeader('X-Frame-Options', 'DENY');
    next();
  }

  /**
   * Bind BIND_HOST, then opportunistically serve the other loopback family on the
   * same resolved port via a second server sharing the same request handler.
   *
   * That second bind is what keeps `http://localhost:<port>` working no matter how
   * the OS resolver orders A/AAAA records - binding only 127.0.0.1 breaks hosts
   * where `localhost` resolves to ::1, and vice versa. Doing it on the *resolved*
   * port means every existing URL, startup banner and postMessage origin is
   * unchanged. Failures are swallowed: it is an optimization, not a requirement.
   *
   * Returns the primary server, so callers keep attaching their own 'error'
   * handler for the EADDRINUSE fallback.
   *
   * @param {any} app express app (or any http request handler)
   * @param {number} port 0 selects a free port
   * @param {(port: number) => void} [onReady]
   * @param {{maxHeaderSize?: number}} [opts]
   */
  function listenLoopback(app, port, onReady, opts = {}) {
    const http = require('http');
    const serverOpts = opts.maxHeaderSize ? { maxHeaderSize: opts.maxHeaderSize } : {};
    const makeServer = (handler) => http.createServer(serverOpts, handler);
    const server = makeServer(app);
    let secondary = null;

    server.on('listening', () => {
      actualPort = server.address().port;
      if (!EXPOSED) {
        const otherFamily = BIND_HOST.includes(':') ? '127.0.0.1' : '::1';
        try {
          secondary = makeServer(app);
          secondary.on('error', () => {}); // that family may not exist on this host
          secondary.listen({ host: otherFamily, port: actualPort, ipv6Only: otherFamily === '::1' });
        } catch { /* best effort */ }
      }
      if (onReady) onReady(actualPort);
    });
    server.on('close', () => { try { if (secondary) secondary.close(); } catch { /* already gone */ } });

    server.listen(port, BIND_HOST);
    return server;
  }

  function exposureWarning() {
    if (!EXPOSED) return null;
    return `WARNING: listening on ${BIND_HOST} - reachable from your network, with no authentication.`;
  }

  return { BIND_HOST, ALLOWED_HOSTS, hostGuard, originGuard, frameGuard, listenLoopback, exposureWarning };
}

module.exports = { createNetGuard, parseHostHeader, isLoopbackAddress };

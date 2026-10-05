const fs = require('node:fs');
const { readFileSync, existsSync, readdirSync, statSync } = fs;
const path = require('node:path');
const os = require('node:os');
const { StringDecoder } = require('node:string_decoder');

// Full-transcript scans stream the file instead of reading it whole: a transcript can
// reach hundreds of megabytes, and the event loop it would block also carries the
// embedded terminal's keystrokes. Yields the same lines as content.split('\n').
async function* readLines(file) {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    const parts = decoder.write(chunk).split('\n');
    parts[0] = rest + parts[0];
    rest = parts.pop();
    yield* parts;
  }
  yield rest + decoder.end();
}

function parseTask(raw) {
  const task = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    id: task.id,
    subject: task.subject,
    description: task.description || null,
    status: task.status,
    blocks: task.blocks || [],
    blockedBy: task.blockedBy || [],
    isInternal: !!task.metadata?._internal,
    raw: task
  };
}

function parseAgent(raw) {
  const agent = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    agentId: agent.agentId,
    type: agent.type || null,
    status: agent.status,
    startedAt: agent.startedAt,
    stoppedAt: agent.stoppedAt || null,
    updatedAt: agent.updatedAt || null,
    lastMessage: agent.lastMessage || null,
    prompt: agent.prompt || null,
    raw: agent
  };
}

function parseWaiting(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    status: data.status,
    kind: data.kind || null,
    toolName: data.toolName || null,
    toolInput: data.toolInput || null,
    timestamp: data.timestamp,
    raw: data
  };
}

function parseTeamConfig(raw) {
  const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    name: config.name,
    description: config.description || null,
    leadAgentId: config.leadAgentId,
    leadSessionId: config.leadSessionId || null,
    members: (config.members || []).map(m => ({
      agentId: m.agentId,
      name: m.name,
      agentType: m.agentType || null,
      model: m.model || null,
      cwd: m.cwd || null,
      color: m.color || null
    })),
    raw: config
  };
}

function parseSessionsIndex(raw) {
  const index = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    version: index.version || null,
    entries: (index.entries || []).map(e => ({
      sessionId: e.sessionId,
      description: e.description || null,
      gitBranch: e.gitBranch || null,
      created: e.created || null,
      projectPath: e.projectPath || null,
      isSidechain: e.isSidechain || false
    })),
    raw: index
  };
}

function parseJsonlLine(line) {
  const obj = typeof line === 'string' ? JSON.parse(line) : line;
  const base = {
    type: obj.type,
    timestamp: obj.timestamp || null,
    sessionId: obj.sessionId || null,
    uuid: obj.uuid || null
  };

  if (obj.type === 'assistant' && obj.message?.content && Array.isArray(obj.message.content)) {
    const blocks = obj.message.content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'tool_use') return { type: 'tool_use', name: block.name, input: block.input || null };
      if (block.type === 'thinking') return { type: 'thinking' };
      return { type: block.type };
    });
    return { ...base, role: 'assistant', model: obj.message.model || null, blocks };
  }

  if (obj.type === 'user' && obj.message?.role === 'user') {
    return {
      ...base,
      role: 'user',
      isMeta: !!obj.isMeta,
      content: typeof obj.message.content === 'string' ? obj.message.content : null
    };
  }

  if (obj.type === 'queue-operation' && obj.operation === 'enqueue') {
    return {
      ...base,
      role: 'user',
      queued: true,
      content: typeof obj.content === 'string' ? obj.content : null
    };
  }

  if (obj.type === 'progress') {
    return { ...base, cwd: obj.cwd || null, version: obj.version || null, slug: obj.slug || null };
  }

  return base;
}

const TOOL_RESULT_MAX = 1500;
const USER_TEXT_MAX = 500;
const INTERRUPT_MARKER = '[Request interrupted by user]';

// Newer Claude Code no longer inlines pasted images as base64 blocks. It writes
// them to ~/.claude/image-cache/<sessionId>/<N>.<ext> and leaves only a text marker
// in the message — an inline "[Image #N]" placeholder and/or a standalone
// "[Image: source: ...\N.ext]" line. Pull out the N references (so the UI can serve
// the cached file) and strip the verbose source lines from the displayed text — the
// rendered preview replaces them; the short "[Image #N]" placeholders stay.
// Runs on the per-message scan hot path, so it skips the regexes entirely unless a
// marker is present. Returns { refs: [{ kind: 'cache', n }], text }.
function parseImageMarkers(text) {
  const raw = text || '';
  if (!raw.includes('[Image')) return { refs: [], text: raw.trim() };
  const ns = new Set();
  for (const m of raw.matchAll(/\[Image #(\d+)\]/g)) ns.add(Number(m[1]));
  for (const m of raw.matchAll(/\[Image: source:[^\]]*?(\d+)\.[a-z0-9]+\]/gi)) ns.add(Number(m[1]));
  const refs = [...ns].sort((a, b) => a - b).map((n) => ({ kind: 'cache', n }));
  const cleaned = raw.replace(/\[Image: source:[^\]]*\]/gi, '').trim();
  return { refs, text: cleaned };
}

// Compact usage suffix for a task-notification chip: " · 22.3k tok · 6 tools · 119s".
function formatTaskUsage(usage) {
  if (!usage) return '';
  const parts = [];
  if (usage.subagentTokens != null) {
    const t = usage.subagentTokens;
    const tok = t >= 1000 ? `${(t / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(t);
    parts.push(`${tok} tok`);
  }
  if (usage.toolUses != null) parts.push(usage.toolUses + (usage.toolUses === 1 ? ' tool' : ' tools'));
  if (usage.durationMs != null) parts.push(`${Math.round(usage.durationMs / 1000)}s`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

// Raw per-agent cost for the agent modal's chips plus the formatted one-liner for
// the inline message row. Null when the source carried no numbers.
function agentUsageEntry(subagentTokens, toolUses, durationMs) {
  const usage = {};
  if (subagentTokens != null) usage.tokens = subagentTokens;
  if (toolUses != null) usage.tools = toolUses;
  if (durationMs != null) usage.durationMs = durationMs;
  if (!Object.keys(usage).length) return null;
  return { usage, usageText: formatTaskUsage({ subagentTokens, toolUses, durationMs }) };
}

function pushUserMessage(messages, text, timestamp, sysLabel, extras) {
  if (sysLabel === '__skip__') return;
  let safeText = text || '';
  let label = sysLabel;
  // Background-task completion notifications are harness events, not user input.
  // Whichever path delivered them (normal type:'user' or a queued enqueue), show
  // a rich summary+usage chip and surface the agent's actual result as the body —
  // never the raw <task-notification> envelope under a person icon.
  const notif = parseTaskNotification(safeText);
  if (notif) {
    const base = notif.summary || (notif.status ? `Background task ${notif.status}` : 'Background task notification');
    label = base + formatTaskUsage(notif.usage);
    safeText = notif.result || base;
  }
  // A subagent, teammate or peer session handing work back through SendMessage is
  // also model output, not user input. Callers on the `origin` path pass the parts
  // ready-made; the text paths (type:'user', queued enqueue) parse the envelope.
  const agentMsg = extras?.agent || (notif ? null : parseAgentMessage(safeText));
  if (agentMsg) {
    label = agentMsg.label;
    safeText = agentMsg.body;
  }
  const truncated = safeText.length > USER_TEXT_MAX;
  const msg = {
    type: 'user',
    text: truncated ? `${safeText.slice(0, USER_TEXT_MAX)}...` : safeText,
    fullText: truncated ? safeText : null,
    timestamp,
    ...(label && { systemLabel: label })
  };
  // Tag task-notifications so the client can group the duplicate enqueue+delivered
  // pair (same taskId) and join the agent type from the agents list.
  if (notif) {
    msg.taskNotification = true;
    if (notif.taskId) msg.taskId = notif.taskId;
    if (notif.status) msg.taskStatus = notif.status;
  }
  if (agentMsg) {
    msg.agentMessage = true;
    if (agentMsg.from) msg.agentFrom = agentMsg.from;
  }
  if (extras) {
    if (extras.uuid) msg.uuid = extras.uuid;
    if (extras.images?.length) msg.images = extras.images;
    if (extras.toolResultRefs?.length) msg.toolResultRefs = extras.toolResultRefs;
    if (extras.queued) msg.queued = true;
  }
  // One agent message reaches the log twice: the queued enqueue record and the
  // delivered one right after it. Keep the first and drop the twin here, so no
  // renderer has to know about the double write.
  if (agentMsg) {
    const prev = messages[messages.length - 1];
    if (prev?.agentMessage && (prev.agentFrom || null) === (msg.agentFrom || null) && prev.text === msg.text) {
      if (!msg.queued) delete prev.queued;
      return;
    }
  }
  messages.push(msg);
}

// Cache: jsonlPath -> { ino, mtimeMs, scannedUpTo, customTitle, agentName }
// Only re-scan the new bytes appended since last scan
const customTitleCache = new Map();
let sessionCacheDirty = false;

// An entry scanned up to `scannedUpTo` still describes the file when the file is the same one
// and has only grown. A same-size file with a new mtime was rewritten in place. The entries
// outlive the process (exportSessionCaches), so this is the only check between two runs.
function sameFileGrown(cached, stat) {
  if (!cached || cached.ino !== stat.ino || stat.size < cached.scannedUpTo) return false;
  return stat.size > cached.scannedUpTo || cached.mtimeMs === stat.mtimeMs;
}
const CUSTOM_TITLE_SCAN_SIZE = 1048576; // 1MB max scan on first read

// Returns the best title found, in priority order:
//   custom-title (user override) > ai-title > agent-name
// Background-session JSONLs created by the "claude agents" feature only emit
// ai-title/agent-name records; older sessions emit custom-title.
const TITLE_MARKER_TEXT = ['"custom-title"', '"ai-title"', '"agent-name"'];
const TITLE_MARKERS = TITLE_MARKER_TEXT.map((m) => Buffer.from(m));
const hasTitleMarker = (s) => TITLE_MARKER_TEXT.some((m) => s.includes(m));

// agentName is the session's peer name (the name SendMessage addresses), kept apart from the
// merged title so a task owner can be matched to its session after the session ends.
const NO_TITLES = { customTitle: null, agentName: null };

function extractTitlesFromText(text) {
  if (!hasTitleMarker(text)) return NO_TITLES;
  const lines = text.split('\n');
  let customTitle = null;
  let aiTitle = null;
  let agentName = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!hasTitleMarker(line) || (customTitle && !line.includes('"agent-name"'))) continue;
    try {
      const data = JSON.parse(line);
      if (!customTitle && data.type === 'custom-title' && data.customTitle && !data.customTitle.startsWith('<')) {
        customTitle = data.customTitle;
      } else if (!aiTitle && data.type === 'ai-title' && data.aiTitle && !data.aiTitle.startsWith('<')) {
        aiTitle = data.aiTitle;
      } else if (!agentName && data.type === 'agent-name' && data.agentName && !data.agentName.startsWith('<')) {
        agentName = data.agentName;
      }
      if (customTitle && agentName) break;
    } catch {}
  }
  return { customTitle: customTitle || aiTitle || agentName || null, agentName };
}

// Same answer as extractTitlesFromText(buf.toString('utf8')): that function only looks at
// lines holding a marker, and a line cut at \n decodes the same alone as inside the chunk.
function extractTitlesFromBuffer(buf) {
  const starts = new Set();
  for (const m of TITLE_MARKERS) {
    for (let i = buf.indexOf(m); i !== -1; i = buf.indexOf(m, i + m.length)) {
      starts.add(buf.lastIndexOf(0x0a, i) + 1);
    }
  }
  if (!starts.size) return NO_TITLES;
  const lines = [...starts]
    .sort((a, b) => a - b)
    .map((s) => {
      const e = buf.indexOf(0x0a, s);
      return buf.toString('utf8', s, e === -1 ? buf.length : e);
    });
  return extractTitlesFromText(lines.join('\n'));
}

const pickTitles = ({ customTitle, agentName }) => ({ customTitle, agentName });

function readTitles(jsonlPath, existingStat) {
  try {
    const stat = existingStat || statSync(jsonlPath);
    const prev = customTitleCache.get(jsonlPath);
    const cached = sameFileGrown(prev, stat) ? prev : null;

    if (cached && cached.scannedUpTo === stat.size) return cached;

    let customTitle = cached?.customTitle || null;
    let agentName = cached?.agentName || null;
    const fd = fs.openSync(jsonlPath, 'r');

    if (cached) {
      const len = stat.size - cached.scannedUpTo;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, cached.scannedUpTo);
        const found = extractTitlesFromBuffer(buf);
        customTitle = found.customTitle || customTitle;
        agentName = found.agentName || agentName;
      }
    } else {
      // The last chunk holding a title wins, so scan from the end and stop at the first hit.
      const CHUNK = CUSTOM_TITLE_SCAN_SIZE;
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, stat.size));
      for (let offset = Math.floor((stat.size - 1) / CHUNK) * CHUNK; offset >= 0 && !customTitle; offset -= CHUNK) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, stat.size - offset), offset);
        ({ customTitle, agentName } = extractTitlesFromBuffer(buf.subarray(0, n)));
      }
    }

    fs.closeSync(fd);
    const entry = { ino: stat.ino, mtimeMs: stat.mtimeMs, scannedUpTo: stat.size, customTitle, agentName };
    customTitleCache.set(jsonlPath, entry);
    sessionCacheDirty = true;
    return entry;
  } catch {
    return NO_TITLES;
  }
}

const SCRAPE_CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const SCRAPE_SLUG_RE = /"slug"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const SCRAPE_GITBRANCH_RE = /"gitBranch"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function scrapeScalarFromBlob(blob, re) {
  const m = blob.match(re);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
}

const sessionInfoCache = new Map();
const SESSION_INFO_CACHE_MAX = 2000;

// A prompt line carries the mode it was sent in. After a Shift+Tab, Claude Code writes an
// auto_mode / auto_mode_exit attachment with the next tool result, and later rewrites a
// permission-mode line with the live mode, often tens of seconds after.
const modeOf = (data) => {
  if (data.type === 'attachment') {
    const t = data.attachment?.type;
    return t === 'auto_mode' ? 'auto' : t === 'auto_mode_exit' ? 'default' : null;
  }
  return (data.type === 'user' || data.type === 'permission-mode') && data.permissionMode || null;
};

const isMainReply = (data) =>
  data.type === 'assistant' && !data.isSidechain && data.message?.usage && data.message.model !== '<synthetic>';

// The TTL of the last prompt-cache write, from the API's 5m/1h split of cache_creation.
const cacheTtlOf = (data) => {
  const cc = isMainReply(data) && data.message.usage.cache_creation;
  if (!cc) return null;
  return cc.ephemeral_1h_input_tokens > 0 ? '1h' : cc.ephemeral_5m_input_tokens > 0 ? '5m' : null;
};

// Copy of displayName in the plugin's hooks/context.ts; Node cannot import the mod.
function modelDisplayName(model) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model || '');
  if (!m) return model || null;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
}

const isMainUser = (data) => data.type === 'user' && !data.isSidechain && data.timestamp;

// `at` is when the request went out: the reply's own lines land seconds to tens of seconds later,
// which would make the cache countdown run long.
const replyOf = (data, requestTs) => {
  const u = data.message.usage;
  return {
    at: Date.parse(requestTs || data.timestamp) || null,
    model: data.message.model || null,
    usage: {
      input_tokens: u.input_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      output_tokens: u.output_tokens || 0,
    },
  };
};
// After a compaction the old usage overstates what the next request writes.
const withoutUsage = (reply) => reply && { ...reply, usage: null };

// gitBranch in the JSONL is pinned to the launch-time repo by Claude Code
// and goes stale once cwd shifts (Bash `cd`, submodule). Callers needing the
// live branch must resolve it from cwd separately. Cache is reset on inode
// change or truncation (size < scannedUpTo).

function readSessionInfoFromJsonl(jsonlPath) {
  const result = { slug: null, projectPath: null, cwd: null, gitBranch: null, customTitle: null, agentName: null, logicalParentUuid: null, compactBoundaryUuid: null, permissionMode: null, cacheTtl: null, lastReply: null };
  let stat;
  let fd;
  try {
    stat = statSync(jsonlPath);
  } catch (_) {
    return result;
  }

  const cached = sessionInfoCache.get(jsonlPath);
  const canIncrement = sameFileGrown(cached, stat);

  if (canIncrement && stat.size === cached.scannedUpTo) {
    return {
      slug: cached.slug,
      projectPath: cached.projectPath,
      cwd: cached.cwd,
      gitBranch: cached.gitBranch,
      logicalParentUuid: cached.logicalParentUuid || null,
      compactBoundaryUuid: cached.compactBoundaryUuid || null,
      permissionMode: cached.permissionMode || null,
      cacheTtl: cached.cacheTtl || null,
      lastReply: cached.lastReply || null,
      ...pickTitles(readTitles(jsonlPath, stat))
    };
  }

  if (canIncrement) {
    result.slug = cached.slug;
    result.projectPath = cached.projectPath;
    result.cwd = cached.cwd;
    result.gitBranch = cached.gitBranch;
    result.logicalParentUuid = cached.logicalParentUuid || null;
    result.compactBoundaryUuid = cached.compactBoundaryUuid || null;
    result.permissionMode = cached.permissionMode || null;
    result.cacheTtl = cached.cacheTtl || null;
    result.lastReply = cached.lastReply || null;
  }

  let lastCwdSeen = result.cwd;
  let lastUserTs = canIncrement ? cached.lastUserTs || null : null;
  const applyLine = (line) => {
    try {
      const data = JSON.parse(line);
      if (data.slug && !result.slug) result.slug = data.slug;
      if (data.cwd) {
        if (!result.projectPath) result.projectPath = data.cwd;
        lastCwdSeen = data.cwd;
      }
      if (data.gitBranch) result.gitBranch = data.gitBranch;
      const mode = modeOf(data);
      if (mode) result.permissionMode = mode;
      const ttl = cacheTtlOf(data);
      if (ttl) result.cacheTtl = ttl;
      if (isMainUser(data)) lastUserTs = data.timestamp;
      else if (isMainReply(data)) result.lastReply = replyOf(data, lastUserTs);
      if (data.subtype === 'compact_boundary') result.lastReply = withoutUsage(result.lastReply);
      if (data.subtype === 'compact_boundary' && data.logicalParentUuid && !result.logicalParentUuid) {
        result.logicalParentUuid = data.logicalParentUuid;
        // The boundary record's own uuid: a fork copies it verbatim from the
        // parent, a real compact continuation writes a fresh one. Callers use
        // its presence in the parent JSONL to tell the two apart.
        result.compactBoundaryUuid = data.uuid || null;
      }
    } catch {}
  };

  const CHUNK_SIZE = 16384;
  const TAIL_SIZE = 16384;
  const HEAD_MAX = 1048576;
  const BACK_CHUNK = 65536;
  const BACK_MAX = 2097152;
  let scannedUpTo = canIncrement ? cached.scannedUpTo : 0;

  try {
    fd = fs.openSync(jsonlPath, 'r');

    if (canIncrement) {
      // Each conversational JSONL line carries `cwd`, so a mid-session `cd`
      // surfaces in any tail window — we don't need the whole delta.
      const DELTA_MAX = 1048576;
      const deltaLen = stat.size - cached.scannedUpTo;
      if (deltaLen > 0) {
        const readLen = Math.min(deltaLen, DELTA_MAX);
        const readStart = stat.size - readLen;
        const buf = Buffer.alloc(readLen);
        const n = fs.readSync(fd, buf, 0, readLen, readStart);
        if (n > 0) {
          const text = buf.toString('utf8', 0, n);
          const lastNl = text.lastIndexOf('\n');
          const complete = lastNl >= 0 ? text.slice(0, lastNl) : '';
          const lines = complete.split('\n');
          for (const line of lines) if (line) applyLine(line);
        }
        scannedUpTo = stat.size;
      }
    } else {
      const decoder = new StringDecoder('utf8');
      const buf = Buffer.alloc(CHUNK_SIZE);
      let leftover = '';
      let offset = 0;
      while (offset < stat.size && offset < HEAD_MAX) {
        const len = Math.min(CHUNK_SIZE, stat.size - offset);
        const n = fs.readSync(fd, buf, 0, len, offset);
        if (n === 0) break;
        offset += n;
        const text = leftover + decoder.write(n === buf.length ? buf : buf.slice(0, n));
        const lines = text.split('\n');
        leftover = lines.pop();
        for (const line of lines) applyLine(line);
      }
      leftover += decoder.end();
      if (leftover) applyLine(leftover);
      // Oversized first line (e.g. multi-MB inline image) — scrape scalars so
      // we don't fall through and pick a mid-session cwd as projectPath.
      if (!result.projectPath && leftover && leftover.length > CHUNK_SIZE) {
        const scrapedCwd = scrapeScalarFromBlob(leftover, SCRAPE_CWD_RE);
        if (scrapedCwd) { result.projectPath = scrapedCwd; lastCwdSeen = scrapedCwd; }
        if (!result.slug) result.slug = scrapeScalarFromBlob(leftover, SCRAPE_SLUG_RE);
        if (!result.gitBranch) result.gitBranch = scrapeScalarFromBlob(leftover, SCRAPE_GITBRANCH_RE);
      }

      // Tail scan catches late cwd switches past HEAD_MAX. projectPath stays
      // anchored to the earliest cwd — it is never overwritten here.
      // The first window is TAIL_SIZE. A tail of one long line (11% of transcripts over 1 MB)
      // holds no reply, so it reads further back in BACK_CHUNK steps until it finds one.
      if (stat.size > offset) {
        let latestTailCwd = null;
        let latestTailMode = null;
        let latestTailTtl = null;
        let tailReply = null;
        let tailRequestTs = null;
        let compactedAfterReply = false;
        let latestTailUserTs = null;
        // Filled from the end; [start, end) holds read bytes not parsed yet.
        const window = Buffer.allocUnsafe(Math.min(BACK_MAX, stat.size - offset));
        let start = window.length;
        let end = window.length;
        let pos = stat.size;
        while (!(tailReply && tailRequestTs) && start > 0) {
          const len = Math.min(pos === stat.size ? TAIL_SIZE : BACK_CHUNK, start);
          start -= len;
          pos -= len;
          if (fs.readSync(fd, window, start, len, pos) < len) break;
          let from = start;
          if (pos > offset) {
            // Bytes before the first newline may be the end of a line that starts further back.
            const nl = window.subarray(start, start + len).indexOf(10);
            if (nl < 0) continue;
            from = start + nl + 1;
          }
          const lines = window.toString('utf8', from, end).split('\n');
          end = from - 1;
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const data = JSON.parse(lines[i]);
              if (!latestTailTtl) latestTailTtl = cacheTtlOf(data);
              if (!result.slug && data.slug) result.slug = data.slug;
              if (!result.projectPath && data.cwd) result.projectPath = data.cwd;
              if (!result.gitBranch && data.gitBranch) result.gitBranch = data.gitBranch;
              if (!latestTailCwd && data.cwd) latestTailCwd = data.cwd;
              if (!latestTailMode) latestTailMode = modeOf(data);
              if (!latestTailUserTs && isMainUser(data)) latestTailUserTs = data.timestamp;
              if (!tailReply) {
                if (data.subtype === 'compact_boundary') compactedAfterReply = true;
                else if (isMainReply(data)) tailReply = data;
              } else if (!tailRequestTs && isMainUser(data)) tailRequestTs = data.timestamp;
              if (latestTailCwd && latestTailMode && latestTailTtl && tailRequestTs && result.slug && result.projectPath && result.gitBranch) break;
            } catch {}
          }
        }
        const reachedHead = pos <= offset;
        if (latestTailCwd) lastCwdSeen = latestTailCwd;
        if (latestTailMode) result.permissionMode = latestTailMode;
        if (latestTailTtl) result.cacheTtl = latestTailTtl;
        if (latestTailUserTs || !reachedHead) lastUserTs = latestTailUserTs;
        if (tailReply) {
          const reply = replyOf(tailReply, tailRequestTs);
          result.lastReply = compactedAfterReply ? withoutUsage(reply) : reply;
        } else if (!reachedHead) {
          // No reply in the last BACK_MAX bytes: the head's reply is far older than any TTL.
          result.lastReply = null;
          result.cacheTtl = null;
        }
      }
      scannedUpTo = stat.size;
    }
  } catch {
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }

  result.cwd = lastCwdSeen;

  if (stat) {
    sessionInfoCache.set(jsonlPath, {
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      scannedUpTo,
      slug: result.slug,
      projectPath: result.projectPath,
      gitBranch: result.gitBranch,
      cwd: result.cwd,
      logicalParentUuid: result.logicalParentUuid,
      compactBoundaryUuid: result.compactBoundaryUuid,
      permissionMode: result.permissionMode,
      cacheTtl: result.cacheTtl,
      lastReply: result.lastReply,
      lastUserTs
    });
    if (sessionInfoCache.size > SESSION_INFO_CACHE_MAX) {
      const firstKey = sessionInfoCache.keys().next().value;
      sessionInfoCache.delete(firstKey);
    }
    sessionCacheDirty = true;
  }
  Object.assign(result, pickTitles(readTitles(jsonlPath, stat)));
  return result;
}

// Counts the transcripts of one project folder that were read since start (or loaded from the
// session cache). Entries of deleted files stay until the next save, so a deletion does not
// lower the count.
function countTranscriptsBornBefore(dir, birthtimeMs) {
  let n = 0;
  for (const [p, e] of sessionInfoCache) if (e.birthtimeMs < birthtimeMs && path.dirname(p) === dir) n++;
  return n;
}

// Cache: jsonlPath -> { ino, size, mtimeMs }, the transcript as it last grew.
// Claude Code, `claude --resume` and backup tools set a transcript's mtime without writing
// to it (#50), so only a file that grew, shrank or was replaced counts as activity.
const logActivityCache = new Map();

function transcriptActivityMs(jsonlPath, stat) {
  const prev = logActivityCache.get(jsonlPath);
  if (prev && prev.ino === stat.ino && prev.size === stat.size) return prev.mtimeMs;
  logActivityCache.delete(jsonlPath);
  logActivityCache.set(jsonlPath, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
  if (logActivityCache.size > SESSION_INFO_CACHE_MAX) logActivityCache.delete(logActivityCache.keys().next().value);
  sessionCacheDirty = true;
  return stat.mtimeMs;
}

const sessionCachesDirty = () => sessionCacheDirty;

// Snapshot of the per-transcript caches for lib/session-cache.js. Entries of deleted
// transcripts are left out, so the snapshot never holds more than the live set.
function exportSessionCaches() {
  sessionCacheDirty = false;
  const livePaths = new Set([...sessionInfoCache.keys(), ...customTitleCache.keys(), ...logActivityCache.keys()]);
  for (const p of livePaths) if (!fs.existsSync(p)) livePaths.delete(p);
  const live = (map) => [...map].filter(([p]) => livePaths.has(p));
  return { info: live(sessionInfoCache), titles: live(customTitleCache), activity: live(logActivityCache) };
}

function importSessionCaches(snapshot) {
  const num = (v) => typeof v === 'number';
  const scanned = (e) => num(e.ino) && num(e.scannedUpTo) && num(e.mtimeMs);
  const grown = (e) => num(e.ino) && num(e.size) && num(e.mtimeMs);
  const load = (map, entries, valid) => {
    if (!Array.isArray(entries)) return;
    for (const pair of entries) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !pair[1] || typeof pair[1] !== 'object' || !valid(pair[1])) continue;
      map.set(pair[0], pair[1]);
    }
  };
  load(sessionInfoCache, snapshot?.info?.slice(-SESSION_INFO_CACHE_MAX), scanned);
  load(customTitleCache, snapshot?.titles?.slice(-SESSION_INFO_CACHE_MAX), scanned);
  load(logActivityCache, snapshot?.activity?.slice(-SESSION_INFO_CACHE_MAX), grown);
}

// Background-task completion records arrive as a user message whose content is a
// <task-notification> envelope. Rendering the raw text leaks the tag values as a
// run-on line (task-id + tool-use-id + output-file path) plus the <usage> numbers
// mashed together (subagent_tokens|tool_uses|duration_ms with tags stripped).
// Parse the envelope into structured fields so the UI can show just the agent's
// result and a clean metadata line instead of the raw wrapper. Returns null when
// the text is not a task-notification.
function parseTaskNotification(text) {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return null;
  // Metadata fields are machine-generated single-line values that appear before
  // the free-form <result>, so first-match non-greedy is safe for them.
  const pick = (tag) => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : null;
  };
  // <result> and <usage> carry UNescaped agent text that can itself contain
  // literal "</result>" / "<usage>" (e.g. an agent describing this very format).
  // The real closing tags are always the LAST occurrence, so match greedily and
  // take the last <usage> block to avoid truncating on embedded markers.
  const lastBlock = (tag) => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*)<\\/${tag}>`));
    return m ? m[1] : null;
  };
  let usage = null;
  const usageRaw = lastBlock('usage');
  if (usageRaw != null) {
    const uNum = (tag) => {
      // Take the LAST match: the real <usage> wins over any example block an agent
      // embedded in its result.
      const last = [...usageRaw.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g'))].at(-1);
      if (!last) return null;
      const n = Number(last[1]);
      return Number.isFinite(n) ? n : null;
    };
    usage = {
      subagentTokens: uNum('subagent_tokens'),
      toolUses: uNum('tool_uses'),
      durationMs: uNum('duration_ms')
    };
  }
  const resultRaw = lastBlock('result');
  return {
    taskId: pick('task-id'),
    toolUseId: pick('tool-use-id'),
    outputFile: pick('output-file'),
    status: pick('status'),
    summary: pick('summary'),
    result: resultRaw != null ? resultRaw.trim() : null,
    usage
  };
}

// A message another agent sent into this session (a subagent hand-back, a teammate
// or a peer session using SendMessage) is model output, not user input. Turn the
// sender and the raw body into the chip label plus the body alone, so it never
// renders under a person icon.
function agentMessageParts(from, rawBody, handback) {
  let body = (rawBody || '').trimEnd();
  // A hand-back frames the report with the harness note that it carries no user
  // authority, and indents every line of the report by two spaces so a forged
  // frame at column zero is impossible. Strip the frame and that indent.
  const framed = body.match(/^\[Subagent hand-back\][\s\S]*?report follows:\n([\s\S]*)$/);
  if (framed) body = framed[1].replace(/^ {2}/gm, '').trim();
  const handBack = !!framed || !!handback;
  const kind = handBack ? 'Subagent hand-back' : 'Agent message';
  // Harness agent ids are long hex; a named sender ("code-review") is shown whole.
  const short = from && /^[0-9a-f]{12,}$/i.test(from) ? from.slice(0, 8) : from;
  return { from: from || null, handBack, label: short ? `${kind} · ${short}` : kind, body };
}

// The text delivery paths carry the body inside an <agent-message from="..."> envelope,
// with the harness notes outside it. The envelope must open the message (after the
// harness preamble, if any): prose that merely quotes the tag is a user message.
// The body is unescaped agent text that can quote the envelope it describes, so the
// real closing tag is the last one.
function parseAgentMessage(text) {
  if (typeof text !== 'string' || !text.includes('<agent-message')) return null;
  const start = text.indexOf('<agent-message');
  const preamble = text.slice(0, start).trim();
  if (preamble && !/^Another Claude session sent a message[^\n]*:$/.test(preamble)) return null;
  const gt = text.indexOf('>', start);
  const end = text.lastIndexOf('</agent-message>');
  if (gt === -1 || end < gt) return null;
  const from = (text.slice(start, gt).match(/from="([^"]*)"/) || [])[1] || null;
  let bodyStart = gt + 1;
  while (text[bodyStart] === '\n') bodyStart++;
  return agentMessageParts(from, text.slice(bodyStart, end));
}

function getSystemMessageLabel(text) {
  const taskMatch = text.match(/<summary>([^<]+)<\/summary>/);
  if (taskMatch) return taskMatch[1].trim();
  if (text.includes('<task-notification>')) {
    const statusMatch = text.match(/<status>([^<]+)<\/status>/);
    return statusMatch ? `Background task ${statusMatch[1]}` : 'Background task notification';
  }
  // The "Compacted (ctrl+o…)" stdout echo is redundant with the isCompactSummary
  // chip (modern Claude Code stores the summary inline). Skipping it lets the one
  // summary-bearing chip stand alone instead of trailing a bare marker that the
  // resume prompt sorts away from, preventing collapse.
  if (text.includes('<local-command-stdout>') && text.includes('Compacted')) return '__skip__';
  if (text.includes('<local-command-stdout>')) return 'Command output';
  if (text.includes('<local-command-caveat>')) return 'System notification';
  if (text.includes('.output completed') && text.includes('Background command')) return 'Background task completed';
  if (text.startsWith('This session is being continued from a previous conversation')) return '__skip__';
  if (text.includes('<command-name>/clear</command-name>')) return '__skip__';
  // The /compact trigger record is redundant: the boundary stdout + isCompactSummary
  // record already render as one expandable "Compacted" chip. Skip it so the chip
  // collapses cleanly instead of leaving a separate marker where the user typed it.
  if (text.includes('<command-name>/compact</command-name>')) return '__skip__';
  return null;
}

function readRecentMessages(jsonlPath, limit = 10) {
  let fd;
  try {
    const stat = statSync(jsonlPath);
    fd = fs.openSync(jsonlPath, 'r');
    const messages = [];
    const toolResults = new Map();
    const toolResultExtras = new Map();
    const toolResultImageCounts = new Map();
    let readSize = Math.min(65536, stat.size);

    while (messages.length < limit) {
      readSize = Math.min(readSize, stat.size);
      const start = Math.max(0, stat.size - readSize);
      const bufSize = readSize;
      const buf = Buffer.alloc(bufSize);
      fs.readSync(fd, buf, 0, bufSize, start);

      const text = buf.toString('utf8');
      const firstNewline = text.indexOf('\n');
      const clean = firstNewline >= 0 ? text.substring(firstNewline + 1) : text;

      messages.length = 0;
      toolResults.clear();
      toolResultExtras.clear();
      toolResultImageCounts.clear();
      for (const line of clean.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'assistant' && obj.message?.content && Array.isArray(obj.message.content)) {
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text) {
                const truncated = block.text.length > 500;
                messages.push({
                  type: 'assistant',
                  text: truncated ? `${block.text.slice(0, 500)}...` : block.text,
                  fullText: truncated ? block.text : null,
                  timestamp: obj.timestamp,
                  model: obj.message.model || null
                });
              } else if (block.type === 'tool_use') {
                let detail = null;
                let fullDetail = null;
                let inp = null;
                if (block.input) {
                  inp = typeof block.input === 'string' ? (() => { try { return JSON.parse(block.input); } catch(_) { return {}; } })() : block.input;
                  if (inp.file_path) { detail = inp.file_path.replace(/^.*[/\\]/, ''); fullDetail = inp.file_path; }
                  else if (inp.command) { detail = inp.command.length > 80 ? `${inp.command.slice(0, 80)}...` : inp.command; fullDetail = inp.command; }
                  else if (inp.pattern) { detail = inp.pattern; fullDetail = inp.pattern; }
                  else if (inp.query) { detail = inp.query; fullDetail = inp.query; }
                  else if (inp.url) { detail = inp.url.length > 80 ? `${inp.url.slice(0, 80)}...` : inp.url; fullDetail = inp.url; }
                  else if (inp.skill) { const s = inp.skill + (typeof inp.args === 'string' ? ` ${inp.args}` : ''); detail = s.length > 80 ? `${s.slice(0, 80)}...` : s; fullDetail = s; }
                  else if (inp.questions && Array.isArray(inp.questions)) {
                    const parts = inp.questions.map(q => (q.header ? `${q.header}: ` : '') + q.question);
                    const s = parts.join(' | ');
                    detail = s.length > 80 ? `${s.slice(0, 80)}...` : s;
                    fullDetail = inp.questions.map(q => {
                      let text = (q.header ? `[${q.header}] ` : '') + q.question;
                      if (q.options) text += `\n\n${q.options.map((o, j) => `  ${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')}`;
                      return text;
                    }).join('\n\n');
                  }
                  else if (inp.to) {
                    const proto = inp.message && typeof inp.message === 'object' ? inp.message : null;
                    if (proto?.type === 'shutdown_request') {
                      detail = `→ ${inp.to}: shutdown request${proto.reason ? ` (${proto.reason})` : ''}`;
                    } else if (proto?.type === 'shutdown_response') {
                      detail = `→ ${inp.to}: ${proto.approve ? 'shutdown approved' : 'shutdown rejected'}`;
                    } else if (proto?.type === 'plan_approval_response') {
                      detail = `→ ${inp.to}: ${proto.approve ? 'plan approved' : 'plan rejected'}`;
                    } else {
                      detail = `→ ${inp.to}${inp.summary ? `: ${inp.summary}` : ''}`;
                    }
                    if (detail.length > 80) detail = `${detail.slice(0, 80)}...`;
                    fullDetail = typeof inp.message === 'string' ? inp.message : JSON.stringify(inp.message);
                  }
                  else if (inp.plan) {
                    const titleMatch = inp.plan.match(/^#\s+(.+)/m);
                    detail = titleMatch ? titleMatch[1] : 'Plan';
                    fullDetail = detail;
                  }
                  else if (inp.description) { detail = inp.description; fullDetail = inp.description; }
                }
                const params = {};
                if (inp) {
                  if (block.name === 'Edit') {
                    if (inp.file_path) params.file_path = inp.file_path;
                    if (inp.old_string) params.old_string = inp.old_string;
                    if (inp.new_string) params.new_string = inp.new_string;
                    if (inp.replace_all) params.replace_all = true;
                  } else if (block.name === 'Write') {
                    if (inp.file_path) params.file_path = inp.file_path;
                    if (inp.content) {
                      if (inp.content.length > TOOL_RESULT_MAX) {
                        params.content = `${inp.content.slice(0, TOOL_RESULT_MAX)}\n... (truncated)`;
                        params.contentFull = inp.content;
                      } else {
                        params.content = inp.content;
                      }
                    }
                  } else if (block.name === 'Grep') {
                    if (inp.path) params.path = inp.path;
                    if (inp.glob) params.glob = inp.glob;
                    if (inp.type) params.type = inp.type;
                    if (inp.output_mode) params.output_mode = inp.output_mode;
                    if (inp['-i']) params.case_insensitive = true;
                    if (inp['-A']) params.after = inp['-A'];
                    if (inp['-B']) params.before = inp['-B'];
                    if (inp['-C'] || inp.context) params.context = inp['-C'] || inp.context;
                    if (inp.multiline) params.multiline = true;
                    if (inp.head_limit) params.head_limit = inp.head_limit;
                  } else if (block.name === 'Glob') {
                    if (inp.path) params.path = inp.path;
                  } else if (block.name === 'Bash') {
                    if (inp.timeout) params.timeout = inp.timeout;
                    if (inp.run_in_background) params.background = true;
                  } else if (block.name === 'Read') {
                    if (inp.offset) params.offset = inp.offset;
                    if (inp.limit) params.limit = inp.limit;
                    if (inp.pages) params.pages = inp.pages;
                  } else if (block.name === 'WebFetch') {
                    if (inp.prompt) params.prompt = inp.prompt;
                  } else if (block.name === 'WebSearch') {
                    if (inp.max_results) params.max_results = inp.max_results;
                    if (inp.allowed_domains) params.allowed_domains = inp.allowed_domains.join(', ');
                    if (inp.blocked_domains) params.blocked_domains = inp.blocked_domains.join(', ');
                  } else if (block.name === 'LSP') {
                    if (inp.operation) params.operation = inp.operation;
                    if (inp.filePath) params.filePath = inp.filePath;
                    if (inp.line != null) params.line = inp.line;
                    if (inp.character != null) params.character = inp.character;
                  } else if (block.name === 'ToolSearch') {
                    if (inp.max_results) params.max_results = inp.max_results;
                  } else if (block.name === 'TaskCreate') {
                    if (inp.subject) params.subject = inp.subject;
                  } else if (block.name === 'TaskUpdate') {
                    if (inp.taskId) params.taskId = `#${inp.taskId}`;
                    if (inp.status) params.status = inp.status;
                  } else if (block.name === 'NotebookEdit') {
                    if (inp.command) params.command = inp.command;
                    if (inp.cell_type) params.cell_type = inp.cell_type;
                  } else if (block.name === 'Agent') {
                    if (inp.mode) params.mode = inp.mode;
                    if (inp.model) params.model = inp.model;
                    if (inp.run_in_background) params.background = true;
                    if (inp.isolation) params.isolation = inp.isolation;
                  } else if (block.name === 'ExitPlanMode') {
                    if (inp.plan) params.plan = inp.plan;
                    if (inp.planFilePath) params.planFilePath = inp.planFilePath;
                  } else if (block.name === 'SendMessage') {
                    if (inp.to) params.to = inp.to;
                    if (inp.summary) params.summary = inp.summary;
                    if (inp.message && typeof inp.message === 'object') {
                      params.protocol = inp.message;
                    }
                  } else {
                    // Passthrough for unknown tools (e.g. MCP `mcp__...`) so the detail panel
                    // can render args instead of "No details". Truncate large strings to bound
                    // wire/cache size, matching the Write `content` cap above.
                    for (const [k, v] of Object.entries(inp)) {
                      if (k === 'description' || v == null) continue;
                      if (typeof v === 'string' && v.length > TOOL_RESULT_MAX) {
                        params[k] = `${v.slice(0, TOOL_RESULT_MAX)}\n... (truncated)`;
                        params[`${k}Full`] = v;
                      } else {
                        params[k] = v;
                      }
                    }
                  }
                }
                const msg = {
                  type: 'tool_use',
                  tool: block.name,
                  detail,
                  fullDetail: fullDetail !== detail ? fullDetail : null,
                  description: inp?.description || null,
                  params: Object.keys(params).length > 0 ? params : null,
                  timestamp: obj.timestamp
                };
                if (block.id) msg.toolUseId = block.id;
                if (block.name === 'Agent') {
                  if (inp) {
                    msg.agentType = inp.subagent_type || null;
                    if (inp.prompt) msg.agentPrompt = inp.prompt;
                  }
                }
                messages.push(msg);
              }
            }
          } else if (obj.type === 'user' && obj.origin?.kind === 'peer') {
            // Claude Code >= 2.1 files the delivered copy as isMeta (dropped by the
            // branch below) and repeats the envelope's fields on `origin`. That
            // record is always written; the queued enqueue is not, so read it from
            // here and let pushUserMessage drop whichever twin arrives second.
            pushUserMessage(messages, '', obj.timestamp, null, {
              uuid: obj.uuid,
              agent: agentMessageParts(obj.origin.from, obj.origin.body, obj.origin.handback)
            });
          } else if (obj.type === 'user' && obj.message?.role === 'user' && !obj.isMeta) {
            if (obj.isCompactSummary) {
              // Surface the compaction summary as a single expandable "Compacted"
              // chip (compactSummary), never a raw bubble. The boundary marker plus
              // the /compact command/stdout records collapse into this one entry below.
              const raw = typeof obj.message.content === 'string'
                ? obj.message.content
                : Array.isArray(obj.message.content)
                  ? obj.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
                  : '';
              const summary = raw
                .replace(/^This session is being continued[^\n]*\n+(The summary below[^\n]*\n+)?/i, '')
                .trim();
              messages.push({
                type: 'user',
                systemLabel: 'Compacted',
                compactSummary: summary || null,
                timestamp: obj.timestamp
              });
              continue;
            }
            if (typeof obj.message.content === 'string') {
              const t = obj.message.content;
              const tmMatch = t.match(/<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/);
              if (tmMatch) {
                const attrs = tmMatch[1];
                const body = tmMatch[2].trim();
                const getAttr = (name) => (attrs.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || null;
                const tid = getAttr('teammate_id');
                const color = getAttr('color');
                const summary = getAttr('summary');
                let protocol = null;
                try {
                  const j = JSON.parse(body);
                  if (j.type) protocol = j;
                } catch (_) {}
                const isIdle = protocol?.type === 'idle_notification';
                const isProtocol = !!protocol;
                let protocolLabel = null;
                if (protocol) {
                  switch (protocol.type) {
                    case 'idle_notification': protocolLabel = protocol.idleReason || 'idle'; break;
                    case 'task_assignment': protocolLabel = `assigned #${protocol.taskId}: ${protocol.subject || ''}`; break;
                    case 'shutdown_request': protocolLabel = `shutdown: ${protocol.reason || 'requested'}`; break;
                    case 'shutdown_response': protocolLabel = protocol.approve ? 'shutdown approved' : `shutdown rejected: ${protocol.reason || ''}`; break;
                    case 'plan_approval_request': protocolLabel = 'plan approval requested'; break;
                    case 'plan_approval_response': protocolLabel = protocol.approve ? 'plan approved' : `plan rejected: ${protocol.feedback || ''}`; break;
                    case 'teammate_terminated': protocolLabel = protocol.message || 'shut down'; break;
                    default: protocolLabel = protocol.type.replace(/_/g, ' '); break;
                  }
                }
                const truncated = !isProtocol && body.length > 500;
                messages.push({
                  type: 'teammate',
                  teammateId: tid,
                  color,
                  summary,
                  isIdle,
                  isProtocol,
                  protocolType: protocol?.type || null,
                  protocolLabel,
                  protocolData: protocol || null,
                  text: isProtocol ? null : (truncated ? `${body.slice(0, 500)}...` : body),
                  fullText: isProtocol ? null : (truncated ? body : null),
                  timestamp: obj.timestamp
                });
                continue;
              }
              pushUserMessage(messages, t, obj.timestamp, getSystemMessageLabel(t));
            } else if (Array.isArray(obj.message.content)) {
              const texts = [];
              const images = [];
              const toolResultRefs = [];
              obj.message.content.forEach((block, idx) => {
                if (block.type === 'text' && typeof block.text === 'string' && block.text) {
                  texts.push(block.text);
                } else if (block.type === 'image' && block.source && block.source.type === 'base64') {
                  images.push({
                    kind: 'base64',
                    blockIndex: idx,
                    mediaType: block.source.media_type || 'image/png',
                    dataLen: typeof block.source.data === 'string' ? block.source.data.length : 0
                  });
                } else if (block.type === 'tool_result' && block.tool_use_id) {
                  let resultText = '';
                  if (typeof block.content === 'string') {
                    resultText = block.content;
                  } else if (Array.isArray(block.content)) {
                    resultText = block.content
                      .filter(c => c.type === 'text' && c.text)
                      .map(c => c.text)
                      .join('\n');
                    // A Read on an image file (e.g. .png) returns the image as a
                    // base64 block inside the tool_result. Count them so the
                    // renderer can request each by index and show what the agent
                    // saw; the bytes are fetched lazily per image via the endpoint.
                    let imgCount = 0;
                    for (const c of block.content) {
                      if (c && c.type === 'image' && c.source && c.source.type === 'base64') imgCount++;
                    }
                    if (imgCount) toolResultImageCounts.set(block.tool_use_id, imgCount);
                  }
                  if (resultText) {
                    toolResults.set(block.tool_use_id, resultText);
                  }
                  // AskUserQuestion (and similar) stash the structured
                  // {questions, answers} payload at the line-level
                  // obj.toolUseResult — the block.content string is just a
                  // short confirmation. Capture it so the renderer can show
                  // the actual answers + option descriptions.
                  const tur = obj.toolUseResult;
                  let answerPayload = null;
                  if (tur && typeof tur === 'object' && !Array.isArray(tur)
                      && tur.answers && typeof tur.answers === 'object') {
                    answerPayload = {
                      answers: tur.answers,
                      questions: Array.isArray(tur.questions) ? tur.questions : null,
                    };
                    toolResultExtras.set(block.tool_use_id, { answerPayload });
                  }
                  toolResultRefs.push({
                    toolUseId: block.tool_use_id,
                    preview: resultText ? resultText.slice(0, 200) : '',
                    answerPayload,
                  });
                }
              });
              const joined = texts.join('\n').trim();
              // Prefer inline base64 blocks when present; otherwise fall back to
              // file-cache references parsed from the text markers.
              const { refs, text: displayText } = parseImageMarkers(joined);
              const allImages = images.length ? images : refs;
              const hasText = displayText && displayText !== INTERRUPT_MARKER;
              const hasImages = allImages.length > 0;
              if (hasText || hasImages) {
                pushUserMessage(
                  messages,
                  displayText,
                  obj.timestamp,
                  getSystemMessageLabel(displayText),
                  { uuid: obj.uuid, images: allImages, toolResultRefs: hasText ? toolResultRefs : [] }
                );
              }
            }
          } else if (obj.type === 'queue-operation' && obj.operation === 'enqueue') {
            // Queued messages are stored as top-level `content`, not under
            // message.content, and never re-emitted as a type:'user' line.
            // Surface them so the Session Log reflects what the user sent.
            const qt = typeof obj.content === 'string' ? obj.content : '';
            if (qt) {
              const { refs, text } = parseImageMarkers(qt);
              pushUserMessage(messages, text, obj.timestamp, null, { queued: true, images: refs });
            }
          }
        } catch { /* partial line */ }
      }

      if (readSize >= stat.size) break;
      readSize *= 4;
    }

    // Attach tool results to their corresponding tool_use messages.
    // When truncated, ship the full text inline as toolResultFull so the
    // modal expand toggle is instant. The lazy fetch at
    // /api/sessions/:id/tool-result/:toolUseId remains a fallback for older
    // cached payloads that may lack toolResultFull.
    for (const msg of messages) {
      if (msg.type === 'tool_use' && msg.toolUseId && toolResults.has(msg.toolUseId)) {
        const full = toolResults.get(msg.toolUseId);
        const truncated = full.length > TOOL_RESULT_MAX;
        if (truncated) {
          msg.toolResult = `${full.slice(0, TOOL_RESULT_MAX)}\n... (truncated)`;
          msg.toolResultFull = full;
        } else {
          msg.toolResult = full;
        }
        msg.toolResultTruncated = truncated;
      }
      if (msg.type === 'tool_use' && msg.toolUseId && toolResultImageCounts.has(msg.toolUseId)) {
        msg.toolResultImageCount = toolResultImageCounts.get(msg.toolUseId);
      }
      if (msg.type === 'tool_use' && msg.tool === 'AskUserQuestion'
          && msg.toolUseId && toolResultExtras.has(msg.toolUseId)) {
        const extra = toolResultExtras.get(msg.toolUseId);
        if (extra.answerPayload) msg.answerPayload = extra.answerPayload;
      }
    }

    fs.closeSync(fd);
    fd = null;
    messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    for (let i = messages.length - 1; i > 0; i--) {
      if (messages[i].systemLabel === 'Compacted' && messages[i - 1].systemLabel === 'Compacted') {
        // Carry the summary body onto the surviving chip so collapsing the
        // boundary + /compact command + stdout + isCompactSummary records into
        // one entry never drops the expandable summary.
        if (messages[i].compactSummary && !messages[i - 1].compactSummary) {
          messages[i - 1].compactSummary = messages[i].compactSummary;
        }
        messages.splice(i, 1);
      }
    }
    return messages.slice(-limit);
  } catch {
    if (fd) try { fs.closeSync(fd); } catch (_) {}
    return [];
  }
}

async function readFullToolResult(jsonlPath, toolUseId) {
  if (!toolUseId || !jsonlPath || !existsSync(jsonlPath)) return null;
  try {
    for await (const line of readLines(jsonlPath)) {
      if (!line || line.indexOf(toolUseId) === -1) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.message?.content && Array.isArray(obj.message.content)) {
          for (const block of obj.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
              if (typeof block.content === 'string') return block.content;
              if (Array.isArray(block.content)) {
                return block.content
                  .filter((c) => c.type === 'text' && c.text)
                  .map((c) => c.text)
                  .join('\n');
              }
            }
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

async function readUserImage(jsonlPath, msgUuid, blockIndex) {
  if (!msgUuid || !jsonlPath) return null;
  const idx = Number(blockIndex);
  if (!Number.isInteger(idx) || idx < 0) return null;
  try {
    for await (const line of readLines(jsonlPath)) {
      if (!line || line.indexOf(msgUuid) === -1) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.uuid !== msgUuid) continue;
        if (!Array.isArray(obj?.message?.content)) continue;
        const block = obj.message.content[idx];
        if (!block || block.type !== 'image' || !block.source || block.source.type !== 'base64') return null;
        return {
          mediaType: block.source.media_type || 'image/png',
          data: block.source.data
        };
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// Read the Nth base64 image embedded in a tool_result block (e.g. the output of
// a Read on an image file). Scans for the tool_result matching toolUseId.
async function readToolResultImage(jsonlPath, toolUseId, n) {
  if (!toolUseId || !jsonlPath) return null;
  const idx = Number(n);
  if (!Number.isInteger(idx) || idx < 0) return null;
  try {
    for await (const line of readLines(jsonlPath)) {
      if (!line || line.indexOf(toolUseId) === -1) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      const blocks = obj?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue;
        if (!Array.isArray(block.content)) continue;
        const images = block.content.filter(
          (c) => c && c.type === 'image' && c.source && c.source.type === 'base64',
        );
        const img = images[idx];
        if (!img) return null;
        return { mediaType: img.source.media_type || 'image/png', data: img.source.data };
      }
    }
  } catch (_) {}
  return null;
}

const CACHED_IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

// Serve pasted image N from <claudeDir>/image-cache/<sessionId>/. The cached file may
// be any image format, so resolve it by index rather than assuming .png. sessionId
// is validated to a bare id to prevent path traversal.
function readCachedImage(sessionId, n, claudeDir) {
  const idx = Number(n);
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  if (!Number.isInteger(idx) || idx < 0) return null;
  const baseDir = claudeDir || path.join(os.homedir(), '.claude');
  const dir = path.join(baseDir, 'image-cache', sessionId);
  try {
    const match = readdirSync(dir).find((f) => {
      const dot = f.lastIndexOf('.');
      return dot > 0 && f.slice(0, dot) === String(idx) && CACHED_IMAGE_MIME[f.slice(dot + 1).toLowerCase()];
    });
    if (!match) return null;
    const ext = match.slice(match.lastIndexOf('.') + 1).toLowerCase();
    return { mediaType: CACHED_IMAGE_MIME[ext], buffer: readFileSync(path.join(dir, match)) };
  } catch (_) {
    return null;
  }
}

function readMessagesPage(jsonlPath, limit = 10, beforeTimestamp = null) {
  const fetchLimit = limit + 1;
  const applyFilter = beforeTimestamp
    ? (msgs) => msgs.filter((m) => m.timestamp && m.timestamp < beforeTimestamp)
    : (msgs) => msgs;
  let readLimit = Math.max(fetchLimit * 5, 200);
  let allMessages = readRecentMessages(jsonlPath, readLimit);
  let filtered = applyFilter(allMessages);

  while (filtered.length < fetchLimit && allMessages.length === readLimit && readLimit < 10000) {
    readLimit *= 4;
    allMessages = readRecentMessages(jsonlPath, readLimit);
    filtered = applyFilter(allMessages);
  }

  const page = filtered.slice(-fetchLimit);
  const hasMore = page.length > limit;
  return {
    messages: hasMore ? page.slice(1) : page,
    hasMore
  };
}

async function buildSessionDigest(jsonlPath) {
  const map = {};
  const terminated = new Map();
  const rejectedToolUseIds = new Set();
  const promptByToolUseId = {};
  const killedAgentIds = new Set();
  try {
    const re = /"type":"agent_progress"[^}]*"agentId":"([^"]+)"/;
    const parentRe = /"parentToolUseID":"([^"]+)"/;
    const promptRe = /"prompt":"((?:[^"\\]|\\.)*)"/;
    const bgToolIdRe = /"tool_use_id":"([^"]+)"/;
    const bgAgentIdRe = /agentId: ([a-zA-Z0-9_@-]+)/;
    const tmToolIdRe = /"tool_use_id":"([^"]+)"/;
    const tmAgentIdRe = /agent_id: ([a-zA-Z0-9_@-]+)/;
    const taskIdRe = /<task-id>([a-zA-Z0-9_-]+)<\/task-id>/;
    const nameByToolUseId = {};
    const descByToolUseId = {};
    const usageByToolUseId = {};
    for await (const line of readLines(jsonlPath)) {
      // Terminated-teammate detection: check first since cheap substring guards
      if (line.includes('teammate-message') &&
          (line.includes('teammate_terminated') || line.includes('shutdown_response'))) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user') {
            const text = typeof obj.message?.content === 'string' ? obj.message.content : null;
            if (text) {
              const ts = obj.timestamp || null;
              for (const tmMatch of text.matchAll(/<teammate-message\s+[^>]*teammate_id="([^"]+)"[^>]*>([\s\S]*?)<\/teammate-message>/g)) {
                try {
                  const tid = tmMatch[1];
                  const body = tmMatch[2].trim();
                  const protocol = JSON.parse(body);
                  if (protocol.type === 'teammate_terminated') {
                    const name = protocol.from || (protocol.message?.match(/^(\S+)\s/)?.[1]) || tid;
                    if (name !== 'system') terminated.set(name, ts);
                  } else if (protocol.type === 'shutdown_response' && protocol.approve) {
                    const name = protocol.from || tid;
                    if (name !== 'system') terminated.set(name, ts);
                  }
                } catch (_) {}
              }
            }
          }
        } catch (_) {}
      }

      if (line.includes('"agent_progress"')) {
        const agentMatch = re.exec(line);
        const parentMatch = parentRe.exec(line);
        if (agentMatch && parentMatch) {
          const key = parentMatch[1];
          if (!map[key]) {
            let prompt = null;
            const promptMatch = promptRe.exec(line);
            if (promptMatch?.[1]) {
              try { prompt = JSON.parse(`"${promptMatch[1]}"`); } catch (_) { prompt = promptMatch[1]; }
            }
            map[key] = { agentId: agentMatch[1], prompt };
          }
        }
      } else if (line.includes('Async agent launched')) {
        const toolIdMatch = bgToolIdRe.exec(line);
        const bgAgentMatch = bgAgentIdRe.exec(line);
        if (toolIdMatch && bgAgentMatch && !map[toolIdMatch[1]]) {
          map[toolIdMatch[1]] = { agentId: bgAgentMatch[1], prompt: null };
        }
      } else if (line.includes('"teammate_spawned"')) {
        const toolIdMatch = tmToolIdRe.exec(line);
        const agentMatch = tmAgentIdRe.exec(line);
        if (toolIdMatch && agentMatch && !map[toolIdMatch[1]]) {
          map[toolIdMatch[1]] = { agentId: agentMatch[1], prompt: null };
        }
      } else if (line.includes('"assistant"') && line.includes('"tool_use"') && line.includes('"Agent"')) {
        try {
          const obj = JSON.parse(line);
          const blocks = obj.message?.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b.type === 'tool_use' && b.name === 'Agent' && b.id) {
                if (b.input?.name) nameByToolUseId[b.id] = b.input.name;
                if (b.input?.description) descByToolUseId[b.id] = b.input.description;
                if (b.input?.prompt) promptByToolUseId[b.id] = b.input.prompt;
              }
            }
          }
        } catch (_) {}
      } else if (line.includes('User rejected tool use') && line.includes('"tool_use_id"')) {
        const m = tmToolIdRe.exec(line);
        if (m) rejectedToolUseIds.add(m[1]);
      } else if (line.includes('<task-notification>')) {
        // The envelope's tags survive JSON escaping, so read them off the raw line.
        // This covers every delivery shape (user message, queue-operation,
        // queued_command attachment) without enumerating them.
        if (line.includes('<status>killed</status>') || line.includes('<status>error</status>')) {
          const idMatch = taskIdRe.exec(line);
          if (idMatch) killedAgentIds.add(idMatch[1]);
        }
        if (line.includes('<subagent_tokens>')) {
          const notif = parseTaskNotification(line);
          const u = notif?.usage;
          const entry = u && notif.toolUseId ? agentUsageEntry(u.subagentTokens, u.toolUses, u.durationMs) : null;
          if (entry) usageByToolUseId[notif.toolUseId] = entry;
        }
      } else if (line.includes('"toolUseResult"') && line.includes('"agentId"') && line.includes('"tool_result"')) {
        try {
          const obj = JSON.parse(line);
          const tur = obj.toolUseResult;
          if (tur?.agentId) {
            // Foreground agents report their cost on the completion toolUseResult;
            // background agents report the same numbers in their <task-notification>.
            const { usage, usageText } = agentUsageEntry(tur.totalTokens, tur.totalToolUseCount, tur.totalDurationMs)
              || { usage: null, usageText: null };
            const blocks = obj.message?.content;
            if (Array.isArray(blocks)) {
              for (const b of blocks) {
                if (b.type === 'tool_result' && b.tool_use_id && !map[b.tool_use_id]) {
                  map[b.tool_use_id] = { agentId: tur.agentId, prompt: tur.prompt || null, usage, usageText };
                }
              }
            }
          }
        } catch (_) {}
      }
    }
    for (const [key, entry] of Object.entries(map)) {
      if (!entry.usage && usageByToolUseId[key]) Object.assign(entry, usageByToolUseId[key]);
      if (nameByToolUseId[key]) entry.name = nameByToolUseId[key];
      if (descByToolUseId[key]) entry.description = descByToolUseId[key];
      // Prefer the full prompt from the assistant's tool_use input — Claude Code's
      // agent_progress system messages embed a truncated prompt that ends mid-sentence.
      // Only override when entry already had a prompt (i.e. agent_progress path);
      // bg/teammate paths intentionally keep prompt null per existing contract.
      if (entry.prompt && promptByToolUseId[key] && promptByToolUseId[key].length > entry.prompt.length) {
        entry.prompt = promptByToolUseId[key];
      }
    }
  } catch (_) {}
  const rejectedAgentIds = new Set();
  const rejectedPrompts = new Set();
  for (const toolUseId of rejectedToolUseIds) {
    const entry = map[toolUseId];
    if (entry?.agentId) rejectedAgentIds.add(entry.agentId);
    const prompt = entry?.prompt || promptByToolUseId[toolUseId];
    if (prompt) rejectedPrompts.add(prompt);
  }
  return { progressMap: map, terminated, rejectedAgentIds, rejectedPrompts, killedAgentIds };
}

async function buildAgentProgressMap(jsonlPath) {
  return (await buildSessionDigest(jsonlPath)).progressMap;
}

const ARTIFACT_URL_RE = /https:\/\/claude\.ai\/\S*artifact\/[A-Za-z0-9_-]+/;

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n');
}

// Two kinds of line record a published artifact: the `frame-link` entry the
// viewer writes, which carries the title, and the result of an Artifact publish,
// which is there even when the artifact was never opened in a frame. Keyed by URL,
// so the republishes of one page collapse into a single entry. A result counts
// only when its tool_use_id belongs to a publish call — an artifact URL quoted
// back by a grep or a file read would otherwise register another session's page as
// this session's own, and a `read` of someone else's artifact is not a publish.
async function readArtifactLinks(jsonlPath) {
  const byUrl = new Map();
  const publishedFileByToolUseId = new Map();
  const upsert = (url, ts) => {
    let a = byUrl.get(url);
    if (!a) {
      a = { url, title: null, path: null, firstSeen: ts || null };
      byUrl.set(url, a);
    }
    if (ts && (!a.firstSeen || ts < a.firstSeen)) a.firstSeen = ts;
    return a;
  };
  try {
    for await (const line of readLines(jsonlPath)) {
      if (!line.includes('"frame-link"') && !line.includes('"name":"Artifact"') && !line.includes('claude.ai'))
        continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj.type === 'frame-link' && obj.frameUrl) {
        const a = upsert(obj.frameUrl, obj.timestamp);
        if (obj.title) a.title = obj.title;
        if (obj.path) a.path = obj.path;
        continue;
      }
      const blocks = obj?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b?.type === 'tool_use') {
          const input = b.name === 'Artifact' ? b.input || {} : null;
          // The publish action is the default one, so it is spelled by the file it
          // takes rather than by a name.
          if (b.id && input?.file_path && (!input.action || input.action === 'publish')) {
            publishedFileByToolUseId.set(b.id, input.file_path);
          }
          continue;
        }
        if (b?.type !== 'tool_result' || !publishedFileByToolUseId.has(b.tool_use_id)) continue;
        const m = toolResultText(b.content).match(ARTIFACT_URL_RE);
        if (!m) continue;
        const a = upsert(m[0], obj.timestamp);
        if (!a.path) a.path = publishedFileByToolUseId.get(b.tool_use_id);
      }
    }
  } catch (_) {}
  return [...byUrl.values()].sort((x, y) => (x.firstSeen < y.firstSeen ? -1 : x.firstSeen > y.firstSeen ? 1 : 0));
}

const SCRATCH_NEW_RE = /\bscratch new\b/;
// `scratch new` reports where it put the pad; the two spaces are the CLI's own column
// padding, which is what makes the prefilter below narrow enough to be worth having.
const SCRATCH_MANIFEST_RE = /^\s*manifest\s*:\s*(.+?)\s*$/m;
// The name must sit immediately after `new`, and the bare-word branch must refuse a
// leading `-`, so that a flag or a flag's value cannot be read as the name.
const SCRATCH_NAME_RE = /\bscratch\s+new\s+(?:"([^"]+)"|'([^']+)'|(?!-)(\S+))/;

// The `scratch new` calls in a transcript, `{ ts, path, name }` per call. `path` is null
// whenever the command piped the CLI's output away — the common case, not an edge one:
// the manifest is the 4th of ~13 printed lines, so any `| tail -N` cuts it off. `name`
// stands in because it is what the manifest stores as its own `name`; the path is not
// recovered from the command, which would mean tracking the `cd` and a relative `--dir`.
async function readScratchpadCreations(jsonlPath) {
  const calls = new Map();
  try {
    for await (const line of readLines(jsonlPath)) {
      // Substring reject before JSON.parse: transcripts reach tens of megabytes and
      // only a handful of lines can ever match.
      const isCall = line.includes('scratch new');
      if (!isCall && !line.includes('manifest  :')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      const blocks = obj?.message?.content;
      if (!Array.isArray(blocks)) continue;
      const ts = Date.parse(obj.timestamp);
      for (const b of blocks) {
        if (b?.type === 'tool_use' && b.name === 'Bash' && SCRATCH_NEW_RE.test(b.input?.command || '')) {
          if (b.id && Number.isFinite(ts)) {
            const named = SCRATCH_NAME_RE.exec(b.input.command);
            calls.set(b.id, { ts, path: null, name: named?.slice(1).find(Boolean) ?? null });
          }
        } else if (b?.type === 'tool_result' && calls.has(b.tool_use_id)) {
          const m = SCRATCH_MANIFEST_RE.exec(toolResultText(b.content));
          if (m) calls.get(b.tool_use_id).path = m[1];
        }
      }
    }
  } catch (_) {}
  return [...calls.values()];
}

async function readCompactSummaries(jsonlPath) {
  const results = [];
  // Inline format: newer Claude Code stores the summary directly in the parent
  // session JSONL as a user message with isCompactSummary: true (no subagent file).
  try {
    for await (const line of readLines(jsonlPath)) {
      if (!line.trim() || !line.includes('isCompactSummary')) continue;
      try {
        const obj = JSON.parse(line);
        if (!obj.isCompactSummary) continue;
        const c = obj.message?.content;
        let text = typeof c === 'string'
          ? c
          : Array.isArray(c) ? c.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n') : '';
        if (!text) continue;
        // Strip the "This session is being continued..." preamble if present.
        text = text.replace(/^This session is being continued[^\n]*\n+(The summary below[^\n]*\n+)?/i, '').trim();
        if (text) results.push({ timestamp: obj.timestamp, summary: text });
      } catch (_) {}
    }
  } catch (_) {}
  // Legacy format: summary lives in subagents/agent-acompact-*.jsonl.
  try {
    const subagentsDir = path.join(path.dirname(jsonlPath), path.basename(jsonlPath, '.jsonl'), 'subagents');
    const files = readdirSync(subagentsDir).filter(f => f.startsWith('agent-acompact-') && f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(subagentsDir, file);
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      // Use last entry timestamp (closest to when compaction completed)
      let lastTs;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try { lastTs = JSON.parse(lines[i]).timestamp; if (lastTs) break; } catch (_) {}
      }
      if (!lastTs) continue;
      // Find the last assistant message with a <summary> tag
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type !== 'assistant') continue;
          const blocks = obj.message?.content;
          if (!Array.isArray(blocks)) continue;
          let found = false;
          for (const b of blocks) {
            if (b.type !== 'text' || !b.text) continue;
            const match = b.text.match(/<summary>([\s\S]*?)(?:<\/summary>|$)/);
            if (match) { results.push({ timestamp: lastTs, summary: match[1].trim() }); found = true; break; }
          }
          if (found) break;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return results.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
}

async function findTerminatedTeammates(jsonlPath) {
  return (await buildSessionDigest(jsonlPath)).terminated;
}

function extractPromptFromTranscript(jsonlPath) {
  const { openSync, readSync, closeSync } = fs;
  // statSync (outside try) throws on a missing path — callers rely on that.
  const stat = statSync(jsonlPath);
  // Workflow-spawned subagent prompts embed full task context and routinely
  // exceed 64 KB, so read the whole first line up to a generous cap. One buffered
  // read (vs. per-chunk decode) also avoids corrupting multi-byte chars at chunk
  // boundaries for large prompts.
  const readSize = Math.min(2097152, stat.size);
  const fd = openSync(jsonlPath, 'r');
  try {
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, 0);
    // Decode only the first line, not the whole (possibly large) read window.
    const nlByte = buf.indexOf(0x0a);
    const firstLine = (nlByte === -1 ? buf : buf.subarray(0, nlByte)).toString('utf8');
    const obj = JSON.parse(firstLine);
    if (obj.type === 'user') {
      const content = obj.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text' && b.text) return b.text;
        }
      }
    }
  } catch (_) {
  } finally {
    closeSync(fd);
  }
  return null;
}

// The last maxBytes of a file as whole lines: a cut first line is dropped.
function readTailLines(jsonlPath, maxBytes) {
  const size = statSync(jsonlPath).size;
  const readSize = Math.min(maxBytes, size);
  const start = size - readSize;
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(jsonlPath, 'r');
  try {
    fs.readSync(fd, buf, 0, readSize, start);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  return (start > 0 ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
}

function lineModel(line) {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line);
    return obj.model || obj.message?.model || null;
  } catch (_) {
    return null;
  }
}

function extractModelFromTranscript(jsonlPath) {
  const { openSync, readSync, closeSync } = fs;
  const MAX_READ = 65536;
  const CHUNK = 4096;
  const fd = openSync(jsonlPath, 'r');
  let size;
  try {
    size = fs.fstatSync(fd).size;
    let accumulated = '';
    let total = 0;
    const buf = Buffer.alloc(CHUNK);
    while (total < MAX_READ) {
      const bytesRead = readSync(fd, buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      accumulated += buf.toString('utf8', 0, bytesRead);
      for (let nlIdx = accumulated.indexOf('\n'); nlIdx !== -1; nlIdx = accumulated.indexOf('\n')) {
        const model = lineModel(accumulated.slice(0, nlIdx));
        accumulated = accumulated.slice(nlIdx + 1);
        if (model) return model;
      }
    }
  } finally {
    closeSync(fd);
  }
  // A long prompt or tool result can push the first assistant line past the
  // head window, so look at the newest lines too.
  if (size <= MAX_READ) return null;
  const lines = readTailLines(jsonlPath, MAX_READ);
  for (let i = lines.length - 1; i >= 0; i--) {
    const model = lineModel(lines[i]);
    if (model) return model;
  }
  return null;
}

// The meta file Claude Code writes next to a subagent transcript: agentType,
// description, and the model the agent was asked for ("opus", "haiku", "inherit").
function readSubagentMeta(jsonlPath) {
  try {
    return JSON.parse(readFileSync(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

// Full-file scan of a subagent transcript for roster stats: model, summed
// output tokens, and first/last timestamps (for duration). COLD PATH ONLY —
// used by the workflow run view on demand, never from the session-scan hot
// path (a full read per agent would blow the /api/sessions budget).
async function extractTranscriptStats(jsonlPath) {
  let model = null;
  let outputTokens = 0;
  let firstTs = null;
  let lastTs = null;
  try {
    for await (const line of readLines(jsonlPath)) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj.timestamp) {
        if (!firstTs) firstTs = obj.timestamp;
        lastTs = obj.timestamp;
      }
      const msg = obj.message;
      if (msg && typeof msg === 'object') {
        if (!model && msg.model) model = msg.model;
        const out = msg.usage?.output_tokens;
        if (typeof out === 'number') outputTokens += out;
      }
    }
  } catch (_) { return null; }
  return { model, outputTokens, firstTs, lastTs };
}

// Render a StructuredOutput tool input (arbitrary schema object) as markdown:
// one section per field, prose kept verbatim, structured values as JSON blocks.
function formatStructuredResult(input) {
  const parts = [];
  for (const [key, value] of Object.entries(input)) {
    if (value == null || value === '') continue;
    parts.push(`### ${key}`);
    parts.push(typeof value === 'string' ? value : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
  }
  return parts.length ? parts.join('\n\n') : null;
}

// Some subagents end their run on a tool call and never emit a text response, so
// their lastMessage is empty: workflow subagents given a schema call StructuredOutput,
// background subagents report through SubagentHandback. Tail-read the transcript and
// take the LAST such tool_use as the agent's result. Without one, take the last
// assistant text: the plugin's mod records no lastMessage, because Claude Code's
// turn.complete carries an empty answer for a subagent. Returns null when neither exists.
const RESULT_TOOLS = {
  StructuredOutput: formatStructuredResult,
  SubagentHandback: (input) => (typeof input.message === 'string' && input.message) || null,
};
const RESULT_TOOL_TEXT = Object.keys(RESULT_TOOLS).map((name) => `"${name}"`);

function resultFromBlock(b) {
  if (b?.type !== 'tool_use' || !b.input || typeof b.input !== 'object') return null;
  return RESULT_TOOLS[b.name]?.(b.input) ?? null;
}

function extractAgentResultFromTranscript(jsonlPath) {
  const lines = readTailLines(jsonlPath, 1048576);
  try {
    const lastAssistant = (needle, pick) => {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!needle(lines[i])) continue;
        let obj;
        try { obj = JSON.parse(lines[i]); } catch (_) { continue; }
        const content = obj?.message?.content;
        const found = obj?.type === 'assistant' && Array.isArray(content) && pick(content);
        if (found) return found;
      }
      return null;
    };
    return lastAssistant(
      (line) => RESULT_TOOL_TEXT.some((t) => line.includes(t)),
      (content) => content.map(resultFromBlock).findLast(Boolean),
    ) ?? lastAssistant(
      (line) => line.includes('"type":"assistant"'),
      (content) => toolResultText(content).trim(),
    );
  } catch (_) {}
  return null;
}

// Incremental loop-tool scanner. JSONL is append-only, so we keep per-path
// state and on each call read ONLY the bytes appended since scannedOffset.
// Avoids the only full-file read that ran inside the /api/sessions hot path.
//
// State shape: { mtimeMs, size, scannedOffset, wakeups[], crons[],
//                taskIdByToolUseId<Map>, deletedTaskIds<Set> }
const EMPTY_LOOP_STATE = () => ({
  mtimeMs: 0, size: 0, scannedOffset: 0,
  wakeups: [], crons: [],
  taskIdByToolUseId: new Map(), deletedTaskIds: new Set()
});

const LOOP_TOOL_TEXT = ['"ScheduleWakeup"', '"CronCreate"', '"CronDelete"'];
const LOOP_TOOL_MARKERS = LOOP_TOOL_TEXT.map((m) => Buffer.from(m));

// Only a CronCreate result is ever read back from taskIdByToolUseId, and it is written after
// its tool_use, so other tool results (most lines of a transcript) are not parsed.
// `hay` is a line or a Buffer; both have includes.
const hasPendingCronId = (hay, state) =>
  state.crons.some((c) => c.id && !state.taskIdByToolUseId.has(c.id) && hay.includes(c.id));

const wakeupFireMs = (w) => Date.parse(w.timestamp) + (w.delaySeconds ?? 0) * 1000;

function processLoopLine(line, state) {
  if (!line) return;
  const hasToolResult = line.includes('"tool_use_id"') && hasPendingCronId(line, state);
  const hasLoopTool = LOOP_TOOL_TEXT.some((m) => line.includes(m));
  if (!hasToolResult && !hasLoopTool) return;
  let obj;
  try { obj = JSON.parse(line); } catch (_) { return; }
  const content = obj?.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'tool_result' && b.tool_use_id) {
      const tid = obj.toolUseResult?.id;
      if (tid) state.taskIdByToolUseId.set(b.tool_use_id, tid);
    } else if (b.type === 'tool_use') {
      const inp = b.input || {};
      if (b.name === 'ScheduleWakeup') {
        // The harness keeps one pending wakeup per session: a newer call replaces it and
        // stop cancels it. Wakeups that already fired stay as history.
        const at = Date.parse(obj.timestamp);
        state.wakeups = state.wakeups.filter((w) => wakeupFireMs(w) <= at);
        if (inp.stop) continue;
        state.wakeups.push({
          id: b.id || null,
          timestamp: obj.timestamp || null,
          delaySeconds: typeof inp.delaySeconds === 'number' ? inp.delaySeconds : null,
          reason: inp.reason || null,
          prompt: inp.prompt || null
        });
      } else if (b.name === 'CronCreate') {
        state.crons.push({
          id: b.id || null,
          taskId: null,
          timestamp: obj.timestamp || null,
          cron: inp.cron || inp.cronExpression || null,
          prompt: inp.prompt || null,
          description: inp.description || inp.reason || null
        });
      } else if (b.name === 'CronDelete') {
        const ids = inp.id ? [inp.id] : (Array.isArray(inp.ids) ? inp.ids : []);
        for (const i of ids) state.deletedTaskIds.add(i);
      }
    }
  }
}

// True when processLoopLine could act on some line in bytes: a loop tool call, or the result of a
// CronCreate whose task id is still unknown. Most appended bytes hold neither and are never decoded.
function hasLoopMarker(bytes, state) {
  return LOOP_TOOL_MARKERS.some((m) => bytes.includes(m)) || hasPendingCronId(bytes, state);
}

// Reads bytes appended to jsonlPath since prev.scannedOffset and merges into
// state. Pass `null` (or undefined) for prev to do a one-time full scan.
function updateLoopInfo(jsonlPath, prev) {
  let stat;
  try { stat = statSync(jsonlPath); } catch (_) { return prev || EMPTY_LOOP_STATE(); }

  let state = prev;
  // Cold start OR file shrank (truncate/replace) → rescan from beginning.
  if (!state || stat.size < state.size) {
    state = EMPTY_LOOP_STATE();
  } else if (state.mtimeMs === stat.mtimeMs && state.size === stat.size) {
    return state; // unchanged
  }

  if (stat.size <= state.scannedOffset) {
    state.mtimeMs = stat.mtimeMs;
    state.size = stat.size;
    return state;
  }

  let fd;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const len = stat.size - state.scannedOffset;
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, state.scannedOffset);
    state.mtimeMs = stat.mtimeMs;
    // No complete line yet — leave scannedOffset alone.
    const lastNl = buf.subarray(0, n).lastIndexOf(0x0a);
    if (lastNl < 0) return state;
    const complete = buf.subarray(0, lastNl);
    if (hasLoopMarker(complete, state)) {
      for (const line of complete.toString('utf8').split('\n')) processLoopLine(line, state);
    }
    state.scannedOffset += lastNl + 1;
    state.size = stat.size;
  } catch (_) {
    // leave state as-is
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
  }
  return state;
}

function buildLoopInfoFromState(state) {
  if (!state) return { wakeups: [], crons: [] };
  // Resolve pending taskIds in place — taskIdByToolUseId is monotonic, so
  // once resolved an entry stays resolved and we skip the spread-copy on
  // every subsequent call.
  for (const c of state.crons) {
    if (!c.taskId) c.taskId = state.taskIdByToolUseId.get(c.id) || null;
  }
  const crons = state.deletedTaskIds.size
    ? state.crons.filter(c => !c.taskId || !state.deletedTaskIds.has(c.taskId))
    : state.crons;
  return { wakeups: state.wakeups, crons };
}

module.exports = {
  modelDisplayName,
  parseTask,
  parseAgent,
  parseWaiting,
  parseTeamConfig,
  parseSessionsIndex,
  parseJsonlLine,
  parseTaskNotification,
  parseAgentMessage,
  getSystemMessageLabel,
  readSessionInfoFromJsonl,
  exportSessionCaches,
  importSessionCaches,
  sessionCachesDirty,
  transcriptActivityMs,
  countTranscriptsBornBefore,
  readRecentMessages,
  readMessagesPage,
  readFullToolResult,
  readUserImage,
  readToolResultImage,
  readCachedImage,
  updateLoopInfo,
  buildLoopInfoFromState,
  buildAgentProgressMap,
  buildSessionDigest,
  readCompactSummaries,
  readArtifactLinks,
  readScratchpadCreations,
  findTerminatedTeammates,
  extractPromptFromTranscript,
  extractModelFromTranscript,
  readSubagentMeta,
  extractAgentResultFromTranscript,
  extractTranscriptStats,
  readLines
};

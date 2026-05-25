const fs = require('fs');
const { readFileSync, existsSync, readdirSync, statSync } = fs;
const path = require('path');
const { StringDecoder } = require('string_decoder');

function parseTask(raw) {
  const task = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    id: task.id,
    subject: task.subject,
    description: task.description || null,
    status: task.status,
    blocks: task.blocks || [],
    blockedBy: task.blockedBy || [],
    isInternal: !!(task.metadata && task.metadata._internal),
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

  if (obj.type === 'progress') {
    return { ...base, cwd: obj.cwd || null, version: obj.version || null, slug: obj.slug || null };
  }

  return base;
}

const TOOL_RESULT_MAX = 1500;
const USER_TEXT_MAX = 500;
const INTERRUPT_MARKER = '[Request interrupted by user]';

function pushUserMessage(messages, text, timestamp, sysLabel, extras) {
  if (sysLabel === '__skip__') return;
  const safeText = text || '';
  const truncated = safeText.length > USER_TEXT_MAX;
  const msg = {
    type: 'user',
    text: truncated ? safeText.slice(0, USER_TEXT_MAX) + '...' : safeText,
    fullText: truncated ? safeText : null,
    timestamp,
    ...(sysLabel && { systemLabel: sysLabel })
  };
  if (extras) {
    if (extras.uuid) msg.uuid = extras.uuid;
    if (extras.images && extras.images.length) msg.images = extras.images;
    if (extras.toolResultRefs && extras.toolResultRefs.length) msg.toolResultRefs = extras.toolResultRefs;
  }
  messages.push(msg);
}

// Cache: jsonlPath -> { scannedUpTo, customTitle }
// Only re-scan the new bytes appended since last scan
const customTitleCache = new Map();
const CUSTOM_TITLE_SCAN_SIZE = 1048576; // 1MB max scan on first read

// Returns the best title found, in priority order:
//   custom-title (user override) > ai-title > agent-name
// Background-session JSONLs created by the "claude agents" feature only emit
// ai-title/agent-name records; older sessions emit custom-title.
function extractCustomTitleFromText(text) {
  const hasCustom = text.includes('"custom-title"');
  const hasAi = text.includes('"ai-title"');
  const hasAgent = text.includes('"agent-name"');
  if (!hasCustom && !hasAi && !hasAgent) return null;
  const lines = text.split('\n');
  let customTitle = null;
  let aiTitle = null;
  let agentName = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"') && !line.includes('"agent-name"')) continue;
    try {
      const data = JSON.parse(line);
      if (!customTitle && data.type === 'custom-title' && data.customTitle && !data.customTitle.startsWith('<')) {
        customTitle = data.customTitle;
      } else if (!aiTitle && data.type === 'ai-title' && data.aiTitle && !data.aiTitle.startsWith('<')) {
        aiTitle = data.aiTitle;
      } else if (!agentName && data.type === 'agent-name' && data.agentName && !data.agentName.startsWith('<')) {
        agentName = data.agentName;
      }
      if (customTitle) break;
    } catch (e) {}
  }
  return customTitle || aiTitle || agentName || null;
}

function readCustomTitle(jsonlPath, existingStat) {
  try {
    const stat = existingStat || statSync(jsonlPath);
    const cached = customTitleCache.get(jsonlPath);

    if (cached && cached.scannedUpTo >= stat.size) return cached.customTitle;

    let customTitle = cached?.customTitle || null;
    const fd = fs.openSync(jsonlPath, 'r');

    if (cached) {
      const len = stat.size - cached.scannedUpTo;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, cached.scannedUpTo);
        customTitle = extractCustomTitleFromText(buf.toString('utf8')) || customTitle;
      }
    } else {
      const CHUNK = CUSTOM_TITLE_SCAN_SIZE;
      for (let offset = 0; offset < stat.size; offset += CHUNK) {
        const len = Math.min(CHUNK, stat.size - offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        const found = extractCustomTitleFromText(buf.toString('utf8'));
        if (found) customTitle = found;
      }
    }

    fs.closeSync(fd);
    customTitleCache.set(jsonlPath, { scannedUpTo: stat.size, customTitle });
    return customTitle;
  } catch (e) {
    return null;
  }
}

const SCRAPE_CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const SCRAPE_SLUG_RE = /"slug"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const SCRAPE_GITBRANCH_RE = /"gitBranch"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function scrapeScalarFromBlob(blob, re) {
  const m = blob.match(re);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch (e) { return null; }
}

const sessionInfoCache = new Map();
const SESSION_INFO_CACHE_MAX = 2000;

// gitBranch in the JSONL is pinned to the launch-time repo by Claude Code
// and goes stale once cwd shifts (Bash `cd`, submodule). Callers needing the
// live branch must resolve it from cwd separately. Cache is reset on inode
// change or truncation (size < scannedUpTo).
function readSessionInfoFromJsonl(jsonlPath) {
  const result = { slug: null, projectPath: null, cwd: null, gitBranch: null, customTitle: null, logicalParentUuid: null };
  let stat;
  let fd;
  try {
    stat = statSync(jsonlPath);
  } catch (_) {
    return result;
  }

  const cached = sessionInfoCache.get(jsonlPath);
  const inodeMatch = cached && cached.ino === stat.ino;
  const sizeOK = cached && stat.size >= cached.scannedUpTo;
  const canIncrement = inodeMatch && sizeOK;

  if (canIncrement && stat.size === cached.scannedUpTo) {
    return {
      slug: cached.slug,
      projectPath: cached.projectPath,
      cwd: cached.cwd,
      gitBranch: cached.gitBranch,
      logicalParentUuid: cached.logicalParentUuid || null,
      customTitle: readCustomTitle(jsonlPath, stat)
    };
  }

  if (canIncrement) {
    result.slug = cached.slug;
    result.projectPath = cached.projectPath;
    result.cwd = cached.cwd;
    result.gitBranch = cached.gitBranch;
    result.logicalParentUuid = cached.logicalParentUuid || null;
  }

  let lastCwdSeen = result.cwd;
  const applyLine = (line) => {
    try {
      const data = JSON.parse(line);
      if (data.slug && !result.slug) result.slug = data.slug;
      if (data.cwd) {
        if (!result.projectPath) result.projectPath = data.cwd;
        lastCwdSeen = data.cwd;
      }
      if (data.gitBranch) result.gitBranch = data.gitBranch;
      if (data.subtype === 'compact_boundary' && data.logicalParentUuid && !result.logicalParentUuid) {
        result.logicalParentUuid = data.logicalParentUuid;
      }
    } catch (e) {}
  };

  const CHUNK_SIZE = 16384;
  const TAIL_SIZE = 16384;
  const HEAD_MAX = 1048576;
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
      if (stat.size > offset) {
        const tailStart = Math.max(offset, stat.size - TAIL_SIZE);
        const tailBuf = Buffer.alloc(TAIL_SIZE);
        const tn = fs.readSync(fd, tailBuf, 0, TAIL_SIZE, tailStart);
        const lines = tailBuf.toString('utf8', 0, tn).split('\n');
        let latestTailCwd = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const data = JSON.parse(lines[i]);
            if (!result.slug && data.slug) result.slug = data.slug;
            if (!result.projectPath && data.cwd) result.projectPath = data.cwd;
            if (!result.gitBranch && data.gitBranch) result.gitBranch = data.gitBranch;
            if (!latestTailCwd && data.cwd) latestTailCwd = data.cwd;
            if (latestTailCwd && result.slug && result.projectPath && result.gitBranch) break;
          } catch (e) {}
        }
        if (latestTailCwd) lastCwdSeen = latestTailCwd;
      }
      scannedUpTo = stat.size;
    }
  } catch (e) {
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }

  result.cwd = lastCwdSeen;

  if (stat) {
    sessionInfoCache.set(jsonlPath, {
      ino: stat.ino,
      size: stat.size,
      scannedUpTo,
      slug: result.slug,
      projectPath: result.projectPath,
      gitBranch: result.gitBranch,
      cwd: result.cwd,
      logicalParentUuid: result.logicalParentUuid
    });
    if (sessionInfoCache.size > SESSION_INFO_CACHE_MAX) {
      const firstKey = sessionInfoCache.keys().next().value;
      sessionInfoCache.delete(firstKey);
    }
  }
  result.customTitle = readCustomTitle(jsonlPath, stat);
  return result;
}

function getSystemMessageLabel(text) {
  const taskMatch = text.match(/<summary>([^<]+)<\/summary>/);
  if (taskMatch) return taskMatch[1].trim();
  if (text.includes('<task-notification>')) {
    const statusMatch = text.match(/<status>([^<]+)<\/status>/);
    return statusMatch ? `Background task ${statusMatch[1]}` : 'Background task notification';
  }
  if (text.includes('<local-command-stdout>') && text.includes('Compacted')) return 'Compacted';
  if (text.includes('<local-command-stdout>')) return 'Command output';
  if (text.includes('<local-command-caveat>')) return 'System notification';
  if (text.includes('.output completed') && text.includes('Background command')) return 'Background task completed';
  if (text.startsWith('This session is being continued from a previous conversation')) return '__skip__';
  if (text.includes('<command-name>/clear</command-name>')) return '__skip__';
  if (text.includes('<command-name>/compact</command-name>')) return 'Compacted';
  return null;
}

function readRecentMessages(jsonlPath, limit = 10) {
  let fd;
  try {
    const stat = statSync(jsonlPath);
    fd = require('fs').openSync(jsonlPath, 'r');
    const messages = [];
    const toolResults = new Map();
    const toolResultExtras = new Map();
    let readSize = Math.min(65536, stat.size);

    while (messages.length < limit) {
      readSize = Math.min(readSize, stat.size);
      const start = Math.max(0, stat.size - readSize);
      const bufSize = readSize;
      const buf = Buffer.alloc(bufSize);
      require('fs').readSync(fd, buf, 0, bufSize, start);

      const text = buf.toString('utf8');
      const firstNewline = text.indexOf('\n');
      const clean = firstNewline >= 0 ? text.substring(firstNewline + 1) : text;

      messages.length = 0;
      toolResults.clear();
      toolResultExtras.clear();
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
                  text: truncated ? block.text.slice(0, 500) + '...' : block.text,
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
                  else if (inp.command) { detail = inp.command.length > 80 ? inp.command.slice(0, 80) + '...' : inp.command; fullDetail = inp.command; }
                  else if (inp.pattern) { detail = inp.pattern; fullDetail = inp.pattern; }
                  else if (inp.query) { detail = inp.query; fullDetail = inp.query; }
                  else if (inp.url) { detail = inp.url.length > 80 ? inp.url.slice(0, 80) + '...' : inp.url; fullDetail = inp.url; }
                  else if (inp.skill) { const s = inp.skill + (typeof inp.args === 'string' ? ' ' + inp.args : ''); detail = s.length > 80 ? s.slice(0, 80) + '...' : s; fullDetail = s; }
                  else if (inp.questions && Array.isArray(inp.questions)) {
                    const parts = inp.questions.map(q => (q.header ? q.header + ': ' : '') + q.question);
                    const s = parts.join(' | ');
                    detail = s.length > 80 ? s.slice(0, 80) + '...' : s;
                    fullDetail = inp.questions.map(q => {
                      let text = (q.header ? '[' + q.header + '] ' : '') + q.question;
                      if (q.options) text += '\n\n' + q.options.map((o, j) => '  ' + (j + 1) + '. ' + o.label + (o.description ? ' — ' + o.description : '')).join('\n');
                      return text;
                    }).join('\n\n');
                  }
                  else if (inp.to) {
                    const proto = inp.message && typeof inp.message === 'object' ? inp.message : null;
                    if (proto?.type === 'shutdown_request') {
                      detail = '→ ' + inp.to + ': shutdown request' + (proto.reason ? ' (' + proto.reason + ')' : '');
                    } else if (proto?.type === 'shutdown_response') {
                      detail = '→ ' + inp.to + ': ' + (proto.approve ? 'shutdown approved' : 'shutdown rejected');
                    } else if (proto?.type === 'plan_approval_response') {
                      detail = '→ ' + inp.to + ': ' + (proto.approve ? 'plan approved' : 'plan rejected');
                    } else {
                      detail = '→ ' + inp.to + (inp.summary ? ': ' + inp.summary : '');
                    }
                    if (detail.length > 80) detail = detail.slice(0, 80) + '...';
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
                        params.content = inp.content.slice(0, TOOL_RESULT_MAX) + '\n... (truncated)';
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
                    if (inp.taskId) params.taskId = '#' + inp.taskId;
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
                        params[k] = v.slice(0, TOOL_RESULT_MAX) + '\n... (truncated)';
                        params[k + 'Full'] = v;
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
          } else if (obj.type === 'user' && obj.message?.role === 'user' && !obj.isMeta) {
            if (typeof obj.message.content === 'string') {
              const t = obj.message.content;
              const tmMatch = t.match(/<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/);
              if (tmMatch) {
                const attrs = tmMatch[1];
                const body = tmMatch[2].trim();
                const getAttr = (name) => (attrs.match(new RegExp(name + '="([^"]*)"')) || [])[1] || null;
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
                  text: isProtocol ? null : (truncated ? body.slice(0, 500) + '...' : body),
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
              const hasText = joined && joined !== INTERRUPT_MARKER;
              const hasImages = images.length > 0;
              if (hasText || hasImages) {
                pushUserMessage(
                  messages,
                  joined,
                  obj.timestamp,
                  getSystemMessageLabel(joined),
                  { uuid: obj.uuid, images, toolResultRefs: hasText ? toolResultRefs : [] }
                );
              }
            }
          }
        } catch (e) { /* partial line */ }
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
          msg.toolResult = full.slice(0, TOOL_RESULT_MAX) + '\n... (truncated)';
          msg.toolResultFull = full;
        } else {
          msg.toolResult = full;
        }
        msg.toolResultTruncated = truncated;
      }
      if (msg.type === 'tool_use' && msg.tool === 'AskUserQuestion'
          && msg.toolUseId && toolResultExtras.has(msg.toolUseId)) {
        const extra = toolResultExtras.get(msg.toolUseId);
        if (extra.answerPayload) msg.answerPayload = extra.answerPayload;
      }
    }

    require('fs').closeSync(fd);
    fd = null;
    messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    for (let i = messages.length - 1; i > 0; i--) {
      if (messages[i].systemLabel === 'Compacted' && messages[i - 1].systemLabel === 'Compacted') {
        messages.splice(i, 1);
      }
    }
    return messages.slice(-limit);
  } catch (e) {
    if (fd) try { require('fs').closeSync(fd); } catch (_) {}
    return [];
  }
}

function readFullToolResult(jsonlPath, toolUseId) {
  if (!toolUseId || !jsonlPath || !existsSync(jsonlPath)) return null;
  try {
    const content = readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
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

function readUserImage(jsonlPath, msgUuid, blockIndex) {
  if (!msgUuid || !jsonlPath) return null;
  const idx = Number(blockIndex);
  if (!Number.isInteger(idx) || idx < 0) return null;
  try {
    const content = readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
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

function buildSessionDigest(jsonlPath) {
  const map = {};
  const terminated = new Map();
  const rejectedToolUseIds = new Set();
  const promptByToolUseId = {};
  const killedAgentIds = new Set();
  try {
    const content = readFileSync(jsonlPath, 'utf8');
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
    for (const line of content.split('\n')) {
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
            if (promptMatch && promptMatch[1]) {
              try { prompt = JSON.parse('"' + promptMatch[1] + '"'); } catch (_) { prompt = promptMatch[1]; }
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
      } else if (line.includes('<task-notification>') &&
                 (line.includes('<status>killed</status>') || line.includes('<status>error</status>'))) {
        const idMatch = taskIdRe.exec(line);
        if (idMatch) killedAgentIds.add(idMatch[1]);
      } else if (line.includes('"toolUseResult"') && line.includes('"agentId"') && line.includes('"tool_result"')) {
        try {
          const obj = JSON.parse(line);
          const tur = obj.toolUseResult;
          if (tur?.agentId) {
            const blocks = obj.message?.content;
            if (Array.isArray(blocks)) {
              for (const b of blocks) {
                if (b.type === 'tool_result' && b.tool_use_id && !map[b.tool_use_id]) {
                  map[b.tool_use_id] = { agentId: tur.agentId, prompt: tur.prompt || null };
                }
              }
            }
          }
        } catch (_) {}
      }
    }
    for (const [key, entry] of Object.entries(map)) {
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

function buildAgentProgressMap(jsonlPath) {
  return buildSessionDigest(jsonlPath).progressMap;
}

function readCompactSummaries(jsonlPath) {
  const results = [];
  // Inline format: newer Claude Code stores the summary directly in the parent
  // session JSONL as a user message with isCompactSummary: true (no subagent file).
  try {
    const content = readFileSync(jsonlPath, 'utf8');
    for (const line of content.split('\n')) {
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

function findTerminatedTeammates(jsonlPath) {
  return buildSessionDigest(jsonlPath).terminated;
}

function extractPromptFromTranscript(jsonlPath) {
  const { openSync, readSync, closeSync } = fs;
  const MAX_READ = 65536;
  const CHUNK = 4096;
  const fd = openSync(jsonlPath, 'r');
  try {
    let accumulated = '';
    const buf = Buffer.alloc(CHUNK);
    while (accumulated.length < MAX_READ) {
      const bytesRead = readSync(fd, buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      accumulated += buf.toString('utf8', 0, bytesRead);
      const nlIdx = accumulated.indexOf('\n');
      if (nlIdx === -1) continue;
      const firstLine = accumulated.slice(0, nlIdx);
      try {
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
      } catch (_) {}
      break;
    }
  } finally {
    closeSync(fd);
  }
  return null;
}

function extractModelFromTranscript(jsonlPath) {
  const { openSync, readSync, closeSync } = fs;
  const MAX_READ = 65536;
  const CHUNK = 4096;
  const fd = openSync(jsonlPath, 'r');
  try {
    let accumulated = '';
    const buf = Buffer.alloc(CHUNK);
    while (accumulated.length < MAX_READ) {
      const bytesRead = readSync(fd, buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      accumulated += buf.toString('utf8', 0, bytesRead);
      let nlIdx;
      while ((nlIdx = accumulated.indexOf('\n')) !== -1) {
        const line = accumulated.slice(0, nlIdx);
        accumulated = accumulated.slice(nlIdx + 1);
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const model = obj.model || (obj.message && obj.message.model);
          if (model) return model;
        } catch (_) {}
      }
    }
  } finally {
    closeSync(fd);
  }
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

function processLoopLine(line, state) {
  if (!line) return;
  const hasToolResult = line.includes('"tool_use_id"');
  const hasLoopTool = line.includes('"ScheduleWakeup"')
    || line.includes('"CronCreate"')
    || line.includes('"CronDelete"');
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
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, state.scannedOffset);
    const text = buf.toString('utf8', 0, n);
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) {
      // No complete line yet — leave scannedOffset alone, update mtime only.
      state.mtimeMs = stat.mtimeMs;
      return state;
    }
    const complete = text.slice(0, lastNl);
    for (const line of complete.split('\n')) processLoopLine(line, state);
    state.scannedOffset += Buffer.byteLength(complete, 'utf8') + 1;
    state.mtimeMs = stat.mtimeMs;
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
  parseTask,
  parseAgent,
  parseWaiting,
  parseTeamConfig,
  parseSessionsIndex,
  parseJsonlLine,
  readSessionInfoFromJsonl,
  readRecentMessages,
  readMessagesPage,
  readFullToolResult,
  readUserImage,
  updateLoopInfo,
  buildLoopInfoFromState,
  buildAgentProgressMap,
  buildSessionDigest,
  readCompactSummaries,
  findTerminatedTeammates,
  extractPromptFromTranscript,
  extractModelFromTranscript
};

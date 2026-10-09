'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodeProjectDirName } = require('./claude-dir');
const { UUID_RE } = require('./terminal');

const PKG_DIR = path.join(__dirname, '..');
const PLUGIN_DIR = path.join(PKG_DIR, 'clawd');
const AGENT = 'cck-clawd:clawd';
const KANBAN_SKILL = path.join(PKG_DIR, 'plugin', 'plugins', 'claude-code-kanban', 'skills', 'kanban', 'SKILL.md');
const TRANSCRIPT_RE = new RegExp(`^(${UUID_RE.source.slice(1, -1)})\\.jsonl$`, 'i');

function clawdOn(cfg) {
  return cfg?.clawd?.enabled !== false;
}

// An agent run with --agent ignores the skills: of its frontmatter, so the kanban skill goes in as system prompt.
function clawdArgs(claudeDir) {
  return ['--plugin-dir', PLUGIN_DIR, '--agent', AGENT, '--append-system-prompt-file', KANBAN_SKILL, '--add-dir', claudeDir];
}

function createClawd({ cckDir, projectsDir }) {
  const cwd = path.join(cckDir, 'clawd');
  const projectDir = path.join(projectsDir, encodeProjectDirName(cwd));
  const ownIds = new Set();
  let sessionId = null;
  let focus = null;

  function transcriptIds() {
    try {
      return fs.readdirSync(projectDir).map((f) => TRANSCRIPT_RE.exec(f)?.[1]).filter(Boolean);
    } catch {
      return [];
    }
  }

  // The newest transcript is the chat to resume: /clear starts a new one in the same folder.
  function newestTranscript() {
    let best = null;
    for (const id of transcriptIds()) {
      ownIds.add(id);
      const mtime = fs.statSync(path.join(projectDir, `${id}.jsonl`)).mtimeMs;
      if (!best || mtime > best.mtime) best = { id, mtime };
    }
    return best?.id || null;
  }

  for (const id of transcriptIds()) ownIds.add(id);

  return {
    cwd,
    ptyId: null,
    isOwnPath: (p) => p === projectDir || p.startsWith(projectDir + path.sep),
    isOwnProjectDirName: (name) => name === path.basename(projectDir),
    isOwnSession: (id) => ownIds.has(id),
    onTranscript(filePath, event) {
      const id = TRANSCRIPT_RE.exec(path.basename(filePath))?.[1];
      if (event === 'unlink' || !id) return;
      sessionId = id;
      ownIds.add(id);
    },
    startSpec() {
      fs.mkdirSync(cwd, { recursive: true });
      sessionId = newestTranscript();
      return { cwd, name: 'clawd', extraArgs: clawdArgs(path.dirname(cckDir)), ...(sessionId && { resume: sessionId }) };
    },
    get sessionId() {
      return sessionId;
    },
    get focus() {
      return focus;
    },
    setFocus(sessionIdOnScreen) {
      focus = sessionIdOnScreen ? { sessionId: sessionIdOnScreen, updatedAt: new Date().toISOString() } : null;
    },
  };
}

module.exports = { clawdOn, createClawd, CLAWD_AGENT: AGENT, CLAWD_PLUGIN_DIR: PLUGIN_DIR };

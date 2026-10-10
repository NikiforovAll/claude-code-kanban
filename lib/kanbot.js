'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodeProjectDirName } = require('./claude-dir');
const { MODELS } = require('./terminal');
const { topHelp } = require('../cli');

const PLUGIN_DIR = path.join(__dirname, '..', 'kanbot');
const AGENT = 'cck-kanbot:kanbot';
const TRANSCRIPT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function kanbotOn(cfg) {
  return cfg?.kanbot?.enabled !== false;
}

function kanbotModel(cfg) {
  const model = cfg?.kanbot?.model;
  return MODELS.has(model) ? model : null;
}

function writeHelpPrompt(cwd, boardUrl) {
  const file = path.join(cwd, 'cli-help.md');
  const board = boardUrl ? `This board runs at ${boardUrl}; \`$CCK_URL\` holds the same URL, so the CLI talks to it.\n\n` : '';
  fs.writeFileSync(file, `# claude-code-kanban CLI\n\n${board}\`claude-code-kanban help\` prints:\n\n\`\`\`\n${topHelp()}\n\`\`\`\n`);
  return file;
}

function kanbotArgs(cwd, claudeDir, boardUrl) {
  return ['--plugin-dir', PLUGIN_DIR, '--agent', AGENT, '--append-system-prompt-file', writeHelpPrompt(cwd, boardUrl), '--add-dir', claudeDir];
}

function createKanbot({ cckDir, projectsDir }) {
  const cwd = path.join(cckDir, 'kanbot');
  const projectDir = path.join(projectsDir, encodeProjectDirName(cwd));
  const ownIds = new Set();
  let sessionId = null;

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
      const mtime = fs.statSync(path.join(projectDir, `${id}.jsonl`), { throwIfNoEntry: false })?.mtimeMs;
      if (mtime && (!best || mtime > best.mtime)) best = { id, mtime };
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
    // A fresh start writes hook files under its id before claude writes a transcript.
    own: (id) => ownIds.add(id),
    onTranscript(filePath, event) {
      const id = TRANSCRIPT_RE.exec(path.basename(filePath))?.[1];
      if (event === 'unlink' || !id) return;
      sessionId = id;
      ownIds.add(id);
    },
    startSpec({ model = null, boardUrl = null } = {}) {
      fs.mkdirSync(cwd, { recursive: true });
      sessionId = newestTranscript();
      const extraArgs = kanbotArgs(cwd, path.dirname(cckDir), boardUrl);
      // Not restored on a cck restart: a restore would bring it back without the agent args.
      return { cwd, name: 'kanbot', model, extraArgs, restore: false, ...(sessionId && { resume: sessionId }) };
    },
    get sessionId() {
      return sessionId;
    },
  };
}

module.exports = { kanbotOn, kanbotModel, createKanbot, KANBOT_AGENT: AGENT, KANBOT_PLUGIN_DIR: PLUGIN_DIR };

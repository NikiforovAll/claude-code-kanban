'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodeProjectDirName } = require('./claude-dir');
const { MODELS } = require('./terminal');
const { isPidAlive } = require('./live-sessions');
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

function costSection(costCli) {
  if (!costCli) return '';
  return [
    '\n# Costs\n',
    `\`${costCli} help\` lists the commands for Claude Code costs: by day, model, project, session and subagent.`,
    'To show a session, or one of its subagents, to the user: `claude-code-kanban session cost <id> [--agent <agent id>]`.\n',
  ].join('\n');
}

function writeHelpPrompt(cwd, boardUrl, costCli) {
  const file = path.join(cwd, 'cli-help.md');
  const board = boardUrl ? `This board runs at ${boardUrl}; \`$CCK_URL\` holds the same URL, so the CLI talks to it.\n\n` : '';
  fs.writeFileSync(file, `# claude-code-kanban CLI\n\n${board}\`claude-code-kanban help\` prints:\n\n\`\`\`\n${topHelp()}\n\`\`\`\n${costSection(costCli)}`);
  return file;
}

function kanbotArgs(cwd, claudeDir, boardUrl, costCli) {
  return ['--plugin-dir', PLUGIN_DIR, '--agent', AGENT, '--append-system-prompt-file', writeHelpPrompt(cwd, boardUrl, costCli), '--add-dir', claudeDir];
}

// A claude-code-cost before its CLI starts a dashboard on any command, so a bin on PATH counts only
// when its package has lib/cli.js. npm puts the package next to a Windows shim, and a POSIX bin is
// a symlink to server.js.
function costPackageHasCli(bin) {
  const dirs = [path.join(path.dirname(bin), 'node_modules', 'claude-code-cost')];
  try {
    dirs.push(path.dirname(fs.realpathSync(bin)));
  } catch {}
  return dirs.some((d) => fs.existsSync(path.join(d, 'lib', 'cli.js')));
}

// The hub gives cck no cost URL. The cost server of this config dir records itself in server.json
// ({pid, port, script}); a killed one leaves the file behind.
function readCostServer(claudeDir) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(claudeDir, '.cost', 'server.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(rec?.pid) || !Number.isInteger(rec?.port) || !isPidAlive(rec.pid)) return null;
  return { url: `http://localhost:${rec.port}`, script: typeof rec.script === 'string' ? rec.script : null };
}

// Under the hub the CLI is not on PATH, so the running cost server names its own script.
function findCostCli({ claudeDir, which }) {
  const script = readCostServer(claudeDir)?.script;
  if (script) return `node "${script.replace(/\\/g, '/')}"`;
  const bin = which('claude-code-cost');
  return bin && costPackageHasCli(bin) ? 'claude-code-cost' : null;
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
    startSpec({ model = null, boardUrl = null, costCli = null } = {}) {
      fs.mkdirSync(cwd, { recursive: true });
      sessionId = newestTranscript();
      const extraArgs = kanbotArgs(cwd, path.dirname(cckDir), boardUrl, costCli);
      // Not restored on a cck restart: a restore would bring it back without the agent args.
      return { cwd, name: 'kanbot', model, extraArgs, restore: false, ...(sessionId && { resume: sessionId }) };
    },
    get sessionId() {
      return sessionId;
    },
  };
}

module.exports = { kanbotOn, kanbotModel, createKanbot, findCostCli, readCostServer, KANBOT_AGENT: AGENT, KANBOT_PLUGIN_DIR: PLUGIN_DIR };

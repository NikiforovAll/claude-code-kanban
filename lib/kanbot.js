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

const COST_DIR = '.cost';

// `dir` holds the app's server.json in the config dir; `plugin` is its skill, in the app's package
// at plugin/plugins/<plugin>. The app's script and its bin sit at the package root.
const APPS = [
  {
    dir: COST_DIR,
    bin: 'claude-code-cost',
    plugin: 'cost-dashboard',
    section: (cli) =>
      [
        '\n# Costs\n',
        `\`${cli} help\` lists the commands for Claude Code costs: by day, model, project, session and subagent.`,
        'To show a session, or one of its subagents, to the user: `claude-code-kanban session cost <id> [--agent <agent id>]`.\n',
      ].join('\n'),
  },
  {
    dir: '.memory',
    bin: 'claude-code-memory-explorer',
    plugin: 'memory-diagnoser',
    section: (cli) =>
      [
        '\n# Memory analysis\n',
        `\`${cli} help\` lists the commands for the Memory Diagnoser's saved analysis results: the projects that have them, and the findings of one project.\n`,
      ].join('\n'),
  },
];

function writeHelpPrompt(cwd, boardUrl, apps) {
  const file = path.join(cwd, 'cli-help.md');
  const board = boardUrl ? `This board runs at ${boardUrl}; \`$CCK_URL\` holds the same URL, so the CLI talks to it.\n\n` : '';
  const sections = apps.map((a) => a.section).join('');
  fs.writeFileSync(file, `# claude-code-kanban CLI\n\n${board}\`claude-code-kanban help\` prints:\n\n\`\`\`\n${topHelp()}\n\`\`\`\n${sections}`);
  return file;
}

function kanbotArgs(cwd, claudeDir, boardUrl, apps) {
  const plugins = [PLUGIN_DIR, ...apps.map((a) => a.pluginDir).filter(Boolean)].flatMap((dir) => ['--plugin-dir', dir]);
  return [...plugins, '--agent', AGENT, '--append-system-prompt-file', writeHelpPrompt(cwd, boardUrl, apps), '--add-dir', claudeDir];
}

// An app package from before its CLI starts a dashboard on any command, so a bin on PATH counts only
// when its package has lib/cli.js. npm puts the package next to a Windows shim, and a POSIX bin is
// a symlink to server.js.
function packageWithCli(bin, pkg) {
  const dirs = [path.join(path.dirname(bin), 'node_modules', pkg)];
  try {
    dirs.push(path.dirname(fs.realpathSync(bin)));
  } catch {}
  return dirs.find((d) => fs.existsSync(path.join(d, 'lib', 'cli.js'))) || null;
}

// The hub gives cck no app URL. An app server of this config dir records itself in server.json
// ({pid, port, script}); a killed one leaves the file behind.
function readAppServer(claudeDir, dir) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(claudeDir, dir, 'server.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(rec?.pid) || !Number.isInteger(rec?.port) || !isPidAlive(rec.pid)) return null;
  return { url: `http://localhost:${rec.port}`, script: typeof rec.script === 'string' ? rec.script : null };
}

// Under the hub the CLI is not on PATH, so the running app server names its own script.
function findApp(app, { claudeDir, which }) {
  const script = readAppServer(claudeDir, app.dir)?.script;
  let root;
  let command = app.bin;
  if (script) {
    root = path.dirname(script);
    command = `node "${script.replace(/\\/g, '/')}"`;
  } else {
    const bin = which(app.bin);
    root = bin && packageWithCli(bin, app.bin);
  }
  if (!root) return null;
  // Kanbot loads the skill from the app's package for the session, so the user installs nothing
  // and the skill matches the app that runs.
  const pluginDir = path.join(root, 'plugin', 'plugins', app.plugin);
  return {
    section: app.section(command),
    pluginDir: fs.existsSync(path.join(pluginDir, '.claude-plugin', 'plugin.json')) ? pluginDir : null,
  };
}

const findKanbotApps = (opts) => APPS.map((app) => findApp(app, opts)).filter(Boolean);
const readCostServer = (claudeDir) => readAppServer(claudeDir, COST_DIR);

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
    startSpec({ model = null, boardUrl = null, apps = [] } = {}) {
      fs.mkdirSync(cwd, { recursive: true });
      sessionId = newestTranscript();
      const extraArgs = kanbotArgs(cwd, path.dirname(cckDir), boardUrl, apps);
      // Not restored on a cck restart: a restore would bring it back without the agent args.
      return { cwd, name: 'kanbot', model, extraArgs, restore: false, ...(sessionId && { resume: sessionId }) };
    },
    get sessionId() {
      return sessionId;
    },
  };
}

module.exports = { kanbotOn, kanbotModel, createKanbot, findKanbotApps, readCostServer, KANBOT_AGENT: AGENT, KANBOT_PLUGIN_DIR: PLUGIN_DIR };

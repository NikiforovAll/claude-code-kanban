const fs = require('node:fs');
const path = require('node:path');
const { getClaudeDir, displayPath } = require('./lib/claude-dir');
const { isGroupName, suggestGroupName } = require('./lib/dispatch-groups');
const { linkUrl } = require('./public/link-url');
// Help is auto-generated from this table — keep flags/usage in sync with `run` behavior.
const SESSION_FLAG = '--session <id>';
const SESSION_FLAG_HELP = 'Session, full id or unique prefix (default: $PREVIEW_SESSION, else $CLAUDE_CODE_SESSION_ID)';

const COMMANDS = {
  doc: {
    summary: 'Show documents to the user: link them to a session, or open the preview',
    verbs: {
      link: {
        summary: 'Link a file or URL to a session, with no modal',
        usage: 'claude-code-kanban doc link <file|url> [--session <id>]',
        flags: {
          '<file|url>': 'Any file type; one the preview cannot render opens in the editor. An http(s) URL opens in a new tab.',
          [SESSION_FLAG]: SESSION_FLAG_HELP,
        },
        notes: 'The server keeps the link, so it shows when a browser tab opens later. Prefer this over `doc preview` while the user works.',
        examples: [
          'claude-code-kanban doc link ./design.md',
          'claude-code-kanban doc link https://github.com/org/repo/pull/12',
        ],
        run: runDocLinkCli,
      },
      unlink: {
        summary: 'Remove a linked file or URL from a session',
        usage: 'claude-code-kanban doc unlink <file|url> [--session <id>]',
        flags: {
          '<file|url>': 'The linked path or URL; the file need not exist',
          [SESSION_FLAG]: SESSION_FLAG_HELP,
        },
        examples: ['claude-code-kanban doc unlink ./design.md'],
        run: runDocLinkCli,
      },
      list: {
        summary: 'Print the docs linked to a session',
        usage: 'claude-code-kanban doc list [--session <id>] [--json]',
        flags: {
          [SESSION_FLAG]: SESSION_FLAG_HELP,
          '--json': 'Output JSON',
        },
        run: runDocListCli,
      },
      preview: {
        summary: 'Open a markdown or HTML file in the preview modal on connected browser tabs',
        usage: 'claude-code-kanban doc preview <file.md|file.html|url> [--session <id>]',
        flags: {
          [SESSION_FLAG]: 'Switch focused session in the browser (does not link the file; default: $PREVIEW_SESSION). For a URL, the session it links to (default: $PREVIEW_SESSION, else $CLAUDE_CODE_SESSION_ID).',
        },
        notes: 'The modal opens on the user\'s screen: the only command that does. HTML renders in a sandboxed iframe; local stylesheets, scripts and images are inlined. Relative paths resolve against the current dir. An http(s) URL is linked to the session instead, and the tab on screen shows an Open button.',
        examples: [
          'claude-code-kanban doc preview ./notes.md --session $CLAUDE_SESSION_ID',
        ],
        run: runPreviewCli,
      },
    },
  },
  pane: {
    summary: 'Add live panes (a URL or a local file) to a session\'s view, without switching to them',
    verbs: {
      add: {
        summary: 'Add a pane to a session; it opens as a tab next to Board, in the background',
        usage: 'claude-code-kanban pane add <url|file> [--title <text>] [--session <id>] [--json]',
        flags: {
          '<url|file>': 'An http(s) URL, or a local HTML, markdown, text or image file (relative paths resolve against the current dir)',
          '--title <text>': 'Tab title (default: the host or file name)',
          [SESSION_FLAG]: SESSION_FLAG_HELP,
          '--json': 'Output JSON (the new pane, with frameable: true, false, or null when unknown)',
        },
        notes: 'The board does not switch to the new pane; the user opens it. Prints the pane id. The same target added again prints the pane it already has. A URL on the board\'s or the hub\'s own origin is refused, and a file must be one the board can preview. A site whose headers refuse framing (X-Frame-Options, CSP frame-ancestors) is still added, but its pane shows an "Open in new tab" card, and a note line says so.',
        examples: [
          'claude-code-kanban pane add http://localhost:5173',
          'claude-code-kanban pane add ./report.html --title Report',
        ],
        run: runPaneAddCli,
      },
      rm: {
        summary: 'Remove a pane from a session',
        usage: 'claude-code-kanban pane rm <pane-id> [--session <id>]',
        flags: {
          '<pane-id>': 'The id `pane add` or `pane list` printed',
          [SESSION_FLAG]: SESSION_FLAG_HELP,
        },
        examples: ['claude-code-kanban pane rm p3'],
        run: runPaneRmCli,
      },
      list: {
        summary: 'List the panes of a session, in tab order',
        usage: 'claude-code-kanban pane list [--session <id>] [--json]',
        flags: {
          [SESSION_FLAG]: SESSION_FLAG_HELP,
          '--json': 'Output JSON ({rev, panes: [{id, kind, target, title, addedAt}], updatedAt})',
        },
        run: runPaneListCli,
      },
    },
  },
  session: {
    summary: 'List, search, open and inspect Claude Code sessions',
    verbs: {
      list: {
        summary: 'List sessions (pinned/sticky always included)',
        usage: 'claude-code-kanban session list [--active] [--days <n>] [--project <name>] [--limit <n|all>] [--no-pins] [--json]',
        flags: {
          '--active': 'Only sessions with recent activity (sidebar-style filter)',
          '--days <n>': 'Only sessions modified within the last N days (fractional ok, e.g. 0.5)',
          '--project <name>': 'Filter by project: an absolute path selects one project, other text matches a part of the path',
          '--limit <n|all>': 'Max rows to display (default: 10). Use "all" for no cap.',
          '--no-pins': 'Disable always-include and sticky-first ordering for pinned sessions',
          '--json': 'Output JSON instead of a table',
        },
        examples: [
          'claude-code-kanban session list --active',
          'claude-code-kanban session list --days 0.5 --limit all --project my-repo',
        ],
        run: runSessionListCli,
      },
      search: {
        summary: 'Find sessions whose name or id contains the text, from any transcript',
        usage: 'claude-code-kanban session search <text> [--limit <n>] [--json]',
        flags: {
          '<text>': 'At least 3 characters; matched against the session name and id',
          '--limit <n>': 'Max rows (default and max: 20)',
          '--json': 'Output JSON instead of a table',
        },
        examples: [
          'claude-code-kanban session search login-redirect',
        ],
        run: runSessionSearchCli,
      },
      open: {
        summary: 'Focus a session in the browser (Active tab)',
        usage: 'claude-code-kanban session open <id>',
        flags: {
          '<id>': 'Full session id, or a unique prefix',
        },
        examples: ['claude-code-kanban session open $CLAUDE_SESSION_ID'],
        run: runSessionOpenCli,
      },
      view: {
        summary: 'Show full session stats (metadata + context window + cost) and the transcript path',
        usage: 'claude-code-kanban session view <id> [--json]',
        flags: {
          '<id>': 'Full session id, or a unique prefix',
          '--json': 'Output JSON instead of formatted sections',
        },
        notes: 'To learn what a session did, read its transcript (a .jsonl file, newest lines last).',
        examples: ['claude-code-kanban session view $CLAUDE_SESSION_ID'],
        run: runSessionViewCli,
      },
      plan: {
        summary: 'Print the plan saved for a session (plan mode)',
        usage: 'claude-code-kanban session plan <id> [--json]',
        flags: {
          '<id>': 'Full session id, or a unique prefix',
          '--json': 'Output JSON ({content, slug}); content is null when there is no plan',
        },
        examples: ['claude-code-kanban session plan 3fa9c1'],
        run: runSessionPlanCli,
      },
      agents: {
        summary: 'List the subagents a session has run, and whether it waits for the user',
        usage: 'claude-code-kanban session agents <id> [--json]',
        flags: {
          '<id>': 'Full session id, or a unique prefix',
          '--json': 'Output JSON ({agents, waitingForUser})',
        },
        notes: 'Needs the cck hooks in this config dir (claude-code-kanban --install); without them the list is empty.',
        examples: ['claude-code-kanban session agents $CLAUDE_SESSION_ID'],
        run: runSessionAgentsCli,
      },
      pin: {
        summary: 'Pin (or unpin) a session in the sidebar of connected browser tabs',
        usage: 'claude-code-kanban session pin <id> [--sticky] [--unpin]',
        flags: {
          '<id>': 'Full session id, or a unique prefix',
          '--sticky': 'Set sticky state (always shown, top of list)',
          '--unpin': 'Clear pin/sticky state',
        },
        examples: [
          'claude-code-kanban session pin $CLAUDE_SESSION_ID --sticky',
          'claude-code-kanban session pin $CLAUDE_SESSION_ID --unpin',
        ],
        run: runSessionPinCli,
      },
    },
  },
  task: {
    summary: 'Read the tasks on the board',
    verbs: {
      list: {
        summary: 'List the tasks of a session, a project, or every session',
        usage: 'claude-code-kanban task list (<session> | --project <path> | --all) [--status <s>] [--json]',
        flags: {
          '<session>': 'Full session id, or a unique prefix',
          '--project <path>': 'Every task of the sessions in this project (absolute path, as in `project list`)',
          '--all': 'Every task on the board',
          '--status <s>': 'Only tasks in this status: pending, in_progress or completed',
          '--json': 'Output JSON instead of a table',
        },
        examples: [
          'claude-code-kanban task list $CLAUDE_SESSION_ID',
          'claude-code-kanban task list --all --status in_progress',
        ],
        run: runTaskListCli,
      },
    },
  },
  project: {
    summary: 'Read the projects the board knows',
    verbs: {
      list: {
        summary: 'List known project paths, newest activity first',
        usage: 'claude-code-kanban project list [--json]',
        flags: {
          '--json': 'Output JSON instead of a table',
        },
        notes: 'These are the folders `dispatch start --cwd` accepts.',
        run: runProjectListCli,
      },
    },
  },
  dispatch: {
    summary: 'Start a Claude Code session for a task in cck\'s terminal',
    verbs: {
      start: {
        summary: 'Start claude in cck\'s terminal with a task; prints the session id',
        usage: 'claude-code-kanban dispatch start --cwd <dir> (--spec <text> | --spec-file <path>) [--name <n>] [--group <g>] [--model <m>] [--worktree [name]] [--json] [-- <claude args>...]',
        flags: {
          '--cwd <dir>': 'Folder to run in (a known project, default: current dir)',
          '--spec <text>': 'The task, self-contained; sent as the first message',
          '--spec-file <path>': 'Read the task from a file',
          '--name <n>': 'Session name; also its peer name for SendMessage',
          '--group <g>': 'Show it with this session in a kebab-case group (default: this session\'s group)',
          '--model <m>': 'fable, opus, sonnet or haiku',
          '--worktree [name]': 'Run in a new git worktree',
          '--json': 'Output JSON',
          '-- <claude args>': 'Passed to claude as they are, e.g. --permission-mode auto. No quotes, % or control characters; cck sets --session-id, --name, --model and --worktree',
        },
        notes: 'Needs the terminal token, so it runs on the machine of the cck server. cck sends no report: say in the spec how the session reports back. Run `claude-code-kanban skills get dispatch` for how to write the spec.',
        examples: [
          'claude-code-kanban dispatch start --cwd . --spec-file spec.md --name fix-login-redirect --group auth-refactor --model sonnet -- --permission-mode auto',
        ],
        run: runDispatchStartCli,
      },
      list: {
        summary: 'List sessions this session started that still run in cck\'s terminal',
        usage: 'claude-code-kanban dispatch list [--all] [--json]',
        flags: {
          '--all': 'Every dispatch on this board',
          '--json': 'Output JSON',
        },
        run: runDispatchListCli,
      },
    },
  },
  skills: {
    summary: 'Print a skill guide bundled with this version',
    verbs: {
      get: {
        summary: 'Print the guide for a skill',
        usage: 'claude-code-kanban skills get <name>',
        flags: { '<name>': 'Skill name, e.g. dispatch' },
        examples: ['claude-code-kanban skills get dispatch'],
        run: runSkillsGetCli,
      },
    },
  },
};

for (const [noun, cmd] of Object.entries(COMMANDS)) {
  cmd.name = noun;
  for (const [verb, v] of Object.entries(cmd.verbs || {})) v.name = `${noun} ${verb}`;
}
function runCli(argv) {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(require('./package.json').version);
    process.exit(0);
  }
  const cli = resolveCliCommand(argv);
  if (cli.kind === 'server') return false;
  if (cli.kind === 'help') {
    const noun = cli.target && Object.hasOwn(COMMANDS, cli.target) ? COMMANDS[cli.target] : null;
    const verb = noun?.verbs && cli.verb && Object.hasOwn(noun.verbs, cli.verb) ? noun.verbs[cli.verb] : null;
    if (verb) printLeafHelp(verb);
    else if (noun) printNounHelp(cli.target);
    else printTopHelp();
    process.exit(0);
  }
  if (cli.kind === 'unknown-noun') {
    console.error(`Unknown command: ${cli.noun}\n`);
    printTopHelp();
    process.exit(1);
  }
  if (cli.kind === 'unknown-verb') {
    console.error(`Unknown subcommand: ${cli.noun} ${cli.verb}\n`);
    printNounHelp(cli.noun);
    process.exit(1);
  }
  if (cli.kind === 'noun') {
    printNounHelp(cli.noun);
    process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 1);
  }
  if (cli.kind === 'leaf') {
    if (cli.args.includes('--help') || cli.args.includes('-h')) {
      printLeafHelp(cli.entry);
      process.exit(0);
    }
    cli.entry.run(cli.args, cli.entry)
      .then(code => { process.exitCode = code; })
      .catch(e => { console.error(e.message); process.exitCode = 1; });
    return true;
  }
  return true;
}

function resolveCliCommand(argv) {
  const noun = argv[2] && !argv[2].startsWith('-') ? argv[2] : null;
  const hasHelp = (a) => a.includes('--help') || a.includes('-h');
  if (!noun) return hasHelp(argv) ? { kind: 'help' } : { kind: 'server' };
  if (noun === 'help') return { kind: 'help', target: argv[3], verb: argv[4] };
  if (!Object.hasOwn(COMMANDS, noun)) return { kind: 'unknown-noun', noun };
  const entry = COMMANDS[noun];
  if (!entry.verbs) return { kind: 'leaf', name: noun, entry, args: argv.slice(3) };
  const verb = argv[3] && !argv[3].startsWith('-') ? argv[3] : null;
  if (!verb) return { kind: 'noun', noun };
  if (!Object.hasOwn(entry.verbs, verb)) return { kind: 'unknown-verb', noun, verb };
  return { kind: 'leaf', name: `${noun} ${verb}`, entry: entry.verbs[verb], args: argv.slice(4) };
}

function printTopHelp() {
  console.log('Usage: claude-code-kanban <command> [args] [--flags]\n');
  console.log('Commands:');
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    const verbs = cmd.verbs ? ` (${Object.keys(cmd.verbs).join(', ')})` : '';
    console.log(`  ${name.padEnd(20)}${cmd.summary}${verbs}`);
  }
  console.log(`  ${'help'.padEnd(20)}Show help for a command (claude-code-kanban help <command>)`);
  console.log('\nFlags:');
  console.log('  --help, -h            Show help (top-level, noun-level, or leaf-level)');
  console.log('  --version, -v         Print version and exit');
  console.log('\nServer mode (no subcommand):');
  console.log('  --port <n>            Port to listen on (default 3541)');
  console.log('  --dir <path>          Override Claude config dir (default ~/.claude); also targets --install/--uninstall');
  console.log('  --open                Open browser on start');
  console.log('  --install, --uninstall    Install or remove the plugin');
  console.log('  --yes                 With --install: install without a prompt');
  console.log('\nEnvironment:');
  console.log('  CCK_URL               Server base URL, e.g. http://127.0.0.1:4795 (wins over PORT)');
  console.log('  PORT                  Server port (default: the one this config dir\'s server reports, else 3541)');
  console.log('  CLAUDE_CONFIG_DIR     Claude config dir whose board to use');
  console.log('\nRun `claude-code-kanban help <command>` for its subcommands, and `help <command> <subcommand>` for flags and examples.');
}

function printNounHelp(noun) {
  const entry = COMMANDS[noun];
  console.log(`${entry.summary}\n`);
  if (entry.verbs) {
    console.log(`Usage: claude-code-kanban ${noun} <subcommand> [args] [--flags]\n`);
    console.log('Subcommands:');
    for (const [vName, v] of Object.entries(entry.verbs)) {
      console.log(`  ${vName.padEnd(12)}${v.summary}`);
    }
    console.log(`\nRun \`claude-code-kanban help ${noun} <subcommand>\` for flags and examples.`);
  } else {
    printLeafHelp(entry);
  }
}

function printLeafHelp(entry) {
  console.log(`${entry.summary}\n`);
  console.log(`Usage: ${entry.usage}`);
  const flags = { ...entry.flags, '--help, -h': 'Show this help' };
  const pad = Math.max(...Object.keys(flags).map(f => f.length));
  console.log('\nFlags:');
  for (const [flag, desc] of Object.entries(flags)) {
    console.log(`  ${flag.padEnd(pad + 2)}${desc}`);
  }
  if (entry.notes) console.log(`\n${entry.notes}`);
  if (entry.examples?.length) {
    console.log('\nExamples:');
    for (const ex of entry.examples) console.log(`  ${ex}`);
  }
}

// For a bad value: the leaf help would bury the one line that says what is wrong.
function usageError(entry, message) {
  console.error(message);
  console.error(`Run \`claude-code-kanban help ${entry.name}\` for usage.`);
  return 1;
}

function getArgValue(args, name) {
  const idx = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return null;
  const arg = args[idx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
}

// The hub runs one cck per config dir, each on its own port, so 3541 can be another dir's board.
// The server's beacon in this config dir names the right one; PORT still wins when set.
// A beacon left by a dead server means this dir's board is down: 3541 would be someone else's.
// Returns null in that case.
function cliPort() {
  if (process.env.PORT) return process.env.PORT;
  const beacon = readCckJson('server.json');
  if (!beacon) return 3541;
  return beacon.port && beacon.pid && isPidAlive(beacon.pid) ? beacon.port : null;
}

function cliBaseUrl() {
  if (process.env.CCK_URL) return process.env.CCK_URL.replace(/\/+$/, '');
  const port = cliPort();
  return port === null ? null : `http://127.0.0.1:${port}`;
}

function cliTargetPort() {
  if (!process.env.CCK_URL) return cliPort();
  try { return new URL(process.env.CCK_URL).port; } catch (_) { return ''; }
}

function readCckJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(getClaudeDir(), '.cck', name), 'utf8')); } catch (_) { return null; }
}

// EPERM means the process exists but belongs to someone else.
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function unreachable() {
  const dir = displayPath(getClaudeDir());
  const start = 'Start it first with "claude-code-kanban".';
  if (process.env.CCK_URL) return `Cannot reach cck server for ${dir} at ${cliBaseUrl()} (CCK_URL). ${start}`;
  const port = cliPort();
  if (port === null) return `Cannot reach cck server for ${dir}: its server.json names a server that is no longer running. ${start}`;
  return `Cannot reach cck server for ${dir} on port ${port}. ${start}`;
}

class CliUnreachable extends Error { constructor() { super(unreachable()); this.code = 'unreachable'; } }

// Windows sometimes fails a loopback connect with ETIMEDOUT after ~300 ms when many
// connects run at once. Nothing reached the server, so even a POST is safe to send again.
const CONNECT_RETRY_MS = [250, 500, 1000, 2000];
const isConnectTimeout = (e) => e.cause?.code === 'ETIMEDOUT' && e.cause?.syscall === 'connect';
// A loopback connection can also be reset after it opens. A GET is safe to send again; a write may have landed.
const isRetryable = (e, init) => isConnectTimeout(e) || (!init?.method && e.cause?.code === 'ECONNRESET');

async function cliFetch(urlPath, init) {
  const base = cliBaseUrl();
  if (!base) throw new CliUnreachable();
  for (let i = 0; ; i++) {
    try {
      return await fetch(`${base}${urlPath}`, init);
    } catch (e) {
      if (isRetryable(e, init) && i < CONNECT_RETRY_MS.length) {
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS[i]));
        continue;
      }
      if (e.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(e.message)) throw new CliUnreachable();
      throw e;
    }
  }
}

const cliPostJson = (urlPath, body, label, headers) => cliSendJson('POST', urlPath, body, label, headers);

// Every write verb sends JSON and reports failure the same way; `label` names the verb
// in the error line. Returns the parsed response body ({} when empty), or null after
// printing the failure, so callers just return 1.
async function cliSendJson(method, urlPath, body, label, headers = {}) {
  const res = await cliFetch(urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch (_) { /* not JSON */ }
  if (res.ok) return parsed;
  console.error(`${label} failed (${res.status}): ${parsed.error || text}`);
  return null;
}

function reportCliError(e) {
  console.error(e.code === 'unreachable' ? e.message : (e.message || String(e)));
}

async function runPreviewCli(args) {
  const filePathArg = args.find(a => !a.startsWith('--'));
  if (!filePathArg) {
    printLeafHelp(COMMANDS.doc.verbs.preview);
    return 1;
  }
  const url = linkUrl(filePathArg);
  if (url) return previewUrlCli(url, args);
  // No $CLAUDE_CODE_SESSION_ID fallback: a session here switches the board's focus, and the
  // agent must not move the board unless asked.
  const sessionId = getArgValue(args, 'session') || process.env.PREVIEW_SESSION || null;
  const abs = cliPath(filePathArg);
  try {
    if (!await cliPostJson('/api/preview', { path: abs, sessionId }, 'Preview')) return 1;
    console.log(`Preview opened: ${abs}${sessionId ? ` (session ${sessionId})` : ''}`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

// The modal cannot show a web page, so a URL is linked instead and the tab on screen
// offers to open it.
async function previewUrlCli(url, args) {
  const resolved = await resolveSessionArg(COMMANDS.doc.verbs.preview, args, 'a URL is linked to the session.');
  return resolved ? postDocLink(url, resolved.id, { open: true }) : 1;
}

async function postDocLink(target, sessionId, { unlink = false, open = false } = {}) {
  try {
    const out = await cliPostJson('/api/document/link', { path: target, sessionId, unlink, open }, 'Link');
    if (!out) return 1;
    const what = linkUrl(target) ? 'URL' : 'Document';
    console.log(`${what} ${unlink ? 'unlinked from' : 'linked to'} session ${sessionId.slice(0, 8)}: ${out.path}`);
    if (!unlink && out.tabs === 0) console.log('No browser tab is open; the board shows it when one opens.');
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

// Resolved to the full id because the browser keys linked docs by it, so a prefix won't match.
async function resolveSessionArg(entry, args, why) {
  const sessionArg = getArgValue(args, 'session') || process.env.PREVIEW_SESSION || process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionArg) {
    usageError(entry, `--session is required: ${why}`);
    return null;
  }
  return resolveSessionByIdOrPrefix(sessionArg);
}

async function runDocLinkCli(args, entry) {
  const [filePathArg] = positionals(args, ['--session']);
  if (!filePathArg) {
    printLeafHelp(entry);
    return 1;
  }
  const resolved = await resolveSessionArg(entry, args, 'linked docs are stored per session.');
  if (!resolved) return 1;
  const unlink = entry === COMMANDS.doc.verbs.unlink;
  return postDocLink(cliTarget(filePathArg), resolved.id, { unlink });
}

async function runDocListCli(args, entry) {
  const resolved = await resolveSessionArg(entry, args, 'linked docs are stored per session.');
  return resolved ? printLinkedDocs(resolved.id, args.includes('--json')) : 1;
}

// The server resolves a path against its own cwd, so a relative one is made absolute here.
const cliTarget = (arg) => linkUrl(arg) || cliPath(arg);

const PANES_WHY = 'panes are stored per session.';

const panesPath = (sessionId, paneId) =>
  `/api/panes/${encodeURIComponent(sessionId)}${paneId ? `/${encodeURIComponent(paneId)}` : ''}`;

async function runPaneAddCli(args, entry) {
  const [target] = positionals(args, ['--session', '--title']);
  if (!target) {
    printLeafHelp(entry);
    return 1;
  }
  const resolved = await resolveSessionArg(entry, args, PANES_WHY);
  if (!resolved) return 1;
  try {
    const body = { target: cliTarget(target), title: getArgValue(args, 'title') || '' };
    const out = await cliPostJson(panesPath(resolved.id), body, 'Pane add');
    if (!out) return 1;
    const { pane } = out;
    let frameable;
    if (pane.kind === 'url') {
      try {
        ({ frameable } = await cliGetJson(`${panesPath(resolved.id, pane.id)}/framing`, 'Pane framing'));
      } catch {}
    }
    if (args.includes('--json')) console.log(JSON.stringify({ ...pane, frameable }, null, 2));
    else console.log(`${pane.id}  ${pane.title}${out.added ? '' : ' (already there)'}`);
    if (frameable === false && !args.includes('--json')) {
      console.log(`note: ${new URL(pane.target).host} refuses framing, so the pane shows an "Open in new tab" card. Look for a URL of the same content that allows framing.`);
    }
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runPaneRmCli(args, entry) {
  const [paneId] = positionals(args, ['--session']);
  if (!paneId) {
    printLeafHelp(entry);
    return 1;
  }
  const resolved = await resolveSessionArg(entry, args, PANES_WHY);
  if (!resolved) return 1;
  try {
    if (!await cliSendJson('DELETE', panesPath(resolved.id, paneId), undefined, 'Pane rm')) return 1;
    console.log(`Removed pane ${paneId} from session ${resolved.id.slice(0, 8)}`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runPaneListCli(args, entry) {
  const resolved = await resolveSessionArg(entry, args, PANES_WHY);
  if (!resolved) return 1;
  try {
    const layout = await cliGetJson(panesPath(resolved.id), 'Pane list');
    if (args.includes('--json')) console.log(JSON.stringify(layout, null, 2));
    else if (!layout.panes.length) console.log(`No panes for session ${resolved.id.slice(0, 8)}.`);
    else printTable(['ID', 'KIND', 'TITLE', 'TARGET'], layout.panes.map((p) => [p.id, p.kind, p.title, p.target]));
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function printLinkedDocs(sessionId, asJson) {
  try {
    const res = await cliFetch(`/api/document/links?session=${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(`Failed to fetch linked docs (${res.status})`);
    const paths = (await res.json())[sessionId] || [];
    if (asJson) console.log(JSON.stringify(paths, null, 2));
    else if (!paths.length) console.log(`No linked docs for session ${sessionId.slice(0, 8)}.`);
    else for (const p of paths) console.log(p);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

// Mirror of `isSessionActive` in public/app.js — keep in sync (different runtimes, no shared module).
function isSessionActive(s) {
  return s.hasRecentLog || s.inProgress > 0 || s.hasActiveAgents || s.hasWaitingForUser;
}

function sessionStatus(s) {
  if (!isSessionActive(s)) return 'idle';
  if (s.hasWaitingForUser) return 'wait';
  if (s.inProgress > 0) return 'busy';
  return 'active';
}

function parseLimit(args, { fallback, allowAll = false }) {
  const raw = getArgValue(args, 'limit');
  if (raw === null) return { ok: true, limit: fallback };
  if (allowAll && raw === 'all') return { ok: true, limit: null };
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return { ok: false, error: `Invalid --limit value: ${raw}` };
  return { ok: true, limit: n };
}

async function fetchSessionsList(limit, pinnedIds = [], project = null) {
  const q = limit === null ? 'all' : String(limit);
  const pinnedQ = pinnedIds.length ? `&pinned=${pinnedIds.join(',')}` : '';
  const projectQ = project ? `&project=${encodeURIComponent(project)}` : '';
  const res = await cliFetch(`/api/sessions?limit=${q}${pinnedQ}${projectQ}`);
  if (!res.ok) throw new Error(`Failed to fetch sessions (${res.status})`);
  return res.json();
}

async function fetchPinsMap() {
  try {
    const res = await cliFetch('/api/session/pins');
    if (!res.ok) return {};
    const { pins = {} } = await res.json();
    return pins;
  } catch { return {}; }
}

async function resolveSessionByIdOrPrefix(idArg) {
  let res;
  try {
    res = await cliFetch(`/api/session/resolve?id=${encodeURIComponent(idArg)}`);
  } catch (e) {
    reportCliError(e);
    return null;
  }
  if (res.status === 404) {
    console.error(`No session matches: ${idArg}`);
    return null;
  }
  if (res.status === 409) {
    const { matches = [] } = await res.json().catch(() => ({}));
    console.error(`Ambiguous prefix "${idArg}" matches ${matches.length} sessions:`);
    for (const m of matches.slice(0, 10)) console.error(`  ${m.id}  ${m.customTitle || ''}`);
    return null;
  }
  if (!res.ok) {
    console.error(`Resolve failed (${res.status}): ${await res.text()}`);
    return null;
  }
  return res.json();
}

async function runSessionListCli(args) {
  const activeOnly = args.includes('--active');
  const noPins = args.includes('--no-pins');
  const projectFilter = getArgValue(args, 'project');
  const daysArg = getArgValue(args, 'days');
  const days = daysArg !== null ? parseFloat(daysArg) : null;
  if (daysArg !== null && (Number.isNaN(days) || days <= 0)) {
    return usageError(COMMANDS.session.verbs.list, `Invalid --days value: ${daysArg}`);
  }
  const parsed = parseLimit(args, { fallback: 10, allowAll: true });
  if (!parsed.ok) return usageError(COMMANDS.session.verbs.list, parsed.error);
  const limit = parsed.limit;
  const asJson = args.includes('--json');
  const pinsMap = noPins ? {} : await fetchPinsMap();
  const pinnedIds = Object.keys(pinsMap);
  const hasClientFilter = activeOnly || days !== null;
  let list;
  try {
    list = await fetchSessionsList(hasClientFilter ? null : limit, pinnedIds, projectFilter);
  } catch (e) {
    reportCliError(e);
    return 1;
  }
  const pinOf = id => pinsMap[id] || null;
  if (activeOnly) list = list.filter(s => pinOf(s.id) || isSessionActive(s));
  if (days !== null) {
    const cutoff = Date.now() - days * 86_400_000;
    list = list.filter(s => pinOf(s.id) || (s.modifiedAt && new Date(s.modifiedAt).getTime() >= cutoff));
  }
  const pinRank = id => pinOf(id) === 'sticky' ? 0 : pinOf(id) === 'pinned' ? 1 : 2;
  list.sort((a, b) => {
    const r = pinRank(a.id) - pinRank(b.id);
    if (r !== 0) return r;
    return new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0);
  });
  if (limit !== null && list.length > limit) {
    const top = list.slice(0, limit);
    const topIds = new Set(top.map(s => s.id));
    const extraPinned = list.filter(s => pinOf(s.id) && !topIds.has(s.id));
    list = [...top, ...extraPinned];
  }
  if (asJson) {
    console.log(JSON.stringify(list.map(s => ({ ...s, pinState: pinOf(s.id) })), null, 2));
    return 0;
  }
  if (!list.length) {
    console.log('No sessions match.');
    return 0;
  }
  const rows = list.map(s => ({
    id: s.id.slice(0, 8),
    pin: pinOf(s.id) || '',
    status: sessionStatus(s),
    age: s.modifiedAt ? formatAge(Date.now() - new Date(s.modifiedAt).getTime()) : '-',
    tasks: `${s.completed}/${s.taskCount}`,
    project: path.basename(s.project || ''),
    title: s.customTitle || s.name || s.slug || '',
  }));
  const w = {
    id: 8,
    pin: Math.max(3, ...rows.map(r => r.pin.length)),
    status: Math.max(6, ...rows.map(r => r.status.length)),
    age: Math.max(3, ...rows.map(r => r.age.length)),
    tasks: Math.max(5, ...rows.map(r => r.tasks.length)),
    project: Math.max(7, ...rows.map(r => r.project.length)),
  };
  console.log(`${'ID'.padEnd(w.id)}  ${'PIN'.padEnd(w.pin)}  ${'STATUS'.padEnd(w.status)}  ${'AGE'.padEnd(w.age)}  ${'TASKS'.padEnd(w.tasks)}  ${'PROJECT'.padEnd(w.project)}  TITLE`);
  for (const r of rows) {
    console.log(`${r.id.padEnd(w.id)}  ${r.pin.padEnd(w.pin)}  ${r.status.padEnd(w.status)}  ${r.age.padEnd(w.age)}  ${r.tasks.padEnd(w.tasks)}  ${r.project.padEnd(w.project)}  ${r.title}`);
  }
  return 0;
}

function formatAge(ms) {
  if (ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

async function runSessionOpenCli(args) {
  const idArg = args.find(a => !a.startsWith('--'));
  if (!idArg) {
    printLeafHelp(COMMANDS.session.verbs.open);
    return 1;
  }
  const resolved = await resolveSessionByIdOrPrefix(idArg);
  if (!resolved) return 1;
  try {
    if (!await cliPostJson('/api/session/open', { id: resolved.id }, 'Open')) return 1;
    console.log(`Session opened: ${resolved.id}${resolved.customTitle ? ` (${resolved.customTitle})` : ''}`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runSessionPinCli(args) {
  const idArg = args.find(a => !a.startsWith('--'));
  if (!idArg) {
    printLeafHelp(COMMANDS.session.verbs.pin);
    return 1;
  }
  const state = args.includes('--unpin') ? 'none' : args.includes('--sticky') ? 'sticky' : 'pinned';
  const resolved = await resolveSessionByIdOrPrefix(idArg);
  if (!resolved) return 1;
  try {
    if (!await cliPostJson('/api/session/pin', { id: resolved.id, state }, 'Pin')) return 1;
    const label = state === 'none' ? 'unpinned' : state;
    console.log(`Session ${label}: ${resolved.id}${resolved.customTitle ? ` (${resolved.customTitle})` : ''}`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runSessionViewCli(args) {
  const idArg = args.find(a => !a.startsWith('--'));
  if (!idArg) {
    printLeafHelp(COMMANDS.session.verbs.view);
    return 1;
  }
  const asJson = args.includes('--json');
  const rateLimits = asJson ? null : cliGetJson('/api/rate-limits', 'Rate limits').catch(() => ({}));
  const resolved = await resolveSessionByIdOrPrefix(idArg);
  if (!resolved) return 1;
  let list;
  try {
    list = await fetchSessionsList(null);
  } catch (e) { reportCliError(e); return 1; }
  const s = list.find(x => x.id === resolved.id);
  if (!s) {
    console.error(`Session ${resolved.id} not found in /api/sessions response.`);
    return 1;
  }
  if (asJson) {
    console.log(JSON.stringify(s, null, 2));
    return 0;
  }
  const status = sessionStatus(s);
  const title = s.customTitle || s.name || s.slug || '';
  const age = s.modifiedAt ? formatAge(Date.now() - new Date(s.modifiedAt).getTime()) : '-';
  const fmtTok = (n) => typeof n === 'number' ? (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)) : '-';
  const fmtCost = (n) => typeof n === 'number' ? `$${n.toFixed(2)}` : '-';
  const lines = [];
  lines.push(`${s.id.slice(0, 8)} — ${title} [${status}]`);
  if (s.project) lines.push(`  ${path.basename(s.project)}${s.gitBranch ? ` · ${s.gitBranch}` : ''} · modified ${age} ago`);
  lines.push(`  Tasks: ${s.completed}/${s.taskCount}${s.inProgress ? ` (${s.inProgress} in progress)` : ''}${s.pending ? ` · ${s.pending} pending` : ''}`);
  const ctx = s.contextStatus;
  if (ctx) {
    const cw = ctx.context_window || {};
    const cost = ctx.cost || {};
    const modelName = ctx.model?.display_name || ctx.model?.id || '-';
    const modelExtras = [
      ctx.effort?.level,
      ctx.thinking?.enabled ? 'thinking' : null,
      ctx.fast_mode ? 'fast' : null,
    ].filter(Boolean).join(' · ');
    lines.push(`  Model: ${modelName}${modelExtras ? ` (${modelExtras})` : ''}`);
    if (cw.used_percentage != null) {
      lines.push(`  Context: ${cw.used_percentage}% used · ${fmtTok(cw.total_input_tokens)} in${cw.total_output_tokens != null ? ` / ${fmtTok(cw.total_output_tokens)} out` : ''} · cache ${fmtTok(cw.current_usage?.cache_read_input_tokens)} read`);
    }
    const timing = cost.total_duration_ms != null
      ? ` · ${cost.total_api_duration_ms != null ? formatAge(cost.total_api_duration_ms) : '-'} api / ${formatAge(cost.total_duration_ms)} total · +${cost.total_lines_added || 0}/-${cost.total_lines_removed || 0}`
      : '';
    lines.push(`  Cost: ${fmtCost(cost.total_cost_usd)}${timing}`);
  }
  // Account-wide, so not read from this session's file, which can be days old.
  const rl = await rateLimits;
  if (rl.five_hour || rl.seven_day) {
    lines.push(`  Limits: 5h ${rl.five_hour?.used_percentage ?? '-'}% · 7d ${rl.seven_day?.used_percentage ?? '-'}%`);
  }
  if (s.jsonlPath) lines.push(`  Transcript: ${s.jsonlPath}`);
  console.log(lines.join('\n'));
  return 0;
}

function printTable(header, rows) {
  const last = header.length - 1;
  const width = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const line = cells => cells.map((c, i) => (i === last ? String(c) : String(c).padEnd(width[i]))).join('  ');
  console.log(line(header));
  for (const r of rows) console.log(line(r));
}

const ageOf = (iso) => (iso ? formatAge(Date.now() - new Date(iso).getTime()) : '-');

async function cliGetJson(urlPath, label) {
  const res = await cliFetch(urlPath);
  if (!res.ok) throw new Error(`${label} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function runSessionSearchCli(args) {
  const entry = COMMANDS.session.verbs.search;
  const text = positionals(args, ['--limit']).join(' ').trim();
  if (!text) {
    printLeafHelp(entry);
    return 1;
  }
  if (text.length < 3) return usageError(entry, 'Search text needs at least 3 characters.');
  const parsed = parseLimit(args, { fallback: 20 });
  if (!parsed.ok) return usageError(entry, parsed.error);
  try {
    const ids = (await cliGetJson(`/api/sessions/search?q=${encodeURIComponent(text)}`, 'Search')).slice(0, parsed.limit);
    const list = ids.length ? await cliGetJson(`/api/sessions?limit=1&include=${ids.join(',')}`, 'Search') : [];
    const byId = new Map(list.map(s => [s.id, s]));
    const rows = ids.map(id => byId.get(id) || { id });
    if (args.includes('--json')) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (!rows.length) {
      console.log(`No sessions match "${text}".`);
      return 0;
    }
    printTable(['ID', 'STATUS', 'AGE', 'PROJECT', 'TITLE'], rows.map(s => [
      s.id.slice(0, 8),
      byId.has(s.id) ? sessionStatus(s) : '-',
      ageOf(s.modifiedAt),
      path.basename(s.project || ''),
      s.customTitle || s.name || s.slug || '',
    ]));
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runSessionPlanCli(args) {
  const [idArg] = positionals(args, []);
  if (!idArg) {
    printLeafHelp(COMMANDS.session.verbs.plan);
    return 1;
  }
  const resolved = await resolveSessionByIdOrPrefix(idArg);
  if (!resolved) return 1;
  try {
    const plan = await cliGetJson(`/api/sessions/${resolved.id}/plan`, 'Plan');
    if (args.includes('--json')) console.log(JSON.stringify(plan, null, 2));
    else if (!plan.content) console.log(`No plan saved for session ${resolved.id.slice(0, 8)}.`);
    else process.stdout.write(plan.content.endsWith('\n') ? plan.content : `${plan.content}\n`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runSessionAgentsCli(args) {
  const [idArg] = positionals(args, []);
  if (!idArg) {
    printLeafHelp(COMMANDS.session.verbs.agents);
    return 1;
  }
  const resolved = await resolveSessionByIdOrPrefix(idArg);
  if (!resolved) return 1;
  try {
    const out = await cliGetJson(`/api/sessions/${resolved.id}/agents`, 'Agents');
    if (args.includes('--json')) {
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    const agents = out.agents || [];
    if (!agents.length) console.log(`No agents for session ${resolved.id.slice(0, 8)}.`);
    else {
      printTable(['AGENT', 'STATUS', 'AGE', 'TYPE', 'DESCRIPTION'], agents.map(a => [
        String(a.agentId || '').slice(0, 8),
        a.status || '-',
        ageOf(a.updatedAt || a.startedAt),
        a.type || a.agentType || '',
        (a.description || a.name || '').replace(/\s+/g, ' ').trim(),
      ]));
    }
    if (out.waitingForUser) console.log('Waiting for the user.');
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runTaskListCli(args) {
  const entry = COMMANDS.task.verbs.list;
  const [sessionArg] = positionals(args, ['--project', '--status']);
  const project = getArgValue(args, 'project');
  const all = args.includes('--all');
  const status = getArgValue(args, 'status');
  const sources = [sessionArg, project, all || null].filter(Boolean).length;
  if (sources === 0) {
    printLeafHelp(entry);
    return 1;
  }
  if (sources > 1) return usageError(entry, 'Give one of <session>, --project or --all.');
  if (args.includes('--status') && !status) return usageError(entry, '--status needs a value, e.g. in_progress');
  let tasks;
  let resolved = null;
  try {
    if (sessionArg) {
      resolved = await resolveSessionByIdOrPrefix(sessionArg);
      if (!resolved) return 1;
      tasks = await cliGetJson(`/api/sessions/${resolved.id}`, 'Task list');
    } else if (project) {
      const encoded = Buffer.from(canonicalDir(project), 'utf8').toString('base64');
      tasks = await cliGetJson(`/api/projects/${encodeURIComponent(encoded)}/tasks`, 'Task list');
    } else {
      tasks = await cliGetJson('/api/tasks/all', 'Task list');
    }
  } catch (e) { reportCliError(e); return 1; }
  if (status) tasks = tasks.filter(t => t.status === status);
  if (args.includes('--json')) {
    console.log(JSON.stringify(tasks, null, 2));
    return 0;
  }
  if (!tasks.length) {
    console.log('No tasks match.');
    return 0;
  }
  const showSource = !resolved;
  const header = ['ID', 'STATUS', ...(showSource ? ['SESSION'] : []), 'SUBJECT'];
  printTable(header, tasks.map(t => [
    t.id,
    t.status || '-',
    ...(showSource ? [String(t.sessionId || t._taskDir || '').slice(0, 8)] : []),
    `${t.subject || ''}${t.blockedBy?.length ? `  (blocked by ${t.blockedBy.join(', ')})` : ''}`,
  ]));
  return 0;
}

async function runProjectListCli(args) {
  let projects;
  try {
    projects = await cliGetJson('/api/projects', 'Project list');
  } catch (e) { reportCliError(e); return 1; }
  projects.sort((a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0));
  if (args.includes('--json')) {
    console.log(JSON.stringify(projects, null, 2));
    return 0;
  }
  if (!projects.length) {
    console.log('No projects.');
    return 0;
  }
  printTable(['AGE', 'PATH'], projects.map(p => [ageOf(p.modifiedAt), `${p.path}${p.temp ? '  (temp)' : ''}`]));
  return 0;
}

function positionals(args, valueFlags) {
  return args.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
}

// The server matches the folder against known project paths by string, so an 8.3 short name
// or a differently cased drive letter from the shell must become the long, canonical form.
function canonicalDir(dir) {
  try { return fs.realpathSync.native(cliPath(dir)); } catch (_) { return cliPath(dir); }
}

// Every path argument goes through here. Git Bash hands a native node `/c/x` for `C:\x`.
function cliPath(arg) {
  return path.resolve(process.platform === 'win32' ? arg.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:/') : arg);
}

function textArg(args, name) {
  const file = getArgValue(args, `${name}-file`);
  return file ? fs.readFileSync(cliPath(file), 'utf8') : getArgValue(args, name);
}

async function runDispatchStartCli(argv) {
  const sep = argv.indexOf('--');
  const args = sep === -1 ? argv : argv.slice(0, sep);
  const claudeArgs = sep === -1 ? [] : argv.slice(sep + 1);
  const port = cliTargetPort();
  if (port === null) {
    console.error(unreachable());
    return 1;
  }
  const token = port && readCckJson(`terminal-tokens/${port}.json`)?.token;
  if (!token) {
    console.error(`No terminal token for ${displayPath(getClaudeDir())} at ${cliBaseUrl()}. The cck server must be running with the terminal enabled.`);
    return 1;
  }
  let spec;
  try { spec = textArg(args, 'spec'); } catch (e) { console.error(e.message); return 1; }
  if (!spec) {
    printLeafHelp(COMMANDS.dispatch.verbs.start);
    return 1;
  }
  const hasGroup = args.some(a => a === '--group' || a.startsWith('--group='));
  const group = hasGroup ? getArgValue(args, 'group') || '' : null;
  if (hasGroup && !isGroupName(group)) {
    const hint = suggestGroupName(group);
    return usageError(COMMANDS.dispatch.verbs.start, `Group names are kebab-case${hint ? `: try --group ${hint}` : ', e.g. auth-refactor'}`);
  }
  const worktree = args.includes('--worktree') ? getArgValue(args, 'worktree') || true : false;
  const body = {
    cwd: canonicalDir(getArgValue(args, 'cwd') || '.'),
    spec,
    name: getArgValue(args, 'name'),
    model: getArgValue(args, 'model'),
    worktree,
    group,
    claudeArgs,
    parent: process.env.CLAUDE_CODE_SESSION_ID || null,
  };
  try {
    const out = await cliPostJson('/api/dispatch', body, 'Dispatch', { 'x-terminal-token': token });
    if (!out) return 1;
    if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
    else console.log(`Started session ${out.session} in ${out.cwd}${out.group ? ` [${out.group}]` : ''}`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runDispatchListCli(args) {
  const q = new URLSearchParams();
  if (!args.includes('--all') && process.env.CLAUDE_CODE_SESSION_ID) q.set('parent', process.env.CLAUDE_CODE_SESSION_ID);
  try {
    const res = await cliFetch(`/api/dispatch?${q}`);
    const rows = (await res.json()).running.sort((a, b) => b.startedAt - a.startedAt);
    if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log('No dispatches.');
    else for (const r of rows) console.log(`${r.session}${r.name ? `  ${r.name}` : ''}${r.group ? `  [${r.group}]` : ''}`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runSkillsGetCli(args) {
  const name = args.find(a => !a.startsWith('--'));
  const file = name && /^[a-z][a-z-]*$/.test(name) ? path.join(__dirname, 'skill-guides', `${name}.md`) : null;
  if (!file || !fs.existsSync(file)) {
    const known = fs.readdirSync(path.join(__dirname, 'skill-guides')).map(f => f.replace(/\.md$/, ''));
    return usageError(COMMANDS.skills.verbs.get, `Unknown skill guide: ${name || '(none)'}. Known: ${known.join(', ')}`);
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  return 0;
}

module.exports = { runCli, COMMANDS };

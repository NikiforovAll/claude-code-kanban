---
title: CLI reference
description: Flags and subcommands of the claude-code-kanban command, from starting the server to dispatching tasks.
---

The npm package `claude-code-kanban` installs one command, `claude-code-kanban`. With no subcommand it starts the server. With a subcommand it talks to a server that already runs. It needs Node.js 20 or later.

```bash
npm install -g claude-code-kanban
claude-code-kanban --open
```

`npx claude-code-kanban` runs the command with no global install. See [Install the command](/claude-code-kanban/getting-started/#install-the-command).

## Help and version

| Command | Result |
| --- | --- |
| `claude-code-kanban --help`, `-h` | Top-level help: each command with its subcommand names, server flags and environment. |
| `claude-code-kanban help <command>` | The subcommands of a command, for example `help session`. |
| `claude-code-kanban help <command> <subcommand>` | Flags, notes and examples of a subcommand, for example `help session list`. |
| `claude-code-kanban <command> [<subcommand>] --help` | Same as `help <command> [<subcommand>]`. |
| `claude-code-kanban --version`, `-v` | Prints the version and exits. |

An unknown command or subcommand, or a command without its subcommand, prints an error or the help, and exits with code 1. A missing argument prints the subcommand's help. A bad value prints the error and the `help` command to run. Both exit with code 1.

## Server

`claude-code-kanban` with no subcommand starts the server. On start it prints:

```text
Claude Task Kanban running at http://localhost:3541
```

| Flag | Environment variable | What it does |
| --- | --- | --- |
| `--open` | | Opens the board in your browser after the server starts. |
| `--dir <path>` | `CLAUDE_CONFIG_DIR`, then `CLAUDE_DIR` | Claude config dir to read. Default `~/.claude`. A leading `~` expands to your home dir. |
| `--enable-terminal` | `CCK_TERMINAL='{"enabled":true}'` | Turns on the [embedded terminal](/claude-code-kanban/guides/embedded-terminal/). It is off by default when Claude Code Kanban runs alone. |
| `--terminal-shell <value>` | `CCK_TERMINAL_SHELL` | Shell for the terminal: `gitbash`, a program on `PATH` (`pwsh`, `cmd`, `zsh`) or a path. Default on Windows is `pwsh`, then `powershell`. Elsewhere it is `$SHELL`, then `/bin/sh`. |
| `--host <addr>` | `HOST` | Address to listen on. Default `127.0.0.1`. |
| `--allowed-hosts=<list>` | `ALLOWED_HOSTS` | Comma-separated extra `Host` header values to accept. |
| `--marketplace-url <url>` | `MARKETPLACE_URL` | Link to Claude Code Marketplace. |
| `--cost-url <url>` | `COST_URL` | Link to Claude Code Cost. |
| `--memory-url <url>` | `MEMORY_URL` | Link to Claude Code Memory. |

A flag wins over its environment variable.

### Port

Set the port with the `PORT` environment variable. The default is 3541.

```bash
PORT=8080 claude-code-kanban
```

If the port is busy, the server prints `Port 3541 in use, trying random port...` and listens on a random free port.

:::caution
The top-level help lists a `--port <n>` flag. The server does not read it. Use `PORT=<n>`.
:::

### Network access

The server answers only requests addressed to localhost, and it has no authentication. To reach the board from another machine, use `--host` and `--allowed-hosts`. See [Network and security](/claude-code-kanban/reference/configuration/#network-and-security).

### Terminal banner

When the terminal is on and the server runs outside Claude Code Hub, the server also prints a link with the terminal token:

```text
Terminal enabled - open http://localhost:3541/#t=<token>
```

Open that link to use the terminal. The token changes on each start unless you set `CCK_TERMINAL_TOKEN`. If the terminal backend cannot load, the server prints `Terminal unavailable: <reason>`.

## Install and uninstall

| Flag | What it does |
| --- | --- |
| `--install` | Installs the Claude Code plugin: hooks, skills and the mod that records context use and cost. |
| `--uninstall` | Removes what `--install` added. |
| `--yes` | With `--install`: installs the plugin with no prompt. |
| `--dir <path>` | Installs into or removes from another Claude config dir. `CLAUDE_CONFIG_DIR` works too. |

```bash
claude-code-kanban --install
claude-code-kanban --uninstall
claude-code-kanban --install --dir ~/.claude-work
```

`--install` asks a `[Y/n]` question before it installs the plugin, unless you pass `--yes`. It stops if the `claude` CLI is missing. For each install step and what `--uninstall` removes, see [Install the integration](/claude-code-kanban/getting-started/#install-the-integration).

## How commands find the server

Every subcommand below sends requests to `http://127.0.0.1:<port>`. The CLI picks the server in this order:

1. The `CCK_URL` environment variable, a full base URL such as `http://127.0.0.1:4795`.
2. The `PORT` environment variable.
3. The port in `<config-dir>/.cck/server.json`. If the process that wrote it no longer runs, the command fails: port 3541 can be the board of another config dir.
4. 3541, when there is no `server.json`.

The server writes `server.json` on start, so the CLI finds a server that fell back to a random port. Pass the same `--dir` (or `CLAUDE_CONFIG_DIR`) that the server uses. If no server answers, the command fails with:

```text
Cannot reach cck server for ~/.claude on port 3541. Start it first with "claude-code-kanban".
```

Commands that change the browser view (`doc preview`, `session open`) act on board tabs that are open at that moment. With no tab open, nothing shows. `doc link` and `session pin` are also kept by the server, so a tab that opens later shows them.

`doc preview` is the only command that opens something on the user's screen. `doc link` and `pane add` change nothing on screen, so prefer them while the user works.

## doc

Links documents to a session, or shows one in the preview. Where a command takes `--session <id>`, you can give the full session id or a unique prefix. Without the flag, the CLI uses `$PREVIEW_SESSION`, else `$CLAUDE_CODE_SESSION_ID`, which Claude Code sets for its own session. The one exception is `doc preview` of a file, which reads `$PREVIEW_SESSION` only, because there the session switches the focus of the board.

### doc link

```bash
claude-code-kanban doc link <file|url> [--session <id>]
```

Links a file or a web URL to the session in the sidebar. It does not open the preview.

An argument that starts with `http://` or `https://` is linked as a URL. The server does not check that the page exists, and it stores the URL in a normal form: the scheme and host in lower case, with the rest as you typed it. Other schemes are refused. A file argument resolves against the current directory and must exist.

The server keeps linked documents in `<config-dir>/.cck/linked-docs.json`, up to 200 per session. Each board tab adds them to its own list when it connects, so a link made with no tab open shows when one opens. In that case the command also prints `No browser tab is open; the board shows it when one opens.` Unlinking in the board removes the server copy too. See [Session log and details](/claude-code-kanban/guides/session-details/).

### doc unlink

```bash
claude-code-kanban doc unlink <file|url> [--session <id>]
```

Removes the link. The file does not need to exist.

### doc list

```bash
claude-code-kanban doc list [--session <id>] [--json]
```

Prints the documents the server keeps for the session.

### doc preview

```bash
claude-code-kanban doc preview <file.md|file.html|url> [--session <id>]
```

Opens a Markdown or HTML file in the preview modal on every connected board tab.

| Flag | What it does |
| --- | --- |
| `--session <id>` | Switches the focused session in the browser. It does not link the file to the session. `$PREVIEW_SESSION` is used when you omit the flag. For a URL, the session that the URL is linked to, with the usual default. |

Put the file path first. The CLI reads the first argument that does not start with `--` as the file. On success it prints `Preview opened: <absolute path>`.

The preview cannot show a web page. With an `http://` or `https://` URL, `doc preview` links it to the session, the same as `doc link`, and prints `URL linked to session <id>: <url>`. A browser opens a new tab only after a click, so the board tab on screen shows a message with an **Open** button for 8 seconds. Tabs that are not on screen show the message without the button.

## pane

Adds live panes to a session's view: a web URL or a local file, each a tab next to Board. The commands take `--session` like `doc`.

### pane add

```bash
claude-code-kanban pane add <url|file> [--title <text>] [--session <id>] [--json]
```

Adds a pane and prints its id and title. The board does not switch to it; the user opens the tab. The same target added again prints the pane it already has, marked `(already there)`. A URL on the board's or the hub's own origin is refused. A file must be one the board can preview: HTML, markdown, text or an image. A relative path resolves against the current directory.

A site whose headers refuse framing (`X-Frame-Options` or CSP `frame-ancestors`) is still added, and a note line says that its pane shows an "Open in new tab" card. `--json` prints the new pane with `frameable`: `true`, `false`, or `null` when the check could not tell.

### pane rm

```bash
claude-code-kanban pane rm <pane-id> [--session <id>]
```

Removes the pane.

### pane list

```bash
claude-code-kanban pane list [--session <id>] [--json]
```

Lists the session's panes in tab order as a table of id, kind, title and target. `--json` prints `{rev, panes: [{id, kind, target, title, addedAt}], updatedAt}`.

## session

Lists and opens Claude Code sessions. Where a command takes `<id>`, you can give the full session id or a unique prefix. An ambiguous prefix prints the matching sessions and fails.

### session list

```bash
claude-code-kanban session list [--active] [--days <n>] [--project <name>] [--limit <n|all>] [--no-pins] [--json]
```

| Flag | What it does |
| --- | --- |
| `--active` | Only sessions with recent activity, as in the sidebar's Active filter. |
| `--days <n>` | Only sessions changed in the last `n` days. Fractions work, for example `0.5`. |
| `--project <name>` | Only sessions of matching projects. An absolute path selects that one project. Other text matches any part of the project path. The match ignores case, and `\` and `/` are the same. |
| `--limit <n\|all>` | Maximum rows. Default 10. `all` removes the limit. |
| `--no-pins` | Treats pinned sessions like other sessions. |
| `--json` | Prints JSON. Each entry has a `pinState` field. |

By default pinned and sticky sessions are always in the list, even past the limit or outside the `--active` and `--days` filters. `--project` still removes them. Sticky sessions come first. The table has the columns `ID`, `PIN`, `STATUS` (`idle`, `active`, `busy` or `wait`), `AGE`, `TASKS`, `PROJECT` and `TITLE`.

### session search

```bash
claude-code-kanban session search <text> [--limit <n>] [--json]
```

Finds sessions whose name or id contains the text, from every transcript, newest first. The text needs at least 3 characters. `--limit` sets the maximum rows; the default and maximum are 20. The table has the columns `ID`, `STATUS`, `AGE`, `PROJECT` and `TITLE`.

### session open

```bash
claude-code-kanban session open <id>
```

Focuses the session in connected board tabs.

### session view

```bash
claude-code-kanban session view <id> [--json]
```

Prints the session's title, status, project, branch and task counts. When the plugin's mod has recorded the session, it also prints the model, context window use, cost and rate limits. The last line is the path of the session's transcript (`Transcript: <path>.jsonl`): to learn what a session did, read it. `--json` prints the full session object, with the path in `jsonlPath`.

### session pin

```bash
claude-code-kanban session pin <id> [--sticky] [--unpin]
```

Pins the session in the sidebar. `--sticky` makes it sticky: always shown, at the top of the list. `--unpin` clears the pin and the sticky state. The server keeps pins in `<config-dir>/.cck/pins.json`, so `session list` sees them.

### session plan

```bash
claude-code-kanban session plan <id> [--json]
```

Prints the plan that plan mode saved for the session, or `No plan saved for session <id>.` `--json` prints `{content, slug}`.

### session agents

```bash
claude-code-kanban session agents <id> [--json]
```

Lists the subagents of the session with the columns `AGENT`, `STATUS`, `AGE`, `TYPE` and `DESCRIPTION`, and prints `Waiting for the user.` when the session waits for an answer. It needs the cck hooks in the config dir (`--install`). `--json` prints `{agents, waitingForUser}`.

## task list

```bash
claude-code-kanban task list (<session> | --project <path> | --all) [--status <s>] [--json]
```

Lists tasks. Give one source: a session id or unique prefix, `--project` with a project path (as `project list` prints it), or `--all` for every task on the board. `--status` keeps only tasks in that status, for example `in_progress`. The table has the columns `ID`, `STATUS` and `SUBJECT`, plus `SESSION` for `--project` and `--all`. The command only reads; to change a task, use the board.

## project list

```bash
claude-code-kanban project list [--json]
```

Lists the project paths the board knows, newest activity first. These are the folders `dispatch start --cwd` accepts. A path under the OS temp dir is marked `(temp)`.

## dispatch

Starts a Claude Code session in the embedded terminal to do a task. See [Dispatch tasks to other sessions](/claude-code-kanban/guides/dispatch/) for how to use it.

### dispatch start

```bash
claude-code-kanban dispatch start --cwd <dir> (--spec <text> | --spec-file <path>) [--name <n>] [--group <g>] [--model <m>] [--worktree [name]] [--task-list [id]] [--json] [-- <claude args>...]
```

| Flag | What it does |
| --- | --- |
| `--cwd <dir>` | Folder to run in. Default is the current folder. It must be a known project (a folder where a session already ran) or a folder picked in the New session dialog during this server run. |
| `--spec <text>` | The task. Write it so that it makes sense with no other context. |
| `--spec-file <path>` | Reads the task from a file. |
| `--name <n>` | Session name: up to 80 letters, digits, spaces, `.`, `_` and `-`. The first character must be a letter or a digit. It is also the session's peer name for `SendMessage`. |
| `--group <g>` | Shows the new session in this [session group](/claude-code-kanban/guides/session-groups/). The name must be kebab-case, for example `auth-refactor`. Default is the group of the session that runs the command. |
| `--model <m>` | `fable`, `opus`, `sonnet` or `haiku`. |
| `--worktree [name]` | Runs the session in a new git worktree. |
| `--task-list [id]` | The session uses this task list instead of its own. With no value, it uses the current session's list. Off unless given. See [Share one task list](/claude-code-kanban/guides/dispatch/#share-one-task-list). |
| `--json` | Prints JSON. |
| `-- <claude args>` | Everything after `--` goes to `claude` as it is, for example `-- --permission-mode auto`. See [Pass claude flags](/claude-code-kanban/guides/dispatch/#pass-claude-flags). |

On success it prints:

```text
Started session <uuid> in <cwd> [group]
```

cck sends no report back. Say in the spec how the session reports, for example with `SendMessage`.

`dispatch start` reads the terminal token from `<config-dir>/.cck/terminal-tokens/<port>.json`, where `<port>` is the port of the board it reaches. The server writes that file only when the terminal is on. Without it the command fails with `No terminal token for <dir> at <board-url>. The cck server must be running with the terminal enabled.` Other refusals:

- `403 folder is not a known project or a folder picked in this run` when the folder is not a known project.
- `429 30 terminals are open; end one first` when all terminals are in use (30 by default).
- `400 invalid name`, `invalid worktree name`, `invalid task list id`, `invalid model` or `invalid prompt` when a value is not valid or the spec is longer than 32 KB.
- A group name that is not kebab-case. The CLI suggests a fixed name, for example `try --group auth-refactor`.
- `invalid claude arg: no quotes, % or control characters`, or `cck sets <flag>` for a flag cck owns, after `--`.

The command records the session that ran it, from `CLAUDE_CODE_SESSION_ID`, as the parent. `dispatch list` uses it.

### dispatch list

```bash
claude-code-kanban dispatch list [--all] [--json]
```

Lists the sessions that the current session started and that still run in the board's terminal. Outside Claude Code, where `CLAUDE_CODE_SESSION_ID` is not set, it lists every one on the board. `--all` lists every one on this board.

The list lives in the server's memory. A session leaves it when its terminal ends, and a server restart clears it.

## skills get

```bash
claude-code-kanban skills get <name>
```

Prints a guide that ships with this version. The only guide now is `dispatch`, which the [dispatch skill](/claude-code-kanban/guides/plugin-skills/) loads. An unknown name prints the known names.

## Environment used by the CLI

| Variable | Used by |
| --- | --- |
| `CCK_URL` | Full base URL that subcommands connect to. Wins over `PORT` and `server.json`. |
| `PORT` | The server port, and the port that subcommands connect to. |
| `CLAUDE_CONFIG_DIR`, `CLAUDE_DIR` | Config dir, when `--dir` is not given. |
| `CLAUDE_CODE_SESSION_ID` | Set by Claude Code. Default for `--session` in `doc` and `pane`, after `PREVIEW_SESSION` (see [doc](#doc)). `dispatch start` records it as the parent. `dispatch list` uses it to find your dispatches. |
| `PREVIEW_SESSION` | First default for `--session` in `doc` and `pane`. |

For server and terminal settings, see [Configuration](/claude-code-kanban/reference/configuration/).

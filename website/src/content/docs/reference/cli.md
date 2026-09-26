---
title: CLI reference
description: Flags and subcommands of the claude-code-kanban command, from starting the server to dispatching tasks.
---

The npm package `claude-code-kanban` installs one command, `claude-code-kanban`. With no subcommand it starts the server. With a subcommand it talks to a server that already runs. It needs Node.js 20 or later.

```bash
npx claude-code-kanban --open        # without a global install
npm install -g claude-code-kanban    # or install it once
claude-code-kanban --open
```

## Help and version

| Command | Result |
| --- | --- |
| `claude-code-kanban --help`, `-h` | Top-level help: all commands and server flags. |
| `claude-code-kanban <command> --help` | Help for a command or a subcommand, for example `session list --help`. |
| `claude-code-kanban help <command>` | Same as `<command> --help`. |
| `claude-code-kanban session` | A command without its subcommand prints the list of subcommands. |
| `claude-code-kanban --version`, `-v` | Prints the version and exits. |

An unknown command or subcommand prints an error, the help, and exits with code 1.

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
PORT=8080 npx claude-code-kanban
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
| `--install` | Installs the Claude Code plugin (hooks and skills), the context spy script and the statusLine. |
| `--uninstall` | Removes what `--install` added. |
| `--plugin-only` | With `--install`: refreshes only the plugin, with no prompt. Skips the context spy and the statusLine. |
| `--dir <path>` | Installs into or removes from another Claude config dir. `CLAUDE_CONFIG_DIR` works too. |

```bash
npx claude-code-kanban --install
npx claude-code-kanban --uninstall
npx claude-code-kanban --install --dir ~/.claude-work
```

`--install` asks a `[Y/n]` question before each change. It stops if the `claude` CLI is missing, and only warns if `jq` is missing. For each install step and what `--uninstall` removes, see [Install the integration](/claude-code-kanban/getting-started/#install-the-integration).

## How commands find the server

Every subcommand below sends requests to `http://127.0.0.1:<port>`. The CLI picks the port in this order:

1. The `PORT` environment variable.
2. The port in `<config-dir>/.cck/server.json`, if the process that wrote it still runs.
3. 3541.

The server writes `server.json` on start, so the CLI finds a server that fell back to a random port. Pass the same `--dir` (or `CLAUDE_CONFIG_DIR`) that the server uses. If no server answers, the command fails with:

```text
Cannot reach cck server for ~/.claude on port 3541. Start it first with "claude-code-kanban".
```

Commands that change the browser view (`preview-doc`, `link-doc`, `session open`, `session pin`) act on board tabs that are open at that moment. With no tab open, nothing shows.

## preview-doc

Opens a Markdown or HTML file in the preview modal on every connected board tab.

```bash
claude-code-kanban preview-doc <file.md|file.html> [--session <id>]
```

| Flag | What it does |
| --- | --- |
| `--session <id>` | Switches the focused session in the browser. It does not link the file to the session. `$PREVIEW_SESSION` is used when you omit the flag. |

Put the file path first. The CLI reads the first argument that does not start with `--` as the file. On success it prints `Preview opened: <absolute path>`.

## link-doc

Links a file to a session in the sidebar. It does not open the preview.

```bash
claude-code-kanban link-doc <file> --session <id> [--unlink]
```

| Flag | What it does |
| --- | --- |
| `--session <id>` | Session to link to. Required, unless `$PREVIEW_SESSION` is set. Accepts a unique id prefix. |
| `--unlink` | Removes the link. |

The board stores linked documents in the browser, so a link lands only in tabs that are open. See [Session log and details](/claude-code-kanban/guides/session-details/).

## session

Lists and opens Claude Code sessions. Where a command takes `<id>`, you can give the full session id or a unique prefix. An ambiguous prefix prints the matching sessions and fails.

### session list

```bash
claude-code-kanban session list [--active] [--days <n>] [--project <name>] [--limit <n|all>] [--no-pins] [--json]
```

| Flag | What it does |
| --- | --- |
| `--active` | Only sessions with recent activity, as in the sidebar's Active Only filter. |
| `--days <n>` | Only sessions changed in the last `n` days. Fractions work, for example `0.5`. |
| `--project <name>` | Only sessions whose project path contains `name`. The match ignores case. |
| `--limit <n\|all>` | Maximum rows. Default 10. `all` removes the limit. |
| `--no-pins` | Treats pinned sessions like other sessions. |
| `--json` | Prints JSON. Each entry has a `pinState` field. |

By default pinned and sticky sessions are always in the list, even past the limit or outside the `--active` and `--days` filters. `--project` still removes them. Sticky sessions come first. The table has the columns `ID`, `PIN`, `STATUS` (`idle`, `active`, `busy` or `wait`), `AGE`, `TASKS`, `PROJECT` and `TITLE`.

### session open

```bash
claude-code-kanban session open <id>
```

Focuses the session in connected board tabs.

### session view

```bash
claude-code-kanban session view <id> [--json]
```

Prints the session's title, status, project, branch and task counts. With the context spy installed, it also prints the model, context window use, cost and rate limits. `--json` prints the full session object.

### session pin

```bash
claude-code-kanban session pin <id> [--sticky] [--unpin]
```

Pins the session in the sidebar. `--sticky` makes it sticky: always shown, at the top of the list. `--unpin` clears the pin and the sticky state. The server keeps pins in `<config-dir>/.cck/pins.json`, so `session list` and `session pins` see them.

### session pins

```bash
claude-code-kanban session pins [--sticky] [--json]
```

Lists pinned sessions, sticky first. `--sticky` shows only sticky sessions.

### session peek

```bash
claude-code-kanban session peek <id> [--limit <n>] [--json]
```

Prints the last messages of a session, oldest first. `--limit` sets the count. The default is 10 and the maximum is 50.

## dispatch

Starts a Claude Code session in the embedded terminal to do a task, and collects its report. See [Dispatch tasks to other sessions](/claude-code-kanban/guides/dispatch/) for how to use it.

### dispatch start

```bash
claude-code-kanban dispatch start --cwd <dir> (--spec <text> | --spec-file <path>) [--name <n>] [--group <g>] [--report] [--model <m>] [--worktree [name]] [--json]
```

| Flag | What it does |
| --- | --- |
| `--cwd <dir>` | Folder to run in. Default is the current folder. It must be a known project (a folder where a session already ran) or a folder picked in the New session dialog during this server run. |
| `--spec <text>` | The task. Write it so that it makes sense with no other context. |
| `--spec-file <path>` | Reads the task from a file. |
| `--name <n>` | Session name: up to 80 letters, digits, spaces, `.`, `_` and `-`. The first character must be a letter or a digit. |
| `--group <g>` | Shows the new session in this [session group](/claude-code-kanban/guides/session-groups/). The name must be kebab-case, for example `auth-refactor`. Default is the group of the session that runs the command. |
| `--report` | Asks the new session to report its outcome back. |
| `--model <m>` | `fable`, `opus`, `sonnet` or `haiku`. |
| `--worktree [name]` | Runs the session in a new git worktree. |
| `--json` | Prints JSON. |

On success it prints:

```text
Started d_1a2b3c4d5e6f (session <uuid>) in <cwd> [group]
```

`dispatch start` reads the terminal token from `<config-dir>/.cck/terminal-token.json`. The server writes that file only when the terminal is on. Without it the command fails with `No terminal token for <dir>. The cck server must be running with the terminal enabled.` Other refusals:

- `403 folder is not a known project or a folder picked in this run` when the folder is not a known project.
- `429 20 terminals are open; end one first` when all terminals are in use (20 by default).
- `400 invalid name`, `invalid worktree name`, `invalid model` or `invalid prompt` when a value is not valid or the spec is longer than 32 KB.
- A group name that is not kebab-case. The CLI suggests a fixed name, for example `try --group auth-refactor`.

The command records the session that ran it, from `CLAUDE_CODE_SESSION_ID`, as the parent. `dispatch wait` and `dispatch list` use it.

### dispatch done

```bash
claude-code-kanban dispatch done <id> --cap <cap> --outcome succeeded|failed (--summary <text> | --summary-file <path>)
```

The started session runs this to report. With `--report`, its first prompt carries the dispatch id, the capability and the exact command. It prints `Reported <id>: <outcome>`.

A dispatch settles once. A second report fails with `already <status>`. The server keeps up to 4000 characters of the summary. If the session's terminal ends before it reports, the dispatch settles as `exited`.

### dispatch wait

```bash
claude-code-kanban dispatch wait [<id>...] [--timeout <dur>] [--json]
```

Waits until one of the dispatches settles. Without ids it waits on the dispatches that the current session started. Outside Claude Code, where `CLAUDE_CODE_SESSION_ID` is not set, it uses every dispatch on the board. `--timeout` takes a number with `s`, `m` or `h`, for example `90s`, `15m` or `1h`. A number with no unit is seconds. The default is `10m`.

It prints each settled dispatch with its status, session and summary, then the ones that still run. A timeout only marks a checkpoint. The command prints `Timed out; still running: <ids>` and exits with code 0. To keep waiting, run it again with the ids that still run. The command returns at once if a selected dispatch already settled.

### dispatch list

```bash
claude-code-kanban dispatch list [--all] [--json]
```

Lists the dispatches that the current session started, newest first. Outside Claude Code, where `CLAUDE_CODE_SESSION_ID` is not set, it lists every dispatch on the board. `--all` lists every dispatch on this board.

The server keeps dispatch records in memory. A server restart clears them. It keeps settled records for 24 hours.

## skills get

```bash
claude-code-kanban skills get <name>
```

Prints a guide that ships with this version. The only guide now is `dispatch`, which the [kanban-dispatch skill](/claude-code-kanban/guides/plugin-skills/) loads. An unknown name prints the known names.

## Environment used by the CLI

| Variable | Used by |
| --- | --- |
| `PORT` | The server port, and the port that subcommands connect to. |
| `CLAUDE_CONFIG_DIR`, `CLAUDE_DIR` | Config dir, when `--dir` is not given. |
| `CLAUDE_CODE_SESSION_ID` | Set by Claude Code. `dispatch start` records it as the parent. `dispatch wait` and `dispatch list` use it to find your dispatches. |
| `PREVIEW_SESSION` | Default for `--session` in `preview-doc` and `link-doc`. |

For server and terminal settings, see [Configuration](/claude-code-kanban/reference/configuration/).

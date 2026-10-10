---
title: Configuration
description: Every setting Claude Code Kanban reads, and every file it reads and writes.
---

Claude Code Kanban has no per-project configuration. You set it with command-line flags, environment variables and one optional JSON file in the config dir.

## Config dir

Claude Code Kanban works on one Claude Code config dir at a time. It picks the first value it finds, in this order:

1. `--dir <path>` or `--dir=<path>`
2. `CLAUDE_CONFIG_DIR`
3. `CLAUDE_DIR`
4. `~/.claude`

A leading `~` expands to your home directory.

The plugin goes into the config dir that `--install` targets. Pass the same `--dir` to `--install`, `--uninstall` and the server:

```sh
claude-code-kanban --install --dir=~/.claude-work
claude-code-kanban --dir=~/.claude-work --open
```

When the dir is not `~/.claude`, the installer runs the `claude` CLI with `CLAUDE_CONFIG_DIR` set to that dir.

## Environment variables

| Variable | Flag | What it does |
|---|---|---|
| `PORT` | `--port <n>` | Port for the server. Default `3541`. If the port is busy, the server listens on a random port. |
| `HOST` | `--host <addr>` | Address the server binds to. Default `127.0.0.1`. See [Network and security](#network-and-security). |
| `ALLOWED_HOSTS` | `--allowed-hosts=<list>` | Comma-separated extra `Host` header values the server accepts. |
| `EDITOR` | | Command for "Open in editor". Default `code`. A value with arguments, such as `code -w`, works. |
| `CCK_TERMINAL` | | JSON config for the embedded terminal. See [Terminal config](#terminal-config). |
| `CCK_TERMINAL_SHELL` | `--terminal-shell <value>` | Shell for the embedded terminal. |
| `CCK_TERMINALS_FILE` | | File that keeps the terminals to resume, in place of `<config-dir>/.cck/terminals.json`. Every server on a config dir rewrites that file, so a second server, such as a test board, sets this to its own path. The server does not clean it up. |
| `CCK_TERMINAL_TOKEN` | | Fixed token for the terminal WebSocket. When unset, the server makes a random token on each start. |
| `CCK_PRIORITY_BOOST` | | Windows only. With the terminal on, the server, each terminal's console host, and the process you type into in an attached terminal run at above-normal priority, so typing stays responsive while other work loads the CPU. Tools those processes start still run at normal priority. Set `0` to turn it off. The hub reads it too. |
| `MARKETPLACE_URL` | `--marketplace-url <url>` | URL of Claude Code Marketplace that the board links to. |
| `COST_URL` | `--cost-url <url>` | URL of Claude Code Cost that the board links to. |
| `MEMORY_URL` | `--memory-url <url>` | URL of Claude Code Memory that the board links to. |
| `CLAUDE_HUB` | | Set by [Claude Code Hub](/claude-code-kanban/guides/claude-code-hub/). Turns on hub integration. |
| `HUB_URL` | | Set by Claude Code Hub. The hub origin that may frame the app and send it messages. |

Flags win over environment variables.

## Terminal config

The embedded terminal is off when Claude Code Kanban runs alone. Turn it on with `--enable-terminal`, or with `"enabled": true` in `CCK_TERMINAL`. Inside Claude Code Hub it is on by default, and the hub passes its `terminal` block as `CCK_TERMINAL`.

```sh
CCK_TERMINAL='{"enabled":true,"fontSize":14}' claude-code-kanban
```

| Field | Default | What it does |
|---|---|---|
| `enabled` | `false` | Turns on the terminal. `--enable-terminal` does the same. |
| `shell` | Platform default | Shell to run. `--terminal-shell` and `CCK_TERMINAL_SHELL` win over it. |
| `maxSessions` | `30` | Most terminals open at the same time. |
| `fontFamily` | Built-in font | Terminal font. |
| `fontSize` | `13` | Font size in pixels. |
| `scrollback` | `5000` | Lines kept in the scrollback buffer. |
| `noFlicker` | `true` | Sets `CLAUDE_CODE_NO_FLICKER=1` for each `claude` the terminal starts. Set `false` to turn it off. |
| `restore` | `true` | Resumes the terminals that were open when the server last stopped. Set `false` to turn it off. See [Restore terminals on start](/claude-code-kanban/guides/embedded-terminal/#restore-terminals-on-start). |

For shell values and the default shell, see [Choose the shell](/claude-code-kanban/guides/embedded-terminal/#choose-the-shell). The terminal needs the optional dependency `@lydell/node-pty`. If it does not load, the terminal is not available and the server logs the reason.

## UI approvals config

You can answer permission prompts, questions and plans from the board. This is on by default. To turn it off or tune it, create `<config-dir>/.cck/config.json` with an `approvals` block:

```json
{
  "approvals": {
    "enabled": false
  }
}
```

| Field | Default | What it does |
|---|---|---|
| `enabled` | `true` | Only an explicit `false` turns board answers off. A missing or broken file means defaults. |
| `mode` | `"permission+question"` | `"permission+question"` lets the board answer permission asks, plans and questions. `"permission"` leaves questions to the terminal. |
| `waitSeconds` | `1800` | How long the plugin waits for an answer from the board. The maximum is `1800`. |

Each config dir has its own file. See [Answer prompts from the board](/claude-code-kanban/guides/waiting-prompts/).

## Board events config

Your card moves and review comments reach the session as prompts. This is on by default. To turn it off, add a `boardEvents` block to the same `<config-dir>/.cck/config.json`:

```json
{
  "boardEvents": {
    "enabled": false
  }
}
```

| Field | Default | What it does |
|---|---|---|
| `enabled` | `true` | Only an explicit `false` turns board events off. The server then queues no line for a move or a review, and a review falls back to the terminal or the clipboard. |

The server reads the file again when it changes, so no restart is needed. See [Steer a session from the board](/claude-code-kanban/guides/plugin-skills/#steer-a-session-from-the-board).

## Kanbot config

[Kanbot](/claude-code-kanban/guides/kanbot/) is on by default when the embedded terminal is on. To change it, add a `kanbot` block to the same `<config-dir>/.cck/config.json`:

```json
{
  "kanbot": {
    "enabled": true,
    "model": "sonnet"
  }
}
```

| Field | Default | What it does |
|---|---|---|
| `enabled` | `true` | Only an explicit `false` turns Kanbot off. The button goes away and the `/api/kanbot` routes answer `404`. |
| `model` | none | `fable`, `opus`, `sonnet` or `haiku`. Read at each start of Kanbot. Any other value is ignored, and Claude Code uses its default. |

The server reads the file again when it changes, so no restart is needed.

## Network and security

The server binds to `127.0.0.1` and also listens on `::1` on the same port. It has no authentication. Anyone who can reach the port can read your sessions.

To reach the board from another machine, bind to another address and allow its host name:

```sh
claude-code-kanban --host 0.0.0.0 --allowed-hosts=my-laptop.local
```

The server then prints `WARNING: listening on 0.0.0.0 - reachable from your network, with no authentication.` Do this only on a network you trust.

The server also applies these guards:

- **Host allowlist.** A request with a `Host` header that is not loopback, not in `--allowed-hosts` and not the bound address gets `403`. This blocks DNS rebinding.
- **Cross-origin writes.** The server refuses a request other than `GET`, `HEAD` or `OPTIONS` from another origin, or one that the browser marks as cross-site.
- **Framing.** When it runs alone, no other page can put the app in a frame. The one exception is the terminal page, `/terminal.html`: the board's own pages on `localhost` and `127.0.0.1`, on the same port, can frame it. See [Typing while the board is busy](/claude-code-kanban/guides/embedded-terminal/#typing-while-the-board-is-busy). Under Claude Code Hub, pages on `localhost` or `127.0.0.1` (any port) and pages on the hub's own origin can.
- **Terminal off loopback.** The server refuses the embedded terminal when it listens on an address other than loopback.
- **Terminal token.** The terminal WebSocket checks the `Host` and `Origin` headers. The client must then send the token in its first message within 5 seconds.

## Files it reads

The server reads these folders in the config dir:

| Path | Contents |
|---|---|
| `tasks/` | Task lists |
| `projects/` | Session transcripts (`.jsonl`) |
| `teams/` | Agent team configs |
| `plans/` | Plans |
| `sessions/` | Registry of running sessions |

It also reads each session's Claude Code scratchpad folder. It takes the folder from the session's transcript. When the transcript does not record it, or records it where the server did not read, it uses Claude Code's rule: `CLAUDE_CODE_TMPDIR` from `env` in `<config-dir>/settings.json` or from the server's environment, else `/tmp` on macOS and the system temp folder elsewhere, then `claude-<uid>` on macOS and Linux or `claude` on Windows. The server reads this once at start.

## Files it writes

The server, the plugin and the installer keep their state in `<config-dir>/.cck/`:

| Path | Written by | Contents |
|---|---|---|
| `agent-activity/<sessionId>/<agentId>.jsonl` | Plugin mod (`activity.ts`) | Subagent start, idle and stop events |
| `agent-activity/<sessionId>/_*` | Plugin mod, server | Markers for a waiting prompt and a finished turn, the board's answers to prompts, and team member name-to-id maps |
| `agent-activity/_task-maps/<task list id>.json` | Plugin mod | Sessions that share a task list through `CLAUDE_CODE_TASK_LIST_ID` |
| `context-status/<sessionId>.json` | Plugin mod (`context.ts`) | Context use, cost and model for each session |
| `pins.json` | Server | Session pins (`{sessionId: "pinned" \| "sticky"}`, at most 1000) and `pinsMigratedAt`, the time a board copied its browser pins here. Every board on the config dir reads it. |
| `linked-docs.json` | Server | Docs linked with `doc link`, so a link sent while no board is open is not lost |
| `dispatched.json` | Server | Sessions started with `dispatch start` |
| `groups.json` | Server | Session groups you make on the board |
| `dispatch-groups.json` | Server | Groups made with `dispatch start --group` |
| `panes.json` | Server | Pane layout of each session |
| `reviews/<sessionId>/<time>.md` | Server | Review comments sent to a session |
| `worktrees.json` | Server | Worktree paths and the repo each belongs to, so a worktree's sessions stay with their repo after the worktree is deleted |
| `terminals.json` | Server | Terminals to resume on the next start. See [Restore terminals on start](/claude-code-kanban/guides/embedded-terminal/#restore-terminals-on-start). |
| `session-cache.json` | Server | Session list cache, so the first list after a restart is fast. Safe to delete. |
| `server.json` | Server | `{port, pid}` of the running server. The CLI and the plugin use it to find the port. |
| `terminal-tokens/<port>.json` | Server | Terminal token of the board on `<port>` (file mode 600), used by `dispatch start`. Written only when the terminal is available. One file per board, so two boards on one config dir each keep their own. |
| `kanbot/` | Server, Kanbot | Kanbot's working folder: its prompt file, written at each start, and its memory in `.claude/agent-memory/` |
| `config.json` | You | Optional [UI approvals config](#ui-approvals-config), [board events config](#board-events-config) and [Kanbot config](#kanbot-config) |
| `plugin/` | Installer | Copy of the Claude Code plugin |

The server removes `server.json` and its `terminal-tokens/<port>.json` when it exits, if they still belong to it. At start it also removes token files left by servers that are no longer running.

The server deletes old entries every hour. Session data such as dispatch markers, pane layouts, reviews and context status goes when the session's transcript goes, or after Claude Code's `cleanupPeriodDays` (default 30). `agent-activity/` entries go after 2 days. `pins.json` and `linked-docs.json` change only when you pin, unpin, link or unlink, or when **Clean Orphaned** removes sessions that no longer exist.

## Browser-only data

Some data stays in the browser's `localStorage` and never reaches the server:

- Pinned messages
- Linked documents added on the board (links made with `doc link` are also in `linked-docs.json`)
- Scratchpad notes
- Kanbot's layout (floating, docked or expanded) and docked width

Each config dir other than `~/.claude` gets its own key prefix, so two config dirs on the same port do not share this data. Another browser or profile does not see it.

To remove data for sessions that no longer exist, open the Storage Manager with <kbd>Shift+S</kbd> and select **Clean Orphaned**. It also removes their pins from `pins.json` and their linked docs from `linked-docs.json`.

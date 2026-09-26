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

The plugin, the hooks and the statusLine go into the config dir that `--install` targets. Pass the same `--dir` to `--install`, `--uninstall` and the server:

```sh
npx claude-code-kanban --install --dir=~/.claude-work
npx claude-code-kanban --dir=~/.claude-work --open
```

When the dir is not `~/.claude`, the installer runs the `claude` CLI with `CLAUDE_CONFIG_DIR` set to that dir.

## Environment variables

| Variable | Flag | What it does |
|---|---|---|
| `PORT` | | Port for the server. Default `3541`. If the port is busy, the server listens on a random port. |
| `HOST` | `--host <addr>` | Address the server binds to. Default `127.0.0.1`. See [Network and security](#network-and-security). |
| `ALLOWED_HOSTS` | `--allowed-hosts=<list>` | Comma-separated extra `Host` header values the server accepts. |
| `EDITOR` | | Command for "Open in editor". Default `code`. A value with arguments, such as `code -w`, works. |
| `CCK_TERMINAL` | | JSON config for the embedded terminal. See [Terminal config](#terminal-config). |
| `CCK_TERMINAL_SHELL` | `--terminal-shell <value>` | Shell for the embedded terminal. |
| `CCK_TERMINAL_TOKEN` | | Fixed token for the terminal WebSocket. When unset, the server makes a random token on each start. |
| `MARKETPLACE_URL` | `--marketplace-url <url>` | URL of Claude Code Marketplace that the board links to. |
| `COST_URL` | `--cost-url <url>` | URL of Claude Code Cost that the board links to. |
| `MEMORY_URL` | `--memory-url <url>` | URL of Claude Code Memory that the board links to. |
| `CLAUDE_HUB` | | Set by [Claude Code Hub](/claude-code-kanban/guides/claude-code-hub/). Turns on hub integration. |
| `HUB_URL` | | Set by Claude Code Hub. The hub origin that may frame the app and send it messages. |

Flags win over environment variables. The server reads the port only from `PORT`. See [Port](/claude-code-kanban/reference/cli/#port).

## Terminal config

The embedded terminal is off when Claude Code Kanban runs alone. Turn it on with `--enable-terminal`, or with `"enabled": true` in `CCK_TERMINAL`. Inside Claude Code Hub it is on by default, and the hub passes its `terminal` block as `CCK_TERMINAL`.

```sh
CCK_TERMINAL='{"enabled":true,"fontSize":14}' npx claude-code-kanban
```

| Field | Default | What it does |
|---|---|---|
| `enabled` | `false` | Turns on the terminal. `--enable-terminal` does the same. |
| `shell` | Platform default | Shell to run. `--terminal-shell` and `CCK_TERMINAL_SHELL` win over it. |
| `maxSessions` | `20` | Most terminals open at the same time. |
| `fontFamily` | Built-in font | Terminal font. |
| `fontSize` | `13` | Font size in pixels. |
| `scrollback` | `5000` | Lines kept in the scrollback buffer. |
| `noFlicker` | `true` | Sets `CLAUDE_CODE_NO_FLICKER=1` for each `claude` the terminal starts. Set `false` to turn it off. |

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
| `waitSeconds` | `1800` | How long the hook waits for an answer from the board. The maximum is `1800`. |

Each config dir has its own file. See [Answer prompts from the board](/claude-code-kanban/guides/waiting-prompts/).

## Network and security

The server binds to `127.0.0.1` and also listens on `::1` on the same port. It has no authentication. Anyone who can reach the port can read your sessions.

To reach the board from another machine, bind to another address and allow its host name:

```sh
npx claude-code-kanban --host 0.0.0.0 --allowed-hosts=my-laptop.local
```

The server then prints `WARNING: listening on 0.0.0.0 - reachable from your network, with no authentication.` Do this only on a network you trust.

The server also applies these guards:

- **Host allowlist.** A request with a `Host` header that is not loopback, not in `--allowed-hosts` and not the bound address gets `403`. This blocks DNS rebinding.
- **Cross-origin writes.** The server refuses a request other than `GET`, `HEAD` or `OPTIONS` from another origin, or one that the browser marks as cross-site.
- **Framing.** When it runs alone, no other page can put the app in a frame. Under Claude Code Hub, pages on `localhost` or `127.0.0.1` (any port) and pages on the hub's own origin can.
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

It also reads Claude Code scratchpad folders under `<os tmpdir>/claude`.

## Files it writes

The server, the hooks and the installer keep their state in `<config-dir>/.cck/`:

| Path | Written by | Contents |
|---|---|---|
| `agent-activity/<sessionId>/<agentId>.jsonl` | `agent-spy.sh` hook | Subagent start, idle and stop events |
| `context-status/<sessionId>.json` | `context-status.sh` statusLine | Context use, cost and model for each session |
| `pins.json` | Server | Copy of the browser's session pins, so the CLI can read them |
| `dispatch-groups.json` | Server | Groups made with `dispatch start --group` |
| `server.json` | Server | `{port, pid}` of the running server. The CLI and hooks use it to find the port. |
| `terminal-token.json` | Server | Terminal token (file mode 600), used by `dispatch start`. Written only when the terminal is available. |
| `config.json` | You | Optional [UI approvals config](#ui-approvals-config) |
| `plugin/` | Installer | Copy of the Claude Code plugin |

The server removes `server.json` and `terminal-token.json` when it exits, if they still belong to it.

The installer also copies `context-status.sh` to `<config-dir>/hooks/context-status.sh` and can set `statusLine` in `<config-dir>/settings.json`.

## Browser-only data

Some data stays in the browser's `localStorage` and never reaches the server:

- Session groups
- Pinned messages
- Linked documents
- Scratchpad notes

Each config dir other than `~/.claude` gets its own key prefix, so two config dirs on the same port do not share this data. Another browser or profile does not see it.

To remove data for sessions that no longer exist, open the Storage Manager with <kbd>Shift+S</kbd> and select **Clean Orphaned**.

## Manual statusLine

`--install` asks to set up the statusLine. If you skipped that prompt, add it by hand in `settings.json`. The script passes its input through, so you can pipe it into another statusline:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/hooks/context-status.sh | npx -y ccstatusline@latest",
    "padding": 0
  }
}
```

Without the statusLine, the board shows no context use, cost or rate limits.

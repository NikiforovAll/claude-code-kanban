---
title: Troubleshooting
description: Short fixes for common problems with Claude Code Kanban, each as a symptom, a cause and a fix.
---

Each entry names what you see, why it happens and what to do.

## The board is empty

**Symptom.** A session shows in the sidebar, but its columns say "No pending tasks", "No active tasks" and "No completed tasks".

**Cause.** Claude Code ships the task tools off by default on some models. Claude then writes no tasks, and the board has nothing to show.

**Fix.** Turn the task tools on in the `env` block of your Claude Code `settings.json`, then restart Claude Code:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TODO_TOOLS": "true"
  }
}
```

You can also add a task by hand. Open one session and use the **Add task** tile in the Pending column. See [Sessions and the board](/claude-code-kanban/guides/sessions-and-board/).

## No agent log, no live pulse, no waiting prompts

**Symptom.** Tasks show, but the Agents Log stays empty, session cards never pulse, and sessions that wait for you get no highlight.

**Cause.** The plugin is not installed in this Claude config dir, or it is out of date.

**Fix.** Run the installer again:

```bash
claude-code-kanban --install
```

Make sure the installer and the server use the same Claude config dir. If you use a config dir other than `~/.claude`, pass the same `--dir=<path>` (or set `CLAUDE_CONFIG_DIR`) for `--install` and for the server. Then start a new Claude Code session: the plugin applies to sessions that start after the install.

See [Getting started](/claude-code-kanban/getting-started/) and [Configuration](/claude-code-kanban/reference/configuration/).

## No context bars or cost

**Symptom.** Session cards and session info show no context use, tokens or cost.

**Cause.** The plugin's mod writes these numbers. Claude Code older than 2.1.287 does not load mods. Mods also do not run when `disableAllHooks` is set, in `--safe-mode`, or when your organization allows only managed mods. If the plugin is missing, see the section above.

**Fix.** Run `claude update`, then start a new session or run `/reload-plugins`.

## "Server Not Running" overlay

**Symptom.** The page shows a "Server Not Running" overlay.

**Cause.** The page cannot reach the Claude Code Kanban server. It stopped, or it never started.

**Fix.** Start the server with `claude-code-kanban`, then click **Retry Connection**.

## The port is busy

**Symptom.** The server logs `Port 3541 in use, trying random port...`.

**Cause.** Another process uses the port. The server then listens on a random port.

**Fix.** Use the address in the startup line `Claude Task Kanban running at http://localhost:<port>`. The CLI finds the live port by itself, because the server writes it to `<config-dir>/.cck/server.json`. To choose a fixed port, set `PORT`:

```bash
PORT=8080 claude-code-kanban
```

## The CLI cannot reach the server

**Symptom.** A CLI command prints `Cannot reach cck server for <dir> on port <n>. Start it first with "claude-code-kanban".`

**Cause.** No server runs for that config dir. The CLI uses `PORT` if you set it. Otherwise it reads `<config-dir>/.cck/server.json` if the process in it is alive, else it tries port 3541.

**Fix.** Start the server for the same config dir. If you set `PORT` for the server, set the same `PORT` for the CLI, or unset it so the CLI reads `server.json`. See [CLI reference](/claude-code-kanban/reference/cli/).

## The terminal button is missing

**Symptom.** There is no terminal button, and <kbd>Ctrl+&#96;</kbd> does nothing.

**Cause.** One of these:

- The terminal is off. It is off by default when Claude Code Kanban runs alone.
- The terminal backend `@lydell/node-pty` failed to load. The server logs `Terminal unavailable: terminal backend failed to load: <reason>`.
- The server listens on a non-loopback address, for example with `--host 0.0.0.0`. The server logs `Terminal unavailable: refused while listening on a non-loopback address`.

**Fix.** Start the server with `--enable-terminal` and open the link it prints, `Terminal enabled - open http://localhost:<port>/#t=<token>`. If the log shows a load error, reinstall the package so the optional dependency installs. Keep the default loopback host to use the terminal. See [Embedded terminal](/claude-code-kanban/guides/embedded-terminal/).

## Dispatch errors

### "No terminal token"

**Symptom.** `dispatch start` prints `No terminal token for <dir>. The cck server must be running with the terminal enabled.`

**Fix.** Start the server with `--enable-terminal` for the same config dir, then run the command again.

### 403: folder is not a known project

**Symptom.** A new session or `dispatch start` fails with `folder is not a known project or a folder picked in this run`.

**Cause.** A new session can start only in a folder where a Claude Code session already ran, or in a folder you picked with **Browse…** in the New session dialog since the server started.

**Fix.** Run Claude Code once in that folder, or pick it with **Browse…**. Then try again.

### 429: too many terminals

**Symptom.** A new terminal fails with `30 terminals are open; end one first`.

**Fix.** End a terminal in the Terminals manager (<kbd>Ctrl+Shift+&#96;</kbd>), or raise `maxSessions` in the `CCK_TERMINAL` JSON, for example `CCK_TERMINAL='{"enabled":true,"maxSessions":50}' claude-code-kanban`. Inside Claude Code Hub, set it in the `terminal` block of `~/.claude-hub/config.json`, for example `"terminal": {"maxSessions": 50}`, then restart the hub. See [Configuration](/claude-code-kanban/reference/configuration/).

## A board move does not reach Claude

**Symptom.** You drag a card to another column, and Claude does not react.

**Cause.** One of these:

- `boardEvents.enabled` is `false` in `<config-dir>/.cck/config.json`.
- The session does not run the plugin, or runs a plugin version before 3.0.0.
- The session is busy. It gets the move when its current turn ends.
- You made the move before the session started listening. Those moves are discarded. Adding a task by hand sends no notice at all.

**Fix.** Check the config, update the plugin with `claude-code-kanban --install`, and start the session again. See [Steer a session from the board](/claude-code-kanban/guides/plugin-skills/#steer-a-session-from-the-board).

## Prompt buttons are missing

**Symptom.** A waiting card has no Allow or Deny buttons and says "answer in the terminal".

**Cause.** One of these:

- The ask did not come through the plugin's mod, so the board cannot answer it. The plugin may be missing or out of date.
- The ask lapsed. The mod holds an ask open for `waitSeconds`, 1800 seconds by default.
- UI approvals are off, or `mode` is `"permission"`, which leaves questions to the terminal.

**Fix.** Answer in the terminal this time. Then check the `approvals` section of `<config-dir>/.cck/config.json`. Remove `"enabled": false`, or set `mode` to `"permission+question"`. If the plugin is missing, run `claude-code-kanban --install`. See [Answer prompts from the board](/claude-code-kanban/guides/waiting-prompts/).

## 403 on a custom hostname

**Symptom.** The page answers `403 Forbidden - unrecognized Host header`.

**Cause.** The server answers only requests addressed to localhost. This blocks DNS rebinding.

**Fix.** Add the hostname with `--allowed-hosts`, or `ALLOWED_HOSTS` as a comma-separated list. To reach the server from another machine, also set the bind address:

```bash
claude-code-kanban --host 0.0.0.0 --allowed-hosts=my-host
```

Do this only on a network you trust. The server has no authentication, and the embedded terminal is off on a non-loopback address.

## Installer: "claude CLI not found"

**Symptom.** `--install` prints `claude CLI not found` and stops.

**Cause.** The installer runs `claude --version` first. It needs the `claude` CLI to install the plugin.

**Fix.** Install Claude Code, make sure `claude` is on your `PATH`, then run `claude-code-kanban --install` again.

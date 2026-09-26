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

**Cause.** The hooks are not installed, or `jq` is missing. The hook scripts use `jq` to parse JSON. The installer only warns when `jq` is missing, and setup continues.

**Fix.**

1. Install `jq` if the installer warned "hook scripts require jq for JSON parsing".
2. Run the installer again:

   ```bash
   npx claude-code-kanban --install
   ```

3. Make sure the installer and the server use the same Claude config dir. If you use a config dir other than `~/.claude`, pass the same `--dir=<path>` (or set `CLAUDE_CONFIG_DIR`) for `--install` and for the server.
4. Start a new Claude Code session. The hooks apply to sessions that start after the install.

See [Getting started](/claude-code-kanban/getting-started/) and [Configuration](/claude-code-kanban/reference/configuration/).

## No context bars or cost

**Symptom.** Session cards and session info show no context use, tokens or cost.

**Cause.** The `statusLine` in `settings.json` does not run `context-status.sh`. The installer asks before it changes `statusLine`. If you answered `n`, or `settings.json` was malformed, it skipped this step. `--plugin-only` also skips it. Or `jq` is missing. The script uses `jq` to read the session id. See step 1 in the section above.

**Fix.** Run `npx claude-code-kanban --install` again and answer yes to the statusLine step. Or add it by hand, as [Manual statusLine](/claude-code-kanban/reference/configuration/#manual-statusline) shows. For a config dir other than `~/.claude`, use the `hooks/context-status.sh` path in that dir.

## "Server Not Running" overlay

**Symptom.** The page shows a "Server Not Running" overlay.

**Cause.** The page cannot reach the Claude Code Kanban server. It stopped, or it never started.

**Fix.** Start the server with `npx claude-code-kanban`, then click **Retry Connection**.

## The port is busy

**Symptom.** The server logs `Port 3541 in use, trying random port...`.

**Cause.** Another process uses the port. The server then listens on a random port.

**Fix.** Use the address in the startup line `Claude Task Kanban running at http://localhost:<port>`. The CLI finds the live port by itself, because the server writes it to `<config-dir>/.cck/server.json`. To choose a fixed port, set `PORT`:

```bash
PORT=8080 npx claude-code-kanban
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

**Symptom.** A new terminal fails with `20 terminals are open; end one first`.

**Fix.** End a terminal in the Terminals manager (<kbd>Ctrl+Shift+&#96;</kbd>), or raise `maxSessions` in the `CCK_TERMINAL` JSON, for example `CCK_TERMINAL='{"enabled":true,"maxSessions":30}' npx claude-code-kanban`. See [Configuration](/claude-code-kanban/reference/configuration/).

## A board move does not reach Claude

**Symptom.** You drag a card to another column, and Claude does not react.

**Cause.** The server queues each move, but a session gets the queue only after you arm the doorbell monitor. Moves made before that are discarded. Adding a task by hand sends no notice at all.

**Fix.** Run `/claude-code-kanban:kanban-follow` in the session first, then move the card. See [Claude Code plugin skills](/claude-code-kanban/guides/plugin-skills/).

## Prompt buttons are missing

**Symptom.** A waiting card has no Allow or Deny buttons and says "answer in the terminal".

**Cause.** One of these:

- The ask did not come through `approval-gate.sh`, so the board cannot answer it. The hooks may be missing or out of date.
- The ask lapsed. The hook holds an ask open for `waitSeconds`, 1800 seconds by default.
- UI approvals are off, or `mode` is `"permission"`, which leaves questions to the terminal.

**Fix.** Answer in the terminal this time. Then check the `approvals` section of `<config-dir>/.cck/config.json`. Remove `"enabled": false`, or set `mode` to `"permission+question"`. If the hooks are missing, run `npx claude-code-kanban --install`. See [Answer prompts from the board](/claude-code-kanban/guides/waiting-prompts/).

## 403 on a custom hostname

**Symptom.** The page answers `403 Forbidden - unrecognized Host header`.

**Cause.** The server answers only requests addressed to localhost. This blocks DNS rebinding.

**Fix.** Add the hostname with `--allowed-hosts`, or `ALLOWED_HOSTS` as a comma-separated list. To reach the server from another machine, also set the bind address:

```bash
npx claude-code-kanban --host 0.0.0.0 --allowed-hosts=my-host
```

Do this only on a network you trust. The server has no authentication, and the embedded terminal is off on a non-loopback address.

## Installer: "claude CLI not found"

**Symptom.** `--install` prints `claude CLI not found` and stops.

**Cause.** The installer runs `claude --version` first. It needs the `claude` CLI to install the plugin.

**Fix.** Install Claude Code, make sure `claude` is on your `PATH`, then run `npx claude-code-kanban --install` again.

---
title: Run inside Claude Code Hub
description: What changes when Claude Code Kanban runs as a tab in Claude Code Hub.
---

Claude Code Hub is a launcher that shows Claude Code Kanban, Marketplace, Cost and Memory as tabs in one window. Claude Code Kanban works the same inside the hub. This page lists what is different.

## How the hub starts Claude Code Kanban

The hub starts Claude Code Kanban as a child process and sets these environment variables, among others:

- `CLAUDE_HUB=1` tells the app that it runs inside the hub.
- `HUB_URL` is the hub address, for example `http://localhost:3540`. The app sends and accepts hub messages only for this origin.
- `CLAUDE_CONFIG_DIR` is the Claude config directory that the hub has active.
- `CCK_TERMINAL` is the terminal config from the hub, as JSON. The hub sets it only when the terminal is on.
- `CCK_TERMINAL_TOKEN` is the terminal token. The hub sets it only when the terminal is on.

The app reads the config directory once at startup. For this reason the hub starts one Claude Code Kanban for each config directory. When you switch the config directory in the hub, the hub shows the board for that directory.

## Embedded terminal

When Claude Code Kanban runs alone, the [embedded terminal](/claude-code-kanban/guides/embedded-terminal/) is off until you pass `--enable-terminal` or set `CCK_TERMINAL` to `{"enabled": true}`. Under the hub the terminal is on by default.

To turn it off, do one of these:

- Start the hub with `--disable-terminal`.
- Add `"terminal": {"enabled": false}` to `~/.claude-hub/config.json`.

The other keys in the `terminal` block of that file go to Claude Code Kanban as its terminal config. See [Configuration](/claude-code-kanban/reference/configuration/).

### Terminal token

The terminal needs a token. Standalone, the server prints a `#t=<token>` link at startup. Under the hub you do not need that link. The hub makes one token each time it starts and puts it in the `#t=` fragment of the kanban tab URL. Claude Code Kanban keeps the token in `sessionStorage` and removes it from the address bar. The browser does not send a URL fragment to a server, so the token does not get into request logs.

If the hub restarts while the page stays open, the page has an old token. When the terminal refuses the token, Claude Code Kanban asks the hub for the new one and tries again.

## Keyboard shortcuts

Keys that you press in an iframe do not reach the hub. Claude Code Kanban sends these keys to the hub:

- <kbd>Ctrl+Alt+Left</kbd> and <kbd>Ctrl+Alt+Right</kbd> go to the previous or next app.
- <kbd>Alt+1</kbd> to <kbd>Alt+9</kbd> go to an app by its number.
- <kbd>Ctrl+Alt</kbd> plus a letter. The hub acts only on the letters it binds. <kbd>Ctrl+Alt+P</kbd> opens the project palette. <kbd>Ctrl+Alt+W</kbd> opens the config directory palette.

Claude Code Kanban keeps <kbd>Ctrl+Alt+N</kbd> (new session), <kbd>Ctrl+Alt+R</kbd> (resume session) and <kbd>Ctrl+Alt+S</kbd> (swap to the previous session). It does not send them to the hub, so the hub cannot use N, R or S.

## Jump to other apps

These keys work only under the hub. They use the session that is selected or under the cursor.

| Key | Goes to |
| --- | --- |
| <kbd>M</kbd> | Marketplace, scoped to the project of the session |
| <kbd>$</kbd> | Cost, on the detail view of the session |
| <kbd>Ctrl+M</kbd> | Memory, scoped to the project of the session |

The [session info](/claude-code-kanban/guides/session-details/) modal (<kbd>I</kbd>) also has **Open in Cost**, **Open in Marketplace** and **Open in Memory** buttons. The Marketplace and Memory buttons show only when the session has a project. Standalone, the buttons show only when you set `--cost-url`, `--marketplace-url` or `--memory-url`.

## Theme and project sync

Theme and project scope are the same in all hub apps:

- When you change light or dark mode, or the color theme, in one app, the hub sends the change to all apps.
- When you pick a project in the hub project palette (<kbd>Ctrl+Alt+P</kbd>), Claude Code Kanban filters the sidebar to that project.

## Framing

Standalone, Claude Code Kanban sends `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, so no other page can put it in a frame. When `HUB_URL` is set, it allows frames from itself, `http://localhost:*` and `http://127.0.0.1:*`. If the hub uses a different address, that origin is allowed too.

## Help modal

The shortcuts help (<kbd>?</kbd>) has a Hub group with the jump and app keys. Standalone, the modal hides this group, because those keys do nothing there. See [Keyboard shortcuts](/claude-code-kanban/reference/keyboard-shortcuts/).

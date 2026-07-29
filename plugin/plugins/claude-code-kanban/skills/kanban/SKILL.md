---
name: kanban
description: Drive the claude-code-kanban dashboard from this session — focus the current session in the browser, pin/unpin it in the sidebar, preview a markdown file, or inspect session stats and messages. Use when the user mentions kanban or cck.
argument-hint: '[open|pin|unpin|pins|preview|list|view|peek] [target]'
---

# Kanban Skill

The current Claude session id is `${CLAUDE_SESSION_ID}` (substituted when this skill loads), so the user never needs to look it up.

When the user passes arguments, map them to the matching command below (`open` → `session open`, `pin`/`unpin`/`pins` → `session pin`/`--unpin`/`session pins`, `list`/`view`/`peek` → the read-only verbs); with no arguments, open the current session.

Prefer the bare `claude-code-kanban` binary; fall back to `npx claude-code-kanban` when it is not on PATH, or when the user asks for npx explicitly.

## Open the current session in kanban

Primary use case. Pins the active session in the sidebar and switches to the Active tab.

```bash
claude-code-kanban session open ${CLAUDE_SESSION_ID}
```

## Pin the current session

Pins the session so it stays visible regardless of filters. Three states: `pinned` (default), `sticky` (always at the top), or cleared with `--unpin`.

```bash
claude-code-kanban session pin ${CLAUDE_SESSION_ID}            # pin
claude-code-kanban session pin ${CLAUDE_SESSION_ID} --sticky   # sticky at top
claude-code-kanban session pin ${CLAUDE_SESSION_ID} --unpin    # clear
```

## List pinned sessions

```bash
claude-code-kanban session pins              # all pinned/sticky
claude-code-kanban session pins --sticky     # sticky only
```

## Preview a file in kanban

Opens a markdown file in the preview modal. Relative paths are fine — the server resolves to absolute.

```bash
claude-code-kanban preview <path-to-file.md> --session ${CLAUDE_SESSION_ID}
```

## Inspect sessions (read-only)

```bash
claude-code-kanban session list --active                            # recent active sessions
claude-code-kanban session list --project <name>                    # filter by project
claude-code-kanban session list --days 0.5 --limit all              # touched in last 12h, uncapped
claude-code-kanban session view ${CLAUDE_SESSION_ID}                # full stats for current session
claude-code-kanban session peek ${CLAUDE_SESSION_ID} --limit 20     # last 20 messages (server caps at 50)
```

`session list` shows 10 rows by default and always includes pinned sessions, sticky first — `--no-pins` disables both.

Add `--json` to any list-style verb for machine-readable output.

## Troubleshooting

`claude-code-kanban help <command>` prints the authoritative flags for any command — read it instead of guessing.

- **"Cannot reach cck server…"** → the error names the port it tried. Ask the user to start the server with `claude-code-kanban`. If they run it elsewhere, set `PORT=<n>` when invoking the CLI.

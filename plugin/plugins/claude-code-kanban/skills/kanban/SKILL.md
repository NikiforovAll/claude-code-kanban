---
name: kanban
description: Drive the claude-code-kanban browser dashboard from this Claude session. Use this skill when the user mentions "kanban" together with "session" — e.g. "open this session in kanban", "show kanban", "focus current session in kanban", "pin/unpin a session in kanban", "preview this file in kanban", or asks to peek/view a kanban session.
compatibility: Requires the `claude-code-kanban` CLI on PATH and the server running locally (default port 3456).
---

# Kanban Skill

Drive the kanban from this Claude session. Every command corresponds to something the user could do in the kanban dashboard.

The current Claude session id is available as `${CLAUDE_SESSION_ID}` (substituted when this skill loads), so the user never needs to look it up.

NOTE, sometimes user prefers `npx claude-code-kanban` to `claude-code-kanban` — both work, as long as the CLI is available. Use npx as fallback or when user instructed explicitly.

## Open the current session in kanban

Primary use case. Pins the active Claude session in the kanban sidebar and switches to the Active tab.

```bash
claude-code-kanban session open ${CLAUDE_SESSION_ID}
```

Trigger phrases: "show this session in kanban", "focus current session", "open in kanban".

## Pin the current session in kanban

Pins the active Claude session in the sidebar so it stays visible regardless of filters. Three states: `pinned` (default), `sticky` (always at the top), or cleared via `--unpin`.

```bash
claude-code-kanban session pin ${CLAUDE_SESSION_ID}            # pin
claude-code-kanban session pin ${CLAUDE_SESSION_ID} --sticky   # sticky at top
claude-code-kanban session pin ${CLAUDE_SESSION_ID} --unpin    # clear
```

State applies to every connected browser tab (broadcast via SSE) and persists in each tab's localStorage. With no tabs open the command is a no-op.

Trigger phrases: "pin this session", "pin in kanban", "make this session sticky", "unpin session".

## Preview a file in kanban

Opens a markdown file in the preview modal:

```bash
claude-code-kanban preview <path-to-file.md> --session ${CLAUDE_SESSION_ID}   # prefer this one
```

Relative paths are fine — the server resolves to absolute.

## Inspect sessions (read-only)

When the user asks "what's going on in kanban?" or wants stats:

```bash
claude-code-kanban session list --active                            # recent active sessions
claude-code-kanban session list --project <name>                    # filter by project
claude-code-kanban session view ${CLAUDE_SESSION_ID}                # full stats for current session
claude-code-kanban session peek ${CLAUDE_SESSION_ID} --limit 20     # last 20 messages
```

Add `--json` to any list-style verb for machine-readable output.

## Troubleshooting

- **"Cannot reach cck server on port 3456"** → ask the user to start it: `claude-code-kanban` (or `npm start` in the cck repo).
- **Different port** → set `PORT=<n>` env var when invoking the CLI.
- **Ambiguous session prefix (HTTP 409)** → use the full id. With `${CLAUDE_SESSION_ID}` this won't happen.

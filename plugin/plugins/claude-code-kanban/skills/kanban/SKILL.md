---
name: kanban
description: Drive the kanban board — open, pin, preview, link, inspect.
argument-hint: '[open|pin|unpin|preview|link] [target]'
disable-model-invocation: true
---

# Kanban Skill

This session id is `${CLAUDE_SESSION_ID}`, substituted when the skill loads.

An argument names the command that handles it; with no argument, open the current session. Prefer the bare `claude-code-kanban` binary, falling back to `npx claude-code-kanban` when it is off PATH or the user asks for npx.

The CLI help is the reference, and it always matches the installed binary. Read it before you run a command, instead of guessing flags:

```bash
claude-code-kanban help                        # every command
claude-code-kanban help <command>              # its subcommands
claude-code-kanban help <command> <subcommand> # flags and examples
```

| Argument | Command |
|---|---|
| `open` (or none) | `session open ${CLAUDE_SESSION_ID}` |
| `pin` / `unpin` | `session pin ${CLAUDE_SESSION_ID}` (`--sticky`, `--unpin`) |
| `preview` | `preview-doc <file> --session ${CLAUDE_SESSION_ID}` — opens a modal on the user's screen |
| `link` | `link-doc <file\|url> --session ${CLAUDE_SESSION_ID}` — no modal, so it is the safe choice while the user is working. An http(s) URL (a PR, an artifact) opens in a new tab |
| `list` / `search` | `session list`, `session search <text>` |
| `view` / `peek` | `session view <id>`, `session peek <id>` |
| tasks, projects | `task list`, `project list` |

To be driven *by* the board instead — card moves arriving as instructions — the user types `/claude-code-kanban:follow`.

## Troubleshooting

- **"Cannot reach cck server…"** → the error names the config dir and the port it tried. Ask the user to start the server with `claude-code-kanban`. If they run it elsewhere, set `PORT=<n>` or `CCK_URL=<url>` when invoking the CLI.

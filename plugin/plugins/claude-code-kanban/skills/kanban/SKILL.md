---
name: kanban
description: Drive the kanban board — open, pin, preview, link, inspect.
argument-hint: '[open|pin|unpin|preview|link] [target]'
disable-model-invocation: true
---

# Kanban Skill

This session id is `${CLAUDE_SESSION_ID}`, substituted when the skill loads.

An argument names the section below that handles it; with no argument, open the current session. Prefer the bare `claude-code-kanban` binary, falling back to `npx claude-code-kanban` when it is off PATH or the user asks for npx.

To be driven *by* the board instead — card moves arriving as instructions — the user types `/claude-code-kanban:kanban-follow`.

## `open` — the current session

Pins the session and switches the board to the Active tab.

```bash
claude-code-kanban session open ${CLAUDE_SESSION_ID}
```

## `pin` — keep the session visible

```bash
claude-code-kanban session pin ${CLAUDE_SESSION_ID}            # pin
claude-code-kanban session pin ${CLAUDE_SESSION_ID} --sticky   # always at the top
claude-code-kanban session pin ${CLAUDE_SESSION_ID} --unpin    # clear
claude-code-kanban session pins                                # list pinned; --sticky narrows
```

## `preview` — open a file in the modal

Markdown or standalone HTML. HTML renders in a sandboxed iframe, so sibling assets like `./style.css` do not load. Relative paths are fine — the server resolves them.

```bash
claude-code-kanban preview-doc <file.md|.html> --session ${CLAUDE_SESSION_ID}
```

## `link` — attach a doc without the modal

Adds the file to the session's linked docs in the sidebar. Any extension, and nothing pops up, so it is the safe choice while the user is working.

```bash
claude-code-kanban link-doc <path> --session ${CLAUDE_SESSION_ID}            # link
claude-code-kanban link-doc <path> --session ${CLAUDE_SESSION_ID} --unlink   # remove
```

## `list` / `view` / `peek` — read-only

```bash
claude-code-kanban session list --active                            # recent active sessions
claude-code-kanban session list --project <name>                    # filter by project
claude-code-kanban session list --days 0.5 --limit all              # touched in last 12h, uncapped
claude-code-kanban session view ${CLAUDE_SESSION_ID}                # full stats for current session
claude-code-kanban session peek ${CLAUDE_SESSION_ID} --limit 20     # last 20 messages (server caps at 50)
```

`session list` shows 10 rows and always includes pinned sessions, sticky first (`--no-pins` disables both). `--json` works on any list-style verb.

## Troubleshooting

`claude-code-kanban help <command>` prints the authoritative flags — read it instead of guessing.

- **"Cannot reach cck server…"** → the error names the port it tried. Ask the user to start the server with `claude-code-kanban`. If they run it elsewhere, set `PORT=<n>` when invoking the CLI.

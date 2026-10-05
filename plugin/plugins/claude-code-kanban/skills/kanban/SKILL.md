---
name: kanban
description: Kanban board CLI — show the user a file or page, link a doc or PR, add a pane, open or pin a session, find a session's transcript, list tasks.
argument-hint: '[doc|pane|session|task|project|dispatch] <subcommand> [target]'
---

# Kanban Skill

The skill is a thin wrapper over the `claude-code-kanban` CLI: the argument is a command and its subcommand, such as `doc link plan.md` or `session pin`. Run the bare binary, or `npx claude-code-kanban` when it is off PATH or the user asks for npx.

This session id is `${CLAUDE_SESSION_ID}`. `--session` defaults to it through `$CLAUDE_CODE_SESSION_ID`, so pass the flag only for another session.

## Commands

| Command | Subcommands |
|---|---|
| `doc` | `link`, `unlink` a file or URL to the session · `list` its links · `preview` a file in a modal |
| `pane` | `add` a URL or a local file as a background tab · `rm` · `list` |
| `session` | `list` · `search <text>` · `open <id>` focuses it · `view <id>` stats and transcript path · `plan <id>` · `agents <id>` · `pin <id>` |
| `task` | `list` for a session, a project or the whole board |
| `project` | `list` |
| `dispatch` | `start`, `list` — run `/claude-code-kanban:dispatch` instead |

## Run a command

1. Read `claude-code-kanban help <command> <subcommand>` for the flags. It matches the installed binary, so its flags are the ones that work.
2. Run the command and report its output line to the user.

With no argument, run nothing on the board: show the user the table above.

## Keep the board still

The user works in other windows while you run, so pick the quiet command. `doc link` and `pane add` add an entry the user opens when ready. `doc preview` is the one command that opens a modal on the user's screen: use it when the user asks to see something now.

To show the user a page, a prototype or a collage of screenshots, write it as HTML and link or preview that file. The preview renders HTML as authored in a sandboxed iframe and inlines its local stylesheets, scripts and images, so the file alone is enough.

## Another session

Read its transcript. `session view <id>` and `session search <text> --json` print the path.

To have card moves arrive in this session as instructions, the user types `/claude-code-kanban:follow`.

## Troubleshooting

- **"Cannot reach cck server…"** → the error names the config dir and the port it tried. Ask the user to start the server with `claude-code-kanban`. If it runs elsewhere, set `PORT=<n>` or `CCK_URL=<url>` when invoking the CLI.
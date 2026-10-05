---
title: Claude Code plugin skills
description: Use the kanban, follow and dispatch skills to drive the board from Claude Code and let the board drive Claude Code.
---

The Claude Code Kanban plugin adds three skills to Claude Code. `claude-code-kanban --install` installs the plugin, together with its hooks. See [Getting started](/claude-code-kanban/getting-started/).

In Claude Code the skills have the plugin name as a prefix:

| Skill | Who can start it | What it does |
|---|---|---|
| `/claude-code-kanban:kanban` | You or Claude | Runs the board's CLI: links docs, adds panes, opens and pins sessions. |
| `/claude-code-kanban:follow` | You only | Makes card moves on the board into instructions for this session. |
| `/claude-code-kanban:dispatch` | You or Claude | Starts other sessions in the board's terminal. |

The `follow` skill starts the `kanban-doorbell` monitor. A monitor is a background process that Claude Code runs for the rest of the session. It prints a line when a task of this session moves on the board, or when you send it review comments, and Claude Code gives each line to Claude.

The skills need the board server. If the server is not running, a CLI command fails with `Cannot reach cck server for <dir> on port <n>`. Start the server with `claude-code-kanban`, then try again. The monitor prints nothing while the server is down. It tries again every 15 seconds and connects when the server starts.

## kanban

```text
/claude-code-kanban:kanban [doc|pane|session|task|project|dispatch] <subcommand> [target]
```

The skill is a thin wrapper over the [CLI](/claude-code-kanban/reference/cli/). The argument is a command and its subcommand, and the current session is the default target. Claude reads the CLI help, one level at a time, before it runs a command, so the help is the reference and the skill needs no change when a command does. With no argument, the skill changes nothing on the board and tells you what the commands can do.

The skill does not move the board while you work. `doc link` adds a file, or an `http(s)` URL such as a pull request, to the linked documents of the session. `pane add` adds a live pane as a tab next to Board, and the board does not switch to it. Only `doc preview` opens something on your screen: the preview modal. HTML renders in a sandboxed iframe. The server embeds the local stylesheets, scripts and images that the page refers to, such as `./style.css`, up to 4 MB for each file and 16 MB in total. Remote URLs load as usual.

To learn what another session did, Claude reads its transcript. `session view <id>` prints the transcript path, and `session search <text> --json` prints it for each match.

Example prompts:

```text
/claude-code-kanban:kanban
/claude-code-kanban:kanban session pin --sticky
/claude-code-kanban:kanban doc preview docs/plan.md
/claude-code-kanban:kanban doc link notes/findings.md
/claude-code-kanban:kanban show the active sessions from the last 12 hours
```

## follow

```text
/claude-code-kanban:follow
```

This skill lets you steer a session from the board. Claude does not start it by itself. When you type it, the skill starts the `kanban-doorbell` monitor, which runs for the rest of the session. Claude confirms in one line and runs no command.

When you drag one of the session's task cards to a new column, the session gets a line like this:

```text
[kanban board] The user moved task <id> "<subject>" from <from> to <to>. Description: <description>
```

The line has no `Description:` part when the card has no description. Claude treats the move as an instruction from you. The subject and description of the card tell Claude what to do.

| Move | What Claude does |
|---|---|
| To `in_progress` | Starts the task now. |
| From `in_progress` to `pending` or `todo` | Stops work on the task and parks it. |
| To `completed` | Stops. You consider the task done. |
| To `cancelled` | Abandons the task. It undoes nothing unless you ask. |

If you move a card two times, only the newest line for that task counts. If a move conflicts with the current work, the board wins. When Claude finishes a task that you moved to In Progress, it sets the task to `completed` with `TaskUpdate`, and the card moves to Completed.

When you send [review comments](/claude-code-kanban/guides/review-comments/) on a file or the plan, the session gets a line like this, and Claude reads the review file and does what the comments ask:

```text
[kanban board] The user left <n> review comments on <source>. Address them: <review file>
```

Know these limits:

- The monitor discards moves made before you run the skill. A session that never ran the skill never hears the board.
- Only moves and review comments send a line. A task you add by hand in the Pending column does not.
- The queue is in memory and can lose lines. It keeps 50 lines per session at most, and the server cuts each line at 1500 characters. The task file stays the source of truth, so a lost line only means Claude sees the change on its next turn.

Example prompts:

```text
/claude-code-kanban:follow
```

Then add tasks to the session and drag a card from Pending to In Progress on the board. Claude starts that task. Drag it back to Pending to make Claude stop.

## dispatch

```text
/claude-code-kanban:dispatch <task> [--handoff] [--group <name>] [--model haiku|sonnet|opus|fable] [--worktree [name]] [-- <claude args>]
```

This skill starts other Claude Code sessions through the board. You can type it, and Claude can also start it when you ask it to dispatch or delegate a task. The skill tells Claude to load the dispatch guide first:

```bash
claude-code-kanban skills get dispatch
```

The guide comes with the installed `claude-code-kanban` package, so it always matches the commands that version accepts. If `skills get` is an unknown command, the installed version is too old. Update Claude Code Kanban.

By default, Claude asks the started session to reply with `SendMessage`. Add `--handoff` when you do not need a reply: Claude passes the task on and moves on, and you follow the session on the board. For bigger tasks the skill picks one of the [orchestration patterns](/claude-code-kanban/guides/dispatch-patterns/). Dispatch needs the embedded terminal. See [Dispatch tasks to other sessions](/claude-code-kanban/guides/dispatch/) for the full flow.

Example prompts:

```text
/claude-code-kanban:dispatch fix the flaky login test in ~/dev/app and message me when it is done -- --permission-mode auto
/claude-code-kanban:dispatch update the changelog in this repo --handoff
Dispatch two sessions in separate worktrees, one for the API and one for the UI, in a group named api-ui, and tell me when both are done.
```

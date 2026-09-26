---
title: Claude Code plugin skills
description: Use the kanban, kanban-follow and kanban-dispatch skills to drive the board from Claude Code and let the board drive Claude Code.
---

The Claude Code Kanban plugin adds three skills to Claude Code. `npx claude-code-kanban --install` installs the plugin, together with its hooks. See [Getting started](/claude-code-kanban/getting-started/).

In Claude Code the skills have the plugin name as a prefix:

| Skill | Who can start it | What it does |
|---|---|---|
| `/claude-code-kanban:kanban` | You only | Opens, pins, previews and links things on the board. |
| `/claude-code-kanban:kanban-follow` | You only | Makes card moves on the board into instructions for this session. |
| `/claude-code-kanban:kanban-dispatch` | You or Claude | Starts other sessions through the board and collects their reports. |

Two of the skills start a monitor. A monitor is a background process that Claude Code runs for the rest of the session. It prints one line each time the board has news for the session, and Claude Code gives each line to Claude.

| Monitor | Starts when | Prints |
|---|---|---|
| `kanban-doorbell` | You run `kanban-follow` | A line when a task of this session moves on the board. |
| `kanban-dispatch-inbox` | The `kanban-dispatch` skill runs | A line when a session this session dispatched reports or exits. |

The skills need the board server. If the server is not running, a CLI command fails with `Cannot reach cck server for <dir> on port <n>`. Start the server with `claude-code-kanban`, then try again. The monitors print nothing while the server is down. They try again every 15 seconds and connect when the server starts.

## kanban

```text
/claude-code-kanban:kanban [open|pin|unpin|preview|link] [target]
```

Claude does not start this skill by itself. You type it. With no argument, it opens the current session on the board. It also pins the session and switches the board to active sessions.

Each argument runs a [CLI](/claude-code-kanban/reference/cli/) command for the current session:

| Argument | CLI command |
|---|---|
| none, or `open` | `session open <id>` |
| `pin` | `session pin <id>`, with `--sticky` to keep it at the top |
| `unpin` | `session pin <id> --unpin` |
| `preview <file>` | `preview-doc <file> --session <id>` |
| `link <file>` | `link-doc <file> --session <id>`, with `--unlink` to remove it |

`preview` opens a Markdown or HTML file in the preview modal of every open board tab. HTML renders in a sandboxed iframe. The server embeds the local stylesheets, scripts and images that the page refers to, such as `./style.css`, up to 4 MB for each file and 16 MB in total. Remote URLs load as usual. `link` adds any file to the linked documents of the session and opens no modal. Use `link` when you do not want a popup while you work.

The skill can also read the board with no changes. It uses `session list`, `session view` and `session peek`. `session list` shows 10 rows and always includes pinned sessions. `session peek` shows the last 10 messages by default, and 50 at most.

Example prompts:

```text
/claude-code-kanban:kanban
/claude-code-kanban:kanban pin sticky
/claude-code-kanban:kanban preview docs/plan.md
/claude-code-kanban:kanban link notes/findings.md
/claude-code-kanban:kanban show the active sessions from the last 12 hours
```

## kanban-follow

```text
/claude-code-kanban:kanban-follow
```

This skill lets you steer a session from the board. Claude does not start it by itself. When you type it, the skill starts the `kanban-doorbell` monitor, which runs for the rest of the session. Claude confirms in one line and runs no command.

When you drag one of the session's task cards to a new column, the session gets a line like this:

```text
cck:1 task.moved <id> <from>><to> subject="<subject>" description=<description>
```

The line has no `description=` part when the card has no description. Claude treats the move as an instruction from you. The subject and description of the card tell Claude what to do.

| Move | What Claude does |
|---|---|
| `pending>in_progress` or `todo>in_progress` | Starts the task now. |
| `in_progress>pending` or `in_progress>todo` | Stops work on the task and parks it. |
| `*>completed` | Stops. You consider the task done. |
| `*>cancelled` | Abandons the task. It undoes nothing unless you ask. |

If you move a card two times, only the newest line for that task counts. If a move conflicts with the current work, the board wins. When Claude finishes a task that you moved to In Progress, it sets the task to `completed` with `TaskUpdate`, and the card moves to Completed.

Know these limits:

- The monitor discards moves made before you run the skill. A session that never ran the skill never hears the board.
- Only moves send a line. A task you add by hand in the Pending column does not.
- The queue is in memory and can lose lines. It keeps 50 lines per session at most, and the server cuts each line at 1500 characters. The task file stays the source of truth, so a lost line only means Claude sees the change on its next turn.

Example prompts:

```text
/claude-code-kanban:kanban-follow
```

Then add tasks to the session and drag a card from Pending to In Progress on the board. Claude starts that task. Drag it back to Pending to make Claude stop.

## kanban-dispatch

```text
/claude-code-kanban:kanban-dispatch <task> [--report] [--group <name>] [--model haiku|sonnet|opus|fable] [--worktree [name]]
```

This skill starts other Claude Code sessions through the board. You can type it, and Claude can also start it when you ask it to dispatch or delegate a task. The skill tells Claude to load the dispatch guide first:

```bash
claude-code-kanban skills get dispatch
```

The guide comes with the installed `claude-code-kanban` package, so it always matches the commands that version accepts. If `skills get` is an unknown command, the installed version is too old. Update Claude Code Kanban.

The skill also starts the `kanban-dispatch-inbox` monitor. When a session dispatched with `--report` reports or exits, the dispatching session gets a line like this:

```text
cck:1 dispatch.<succeeded|failed|exited> <id> session=<uuid> summary=<text>
```

The line has no `summary=` part when the session sent no summary, for example when it exits without a report. A dispatch without `--report` sends no line. The inbox keeps lines that arrived before it started, so a report is not lost when the inbox starts late.

Dispatch needs the embedded terminal. See [Dispatch tasks to other sessions](/claude-code-kanban/guides/dispatch/) for the full flow.

Example prompts:

```text
/claude-code-kanban:kanban-dispatch fix the flaky login test in ~/dev/app --report
Dispatch a session in this repo to update the changelog. I do not need a report.
Dispatch two sessions in separate worktrees, one for the API and one for the UI, in a group named api-ui, and tell me when both are done.
```

---
title: Dispatch tasks to other sessions
description: Start a new Claude Code session with a written task in the board's terminal, with any claude flags, from the command line or from Claude.
---

A dispatch is a Claude Code session that Claude Code Kanban starts for you in its embedded terminal. You give it a task, called a spec, which it gets as its first message. The new session is an ordinary session. It shows in the sidebar like any other, and you can open its terminal at any time. Until its transcript appears, the sidebar shows it as a placeholder with the hint `starting`. Without a group of its own, it shows in the group of the session that started it.

`dispatch start` is a thin wrapper around `claude`. It starts the session and links it to the session that started it. It does not track a result. The two sessions talk with Claude Code's own `SendMessage` tool. For ways to combine dispatches, see [Orchestration patterns](/claude-code-kanban/guides/dispatch-patterns/).

## Before you start

The server must run with the embedded terminal enabled. `dispatch start` reads the terminal token from `<config-dir>/.cck/terminal-tokens/<port>.json`, where `<port>` is the port of the board it reaches. The server writes that file only when the terminal is on. Without it, the command stops with this error:

```text
No terminal token for <config-dir> at <board-url>. The cck server must be running with the terminal enabled.
```

To turn the terminal on, see [Embedded terminal](/claude-code-kanban/guides/embedded-terminal/). Inside [Claude Code Hub](/claude-code-kanban/guides/claude-code-hub/) the terminal is on by default.

## Start a dispatch

```bash
claude-code-kanban dispatch start --cwd ~/src/my-app --spec-file spec.md --name fix-login-redirect --group auth-refactor --model sonnet -- --permission-mode auto
```

- The new session sees only the spec, not your conversation, so write a spec that is complete on its own. Use `--spec-file` for a spec longer than one line, so you do not need shell quotes.
- `--name` is the sidebar name and the session's peer name for `SendMessage`. Use kebab-case that says what the session does.
Without `--json`, the command prints the session id, the folder and the group:

```text
Started session 5f0c... in /home/me/src/my-app [auth-refactor]
```

The `--cwd` folder must be a known project, which is a folder where a Claude Code session already ran, or a folder you picked with **Browse…** during this server run. For this and the other refusals, see [dispatch start](/claude-code-kanban/reference/cli/#dispatch-start) and [Dispatch errors](/claude-code-kanban/troubleshooting/#dispatch-errors).

## Pass claude flags

Everything after `--` goes to `claude` as it is, so any flag in `claude --help` works:

```bash
claude-code-kanban dispatch start --cwd . --spec-file spec.md --name docs-audit -- --permission-mode plan --add-dir ../shared
```

- Each value must be one shell word with no quotes, `%` or control characters, because it reaches a shell command line. Put long text in the spec.
- cck sets `--session-id`, `--name`, `--model` and `--worktree` itself; use its flags for them. It refuses `--resume`, `--continue`, `--fork-session` and `--print`, because they do not start a new session.
- When the server restarts, the terminal comes back with `claude --resume <id>`, without these flags.

## Track dispatches as cards

Cards for dispatched work are optional. To get them, ask Claude to track the dispatch on the board.

A card's owner can link to the session that does the work. Set the card's `owner` to the started session's `--name`, and the owner badge shows the send icon; a click opens that session. The badge links to a session that the list's session started, or to a session that uses the same list. When two of these sessions share the name, the badge shows no link.

The `dispatch` skill has the session that dispatches assign the card, because it creates the card and knows the name. Right after `dispatch start`, it sets the card's `owner` and moves it to `in_progress`, then sets it to `completed` when the started session reports. You can also assign cards yourself, for example in your prompt.

## Share one task list

By default, each started session keeps its own task list. Pass `--task-list` to make it use another list, so its cards show on one board with yours:

```bash
claude-code-kanban dispatch start --cwd . --spec-file spec.md --name api-worker --task-list
```

- With no value, it uses the current session's list. Pass `--task-list <id>` for another list.
- cck sets `CLAUDE_CODE_TASK_LIST_ID` in the session's terminal, not on the command line. A terminal never inherits the variable from the server, so a list is shared only when you pass the flag.
- The setting survives a server restart: a restored terminal resumes with the same list.
- Assign the cards as in [Track dispatches as cards](#track-dispatches-as-cards). In the spec, name the session's card and tell it to set the card to `completed` when done.

When you move a card, the board tells the sessions about it:

| List | Who gets the move |
|---|---|
| A session's own list, also with `--task-list` and no value | That session, also for a card that a started session owns |
| `--task-list <id>`, the card has an owner that links | The owner only |
| `--task-list <id>`, no owner or no link | The session that started the list's sessions. If they were started by more than one session, or by none, no session gets the move |

## Groups

Pass `--group` to show the new session under that group in the sidebar. Pass it on each dispatch that belongs in the group: a dispatch without it goes to its project. The session that ran `dispatch start` stays where it is.

A dispatch group is temporary. Select **Keep** on the group header to turn it into a named group. For how long it lives and where a started session goes, see [Groups from dispatch](/claude-code-kanban/guides/session-groups/#groups-from-dispatch).

## Talk to a dispatch

A started session is an ordinary Claude Code session, so `ListAgents` lists it under its `--name`, and `SendMessage` reaches it. To hear back from it, say so in the spec and give your own peer name, so it knows whom to message. `ListAgents` prints that name as "This session is &lt;name&gt;", and the board shows it as **Peer name** in the session info:

```text
Send your result, and any question, to claude-code-hub-06 with the SendMessage tool.
```

Its message arrives in your session as a new turn. A message arrives between the receiver's steps, not inside a running workflow or subagent.

## Check on a dispatch

```bash
claude-code-kanban dispatch list
claude-code-kanban session view <session-id>
```

`dispatch list` shows the sessions the current session started that still run in the board's terminal. Add `--all` to show every one on this board. A session that crashes sends nothing, so look here when a message is late. `session view` prints the path of the session's transcript, so Claude can read what the session did.

The card of a started session shows a send icon. Its tooltip names the session that started it, and a click reveals that session.

## Dispatch from Claude

The `dispatch` plugin skill lets Claude start dispatches for you. Ask Claude to dispatch or delegate a task. The skill loads the guide with `claude-code-kanban skills get dispatch`, so Claude uses the commands that your installed version accepts.

For setup and the other skills, see [Claude Code plugin skills](/claude-code-kanban/guides/plugin-skills/). For every flag, see the [CLI reference](/claude-code-kanban/reference/cli/).

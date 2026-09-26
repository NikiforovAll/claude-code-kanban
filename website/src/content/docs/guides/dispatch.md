---
title: Dispatch tasks to other sessions
description: Start a new Claude Code session with a written task, from the command line or from Claude, and collect its report when you need one.
---

A dispatch is a Claude Code session that Claude Code Kanban starts for you in its embedded terminal. You give it a task, called a spec. The new session is an ordinary session. It shows in the sidebar like any other, and you can open its terminal at any time. Until its transcript appears, the sidebar shows it as a placeholder with the hint `starting`. Without a group of its own, it shows in the group of the session that started it.

By default, you do not wait for a dispatch. You hand off the task and follow it in the sidebar. Add `--report` only when you need the outcome back.

## Before you start

The server must run with the embedded terminal enabled. `dispatch start` reads the terminal token from `<config-dir>/.cck/terminal-token.json`, and the server writes that file only when the terminal is on. Without it, the command stops with this error:

```text
No terminal token for <config-dir>. The cck server must be running with the terminal enabled.
```

To turn the terminal on, see [Embedded terminal](/claude-code-kanban/guides/embedded-terminal/). Inside [Claude Code Hub](/claude-code-kanban/guides/claude-code-hub/) the terminal is on by default.

## Write the spec

The new session sees only the spec. It does not see your conversation, so write a spec that is complete on its own. Name these five things:

- **Target.** The files, component, or environment in scope.
- **Change.** The result to produce.
- **Constraints.** What must stay true, and what not to touch.
- **Ownership.** What the session may edit.
- **Acceptance.** The test, output, or evidence that shows the task is done.

Two dispatches can edit the same files only when each one runs in its own `--worktree`.

Dispatch a task when it can run on its own. Do small tasks yourself, and tasks that need context you cannot write down.

## Start a dispatch

```bash
claude-code-kanban dispatch start --cwd ~/src/my-app --spec-file spec.md --name fix-login-redirect --group auth-refactor --json
```

- Use `--spec-file` for a spec longer than one line, so you do not need shell quotes.
- Give `--name` in kebab-case that says what the session does, for example `fix-login-redirect`.
- Add `--worktree` when another session edits the same files.

For every flag, see [dispatch start](/claude-code-kanban/reference/cli/#dispatch-start).

Without `--json`, the command prints the dispatch id, the session id, the folder and the group:

```text
Started d_1a2b3c4d5e6f (session 5f0c...) in /home/me/src/my-app [auth-refactor]
```

The `--cwd` folder must be a known project, which is a folder where a Claude Code session already ran, or a folder you picked with **Browse…** during this server run. For this and the other refusals, see [dispatch start](/claude-code-kanban/reference/cli/#dispatch-start) and [Dispatch errors](/claude-code-kanban/troubleshooting/#dispatch-errors).

## Groups

Pass `--group` on your first dispatch. The new session and the session that ran `dispatch start` then show together under that group in the sidebar. Later dispatches from the same session join the group without the flag. If the starting session is already in a group, it stays where it is.

A dispatch group is temporary. Select **Keep** on the group header to turn it into a named group. For how long it lives and where a started session goes, see [Groups from dispatch](/claude-code-kanban/guides/session-groups/#groups-from-dispatch).

## Get a report back

With `--report`, the new session's prompt starts with a line like `[cck dispatch d_1a2b3c4d5e6f]`. The prompt also holds the exact command the session runs to report, with a capability for this dispatch only:

```bash
claude-code-kanban dispatch done d_1a2b3c4d5e6f --cap <cap> --outcome succeeded --summary "<what changed, what you found, what remains>"
```

The capability lets the session report on its own dispatch and do nothing else. The session never gets the terminal token.

Without `--report`, the prompt is the spec alone, as if you typed it.

### If you are the started session

- Do only the task in the prompt.
- Report once, when the task is done or when you cannot finish it. Use `--outcome failed` when the task is not done, and say why.
- Write the summary as three sentences: what changed, what you found, what remains. Use `--summary-file <path>` if the text needs quotes.
- The starting session cannot answer questions. If you are blocked on a decision, report `failed` and put the question in the summary.
- After you report, stop.

A dispatch settles once. A second report gets `409`. A summary longer than 4000 characters is cut to 4000.

## Collect results

Start every independent dispatch first, then collect. Wait for the next one to settle:

```bash
claude-code-kanban dispatch wait --timeout 15m
```

- With no ids, `wait` watches the dispatches that the current session started. The CLI reads the session id from `CLAUDE_CODE_SESSION_ID`. Outside a Claude Code session, where that variable is not set, `wait` and `list` cover every dispatch on this board. Pass ids to watch specific dispatches.
- It returns as soon as any watched dispatch settles. Run it again with the ids that still run.
- The default timeout is `10m`. Write durations as `90s`, `15m` or `1h`.
- A timeout only marks a checkpoint. The command prints `Timed out; still running: <ids>`, and those sessions can still be at work.

List dispatches and look at a session before you act on a timeout:

```bash
claude-code-kanban dispatch list
claude-code-kanban session peek <session-id> --limit 20
```

`dispatch list` shows the dispatches the current session started. Add `--all` to show every dispatch on this board.

A dispatch ends in one of three states:

- `succeeded` or `failed`, from the session's report.
- `exited`, when its terminal ends before it reports.

A summary is the started session's own claim. Check it yourself: run the tests or read the diff.

## Where records live

The server keeps dispatch records in memory. A server restart loses them, and it also ends the terminals, so no running dispatch could report anyway. The server keeps settled records for 24 hours.

## Dispatch from Claude

The `kanban-dispatch` plugin skill lets Claude start and collect dispatches for you. Ask Claude to dispatch or delegate a task. The skill loads the guide with `claude-code-kanban skills get dispatch`, so Claude uses the commands that your installed version accepts.

The skill also arms an inbox for the session. When a dispatch started with `--report` settles, a line arrives in the session on its own:

```text
cck:1 dispatch.<succeeded|failed|exited> <dispatch-id> session=<uuid> summary=<text>
```

For setup and the other skills, see [Claude Code plugin skills](/claude-code-kanban/guides/plugin-skills/). For every flag, see the [CLI reference](/claude-code-kanban/reference/cli/).

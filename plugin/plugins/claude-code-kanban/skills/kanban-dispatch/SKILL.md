---
name: kanban-dispatch
description: Dispatch a task to another Claude Code session through the kanban board (cck), fire-and-forget or with a report back. Use when the user asks to dispatch, delegate, or start a session for a task, or to collect or check on a dispatched session's result.
argument-hint: '<task> [--report] [--group <name>] [--model haiku|sonnet|opus|fable] [--worktree [name]]'
---

# Kanban dispatch

This file only points at the guide. The guide ships with the `claude-code-kanban` binary, so it always matches the commands that binary accepts.

Invoking this skill also arms this session's dispatch inbox: when a session you dispatched with `--report` reports or exits, a line arrives here:

```
cck:1 dispatch.<succeeded|failed|exited> <dispatch-id> session=<uuid> summary=<text>
```

Load the guide before running any dispatch command:

```bash
claude-code-kanban skills get dispatch
```

Fall back to `npx claude-code-kanban` when the bare binary is not on PATH. If `skills get` is unknown, the installed cck is too old: tell the user to update it, and do not guess commands.

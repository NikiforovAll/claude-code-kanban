---
name: dispatch
description: Dispatch tasks to new Claude Code sessions in the kanban board's terminal. Use when the user asks to dispatch or delegate a task to another session.
argument-hint: '<task> [--handoff] [--group <name>] [--model haiku|sonnet|opus|fable] [--worktree [name]] [-- <claude args>]'
---

# Kanban dispatch

The guide ships with the `claude-code-kanban` binary, so it always matches the commands that binary accepts. Load it before running any dispatch command:

```bash
claude-code-kanban skills get dispatch
```

Fall back to `npx claude-code-kanban` when the bare binary is not on PATH. If `skills get` is unknown, the installed cck is too old: tell the user to update it, and do not guess commands.

## Reply

End every spec with the reply line, because you usually need the result to continue:

```text
When you are done, or cannot finish, send the result to <your peer name> with the SendMessage tool, then stop.
```

`--handoff` is a skill argument that drops the reply line: the session owns the task, and the user follows it on the board. Keep it out of the `dispatch start` command.

## Orchestration patterns

Use request-reply, handoff or orchestrator-workers directly. When another shape fits better (a separate reviewer, steps that feed each other, a sub-orchestrator, a decision for the user), propose it in one line, the pattern and why, and dispatch only after the user agrees, unless the user named it. Details: [references/orchestration-patterns.md](references/orchestration-patterns.md).

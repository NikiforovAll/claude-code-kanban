---
name: kanban-dispatch
description: Start another Claude Code session through the kanban board (cck) to do a task, watch it in the sidebar, and collect its report. Use when the user asks to dispatch, delegate, spawn, or start a session or agent for a task and wants it visible in cck, or to wait for or check on a dispatched session.
---

# Kanban dispatch

This file only points at the guide. The guide ships with the `claude-code-kanban` binary, so it always matches the commands that binary accepts.

Invoking this skill also arms this session's dispatch inbox: when a session you dispatched reports or exits, a line arrives here:

```
cck:1 dispatch.<succeeded|failed|exited> <dispatch-id> session=<uuid> summary=<text>
```

Load the guide before running any dispatch command:

```bash
claude-code-kanban skills get dispatch
```

Fall back to `npx claude-code-kanban` when the bare binary is not on PATH. If `skills get` is unknown, the installed cck is too old: tell the user to update it, and do not guess commands.

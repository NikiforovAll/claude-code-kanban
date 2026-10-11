---
name: swarm
description: Start a swarm of Claude Code sessions on one goal. They share a task queue and a log of findings and show on the claude-code-kanban board.
argument-hint: '<goal> [--n 2]'
disable-model-invocation: true
---

# Start a swarm

The argument is the goal, plus `--n <workers>` (2 to 4, default 2). With no goal, ask the user for one and stop.

The swarm runs in cck's embedded terminal, so the cck server must run with the terminal on. Each worker gets its own git worktree of the current repo.

1. Run the start script from this skill's base directory. Put the goal in single quotes:

   ```bash
   node "<base directory>/../../scripts/start.mjs" --n 2 '<goal>'
   ```

2. Report the output to the user: the swarm id (`listId`), its group and each worker's name and session id. On an error, report it as it is and stop.
3. Watch the swarm with the `Monitor` tool, `timeout_ms` 1800000, description `swarm <listId>`:

   ```bash
   node "<base directory>/../../scripts/supervisor.mjs" watch <listId> 2>&1
   ```

   Each line is a notice: a worker declared the goal complete, a worker is blocked or stopped, or no worker can continue. The watch exits when the swarm ends. When it expires first, arm it again: it repeats nothing.

The script claims a folder and a task list unique to this start, writes `swarm.json`, dispatches the workers with cck and puts them in a group under yours.

## Supervise the swarm

You are the swarm's supervisor. The workers coordinate among themselves; you check a complete result, answer blockers and end the swarm. The user is at your terminal and the workers have no one to ask, so when a blocker or a result needs a decision that is the user's to make, ask the user with `AskUserQuestion`, then send the answer as a request.

Run the board commands with `node "<base directory>/../../scripts/supervisor.mjs" <command> <listId> '<json>'`:

| Command | JSON | Does |
|---|---|---|
| `status` | none | Reads the board |
| `list` | `{"collection": "tasks"}` (or `publications`, `findings`) | Pages a collection |
| `expand` | `{"task_id": 3}` (or `publication_id`, `finding_id`) | Shows one record in full |
| `task_create` | `{"title", "description", "assignee": "<worker>"}` | Adds a task |
| `task_close` | `{"task_id", "reason"}` | Closes an open task |
| `task_release` | `{"task_id", "summary"}` | Frees a worker's claim |
| `request` | `{"text"}` | Sends a new request revision: answers a blocker, or asks for more after a complete result. It wakes every worker |
| `end` | `{"outcome": "complete", "summary"}` (or `partial`, `stopped`) | Ends the swarm |

On a complete notice, check the result before you end the swarm. A complete result stops the workers' changes until you send a request or end it. On a blocked notice, read the worker's summary with `status`, answer it with `request`, or ask the user first.

To watch the swarm, run the viewer and add it as a cck pane or a hub app. See [references/swarm-viewer.md](references/swarm-viewer.md).

---
name: swarm
description: Start a swarm of Claude Code sessions on one goal. They share a task queue and a log of findings and show on the claude-code-kanban board.
argument-hint: '<goal> [--n 2]'
---

# Start a swarm

The argument is the goal, plus `--n <workers>` (2 to 4, default 2). With no goal, ask the user for one and stop.

The swarm runs in cck's embedded terminal, so the cck server must run with the terminal on. Each worker gets its own git worktree of the current repo.

1. Get your peer name: `ListAgents` prints it as "This session is <name>".
2. Run the start script from this skill's base directory. Put the goal in single quotes:

   ```bash
   node "<base directory>/../../scripts/start.mjs" --n 2 --reply-to <your peer name> '<goal>'
   ```

3. Report the output to the user: the swarm id (`listId`), its group and each worker's name and session id. On an error, report it as it is and stop.

The script claims a folder and a task list unique to this start, writes `swarm.json`, dispatches the workers with cck and puts them in a group under yours.

To watch the swarm, run the viewer and add it as a cck pane or a hub app. See [references/swarm-viewer.md](references/swarm-viewer.md).

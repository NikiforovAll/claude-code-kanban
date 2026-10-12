---
name: swarm
description: Start a swarm of Claude Code sessions on one goal. They share a task queue and a log of findings.
argument-hint: '<goal> [--n 2]'
disable-model-invocation: true
---

# Start a swarm

The argument is the goal, plus `--n <workers>` (2 to 4, default 2). With no goal, ask the user for one and stop.

Each worker gets its own git worktree of the current repo.

1. Write the spec to a markdown file in your scratchpad directory. The workers are fresh sessions, so write a spec that stands alone, from what the user said here:
   - **Goal**: what the result is and who uses it.
   - **Constraints**: what the result must and must not do, and what it must leave alone.
   - **Decisions**: choices already made with the user (stack, approach, names), each with its reason when it matters, and what the new behavior means where it meets existing behavior, such as defaults.
   - **Acceptance checks**: how a worker shows the result is done, as commands or observable behavior.
   - **Code map**, when the request changes existing code: the files and the existing pattern the change follows, such as how a similar feature passes through the layers.
   - **Blast radius**, the same: every entry point and code path the change must reach, so no path is missed.

   Put in the code map and the blast radius only what you checked in the code; every worker acts on them. Keep the spec to about 1,500 words. Then write the first tasks to a JSON file in the scratchpad, a list of `{"title", "description"}`: the user's split, or yours from the spec. A task can be high level; the worker that claims it splits it further. Give each task what it shares with the others. Tasks are implementation work: do not add check, review or integration tasks, because the worker that assembles the result claims integration and checks it against the spec's acceptance checks. Show the spec and the tasks to the user before you start, and change them until the user agrees.
2. Run the start script from this skill's base directory. Put the goal, a short title, in single quotes:

   ```bash
   node "<base directory>/../../scripts/start.mjs" --n 2 --spec-file '<spec file>' --tasks-file '<tasks file>' '<goal>'
   ```

   When start says the name is taken, run it again with `--name '<another short name>'`.
3. Report the swarm id (`listId`) and the workers' names to the user. On any other error, report it as it is and stop.
4. Follow `<base directory>/../swarm-viewer/SKILL.md` with the `listId`. When it fails, report the error and go on.
5. Watch the swarm with the `Monitor` tool, `timeout_ms` 1800000, description `swarm <listId>`:

   ```bash
   node "<base directory>/../../scripts/supervisor.mjs" watch <listId> 2>&1
   ```

   Each line is a notice: a worker declared the goal complete, a worker is blocked or stopped, or no worker can continue. The watch exits when the swarm ends, by your `end` or by the user's `/swarm-stop`. When it expires first, arm it again: it repeats nothing.

## Supervise the swarm

You are the swarm's supervisor. The workers coordinate among themselves; you check a complete result, answer blockers and end the swarm. The user is at your terminal and the workers have no one to ask, so when a blocker or a result needs a decision that is the user's to make, ask the user with `AskUserQuestion`, then send the answer.

Send an answer in one of two ways:

- **To one worker**, with `SendMessage` to the worker's name, when the answer leaves the request as it is: a fact, a clarification, a pointer. It wakes only that worker.
- **To every worker**, with `request`, when the answer changes the spec's scope: the goal, a constraint, a decision or an acceptance check. It starts a new request revision, wakes every worker and refuses declarations made under the old one.

When in doubt, send a request: an answer that quietly changes the scope leaves the other workers with the old understanding.

Run the board commands with `node "<base directory>/../../scripts/supervisor.mjs" <command> <listId> '<json>'`:

| Command | JSON | Does |
|---|---|---|
| `status` | none | Reads the board |
| `list` | `{"collection": "tasks"}` (or `publications`, `findings`) | Pages a collection |
| `expand` | `{"task_id": 3}` (or `publication_id`, `finding_id`) | Shows one record in full |
| `task_create` | `{"title", "description", "assignee": "<worker>"}` | Adds a task |
| `task_close` | `{"task_id", "reason"}` | Closes an open task |
| `task_release` | `{"task_id", "summary"}` | Frees a worker's claim |
| `request` | `{"text"}` | Sends a new request revision: a change of scope, or more work after a complete result |
| `end` | `{"outcome": "complete", "summary"}` (or `partial`, `stopped`) | Stops the workers, removes their worktrees, moves you back out of the swarm's group (the board deletes it once its workers leave the Active view), and ends the swarm. `complete` first brings the candidate's result into the user's project and saves the other workers' changes to a recovery bundle; `partial` and `stopped` save every worker's changes to a recovery bundle |

### On a complete notice

A complete result holds the workers' changes until you send a request or end the swarm; a message leaves it in place.

1. Check the result in the candidate worker's worktree, `<project>/.claude/worktrees/<worker>`. Run each check with a path flag or in a subshell (`npm --prefix <worktree> test`, `(cd <worktree> && …)`), so your shell stays in the project: `end` removes the worktrees and refuses while your shell is in one. Also read the worker's summary and the result's own output for a failure it reports, such as a check that fails or a plan marked not feasible: one that the spec does not explain falls short too. Done when each acceptance check of the spec has a result. When one falls short, send a request that names it and wait for the next notice.
2. Review each open task that the notice lists, a claimed one too, as its work can be missing from the result. Close a task the result makes moot with `task_close` and a reason (`task_release` a claimed one first). Send a request for a task that names missing work. Done when no task is open: `end` as `complete` refuses until then.
3. End the swarm as `complete` and report the output to the user as it is:
   - **Delivered**: the changed files are in the project. The Git index and HEAD are as they were, so the user reviews and commits them. When the output says to run setup or a focused check (a file merged with the user's edits, or a changed dependency manifest), run it before you call the result ready.
   - **Not delivered** (`delivery_conflict`): the user edited the same lines during the run, so the project is as it was. Report the result as not delivered, with the conflicting paths and the recovery bundle. When the user asks, resolve them from the bundle: its `complete.json` names each file's start and result versions, stored as blobs named by their SHA-256.

When `end` fails, it has written nothing it cannot finish: fix the cause it names, then run the same command again.

### On a blocked notice

Read the worker's summary with `status`, then answer it as above, or ask the user first.

### On a stalled notice

No worker runs and none will wake. Read the board with `status`, then send a request that names the next step, which wakes every worker, or ask the user. When nothing is left to do, end the swarm as `partial`.

### On a stopped notice

The worker's session ended. Its claims are back on the queue, and it does not restart; the other workers go on. When every worker has stopped, end the swarm as `partial`, which saves their changes to the recovery bundle.

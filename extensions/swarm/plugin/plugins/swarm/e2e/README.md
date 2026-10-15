# Swarm e2e

A trivial end-to-end run of the swarm on a toy Node project: two stub string functions in separate files and a test file. It touches every step: start, dispatch and group, the viewer, claims, publish and apply, a complete candidate, the watch notices, `/swarm-status`, delivery, a delivery conflict, `/swarm-stop` and the worktree cleanup.

It runs on the real board (the cck that runs in the hub, on your `~/.claude`), because a second board on the same config dir takes `server.json`. Nothing is installed: the supervisor and the workers load this checkout's plugin with `--plugin-dir`, and run with `--permission-mode auto` unless you pass other claude args after `--`. Every session runs on `--model`, sonnet by default.

The toy repo and the reports go to `SWARM_E2E_ROOT`, else `kanban-swarm-e2e` in the temp dir.

## Commands

Run them from a Claude Code session in cck's terminal, so the CLI reaches the board.

| Command | Does |
|---|---|
| `node e2e.mjs setup` | A fresh toy repo at `<root>/repo`, committed |
| `node e2e.mjs supervise [--n 2] [--model sonnet] [--stop] [-- <claude args>]` | Dispatches a supervisor session that starts the swarm, watches it, checks the candidate with `npm test`, ends it and writes the report. With `--stop`, it ends the swarm as stopped at the first claim |
| `node e2e.mjs start [--n 2] [--model sonnet] [-- <claude args>]` | Starts the swarm with the calling session as the supervisor |
| `node e2e.mjs conflict` | Edits the stub line of `src/slugify.js` in the repo, as a user would during the run |
| `node e2e.mjs report [listId]` | Wall time, outcome, delivery, `npm test` in the repo, leftover worktrees and branches, and the event timeline, saved to `<root>/report-<listId>.md`. The listId defaults to the last run |
| `node e2e.mjs clean` | Removes leftover worktrees and `worktree-*` branches from the repo |

## Run book

1. **Delivery.** `setup`, then `supervise`. In the supervisor session, type `/swarm-status` once the workers claim tasks. Expect the outcome `complete`, `src/slugify.js` and `src/title-case.js` delivered, `npm test` passing in the repo, and no leftover worktrees.
2. **Conflict.** `setup`, then `supervise`. Run `conflict` once a worker claims the slugify task. Expect `delivery_conflict`, the stub line edit still in the repo, and a recovery bundle with `complete.json`.
3. **Stop.** `setup`, then `supervise --stop`. The toy swarm finishes in about 2 minutes, too fast to type `/swarm-stop` reliably, so the supervisor ends it as stopped at the first claim. Expect `stopped`, a recovery bundle, and no leftover worktrees.

After each run, keep its report and note what broke.

# DeepSWE eval

`deepswe.mjs` runs a swarm, or a single session to compare against, on a DeepSWE v1.1 dynamodb-toolbox task (default `dynamodb-toolbox-conditional-attribute-requirements`; `dynamodb-toolbox-lazy-recursive-schemas` has the same base commit and is harder), and grades the result with the task's hidden tests, without Docker. It fetches the [DeepSWE](https://github.com/datacurve-ai/deep-swe) dataset (Apache-2.0) at a pinned commit, sparse to the tasks in use, and builds the task's repo the way its Dockerfile does: dynamodb-toolbox at the base commit with no later history. The task text is the dataset's `instruction.md` with its commit line replaced by how to run the repo's checks.

Like the toy run, it runs on the real board, loads this checkout's plugin with `--plugin-dir` in the supervisor and the workers, and runs every session with `--permission-mode auto`. Each run records the plugin version and commit, and whether the plugin had uncommitted changes, so a result names the code it measured.

Everything goes to `SWARM_DEEPSWE_ROOT`, else `kanban-swarm-deepswe` in the temp dir: `deep-swe/` (the dataset), `source/` (the base repo with `node_modules`, which the grader reuses) and `runs/<label>/` (one run's `repo/`, `setup.json` with its task id, `task.md`, `prompt.md`, `run.json`, `model.patch`, `grade/`, `grade.json`, `report.json` and `report.md`).

| Command | Does |
|---|---|
| `node deepswe.mjs setup <label> [--task <id>]` | A fresh repo for the run at `runs/<label>/repo`, and its `task.md`. The first setup clones the dataset and the upstream repo. The source holds one base commit, so every task must share it |
| `node deepswe.mjs supervise <label> [--arm swarm\|single] [--n 2] [--model sonnet] [--review] [--report-to <peer>]` | Dispatches the session. The swarm arm runs `/swarm:swarm` and starts without the user's review of the spec and tasks, unless `--review`; the single arm works alone. cck sends no report: with `--report-to`, the session sends that peer one line with `SendMessage` when it is done |
| `node deepswe.mjs grade <label>` | Grades the repo's working tree, untracked files included, against the base: `grade.json` with the reward and the f2p and p2p counts |
| `node deepswe.mjs report <label>` | Grades, then adds the swarm's outcome, start-to-end time, spec size, findings, publications, applies, lost claims, peer waits, and the tokens of every session |
| `node deepswe.mjs list` | Every run's report in one table |

Run book: `setup run5`, `supervise run5`, wait for the supervisor to end the swarm, then `report run5` and `list`. Run each arm 2 to 3 times before you compare them: one run has no measure of spread. With `--review`, the swarm's time includes the wait for your review.

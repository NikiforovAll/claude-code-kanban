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

# Retention

State that cck writes under `<config dir>/.cck/` must not grow without a limit. This doc says how each store is bounded and how to bound a new one.

## Who owns the data

- **User-managed:** pins (`pins.json`) and linked docs (`linked-docs.json`). The user adds and removes them, and the hub's storage manager clears them. cck does not expire them.
- **cck-generated, short-lived:** `context-status/` and `agent-activity/`. The sweeps in the `CLEANUP` region of `server.js` delete `context-status/` files older than 2 h every 30 minutes, and `agent-activity/` entries older than 2 days every hour.
- **cck-generated, per session:** dispatch markers (`dispatched.json`) and reviews (`reviews/<session id>/<ts>.md`). They live as long as the session's transcript. The rest of this doc covers them.
- **cck-generated, per project:** worktrees (`worktrees.json`). See [Worktrees](#worktrees).
- **Caches:** `session-cache.json` is rebuilt cold when it passes 8 MB (`lib/session-cache.js`).

## Rule for per-session data

`lib/retention.js` drops an entry when, after a one-hour grace period:

1. the session's transcript is gone, or
2. the entry is older than Claude Code's `cleanupPeriodDays` (read from `<config dir>/settings.json`, default 30 days).

Claude Code deletes transcripts on the same schedule, so cck never keeps state for a session that no longer exists. The user sets one retention value, not two.

- **Known transcripts** come from `scanTranscripts()`: the `.jsonl` names under `projects/*/`, read with async directory listings, with no stat and no parse. It does not use the session metadata cache, because that cache only updates when a board asks for sessions, so it can miss new transcripts while no board is open. When the list is empty (no `projects/` dir, or a failed read), the transcript check is skipped, so a bad read cannot delete everything; the age check still runs.
- **Restart:** the dispatch registry is in memory, so a marker saved as `running` loads as `exited`: that dispatch can no longer settle.
- **Grace period:** a started session writes its transcript a moment after cck records it, and a review folder exists a moment before its file. Entries younger than one hour are never dropped.
- **Cap:** `dispatched.json` also keeps only the newest 500 entries, for users who keep transcripts forever.

## Worktrees

`lib/worktrees.js` maps a project path to `{repo, name, at}` when the path is a linked worktree. The board folds a worktree into its repo in `/api/projects` and in the project filter. Claude Code deletes worktrees but keeps their transcripts, so the mapping must outlive the checkout:

- A hit comes from the `.git` pointer file and is saved at once. A saved hit is answered without reading the disk.
- When the `.git` file is gone, a path under `<repo>/.claude/worktrees/<name>` (where `claude -w` puts it) still resolves. This covers worktrees deleted before the board saw them.
- A miss stays in memory only.

The sweep drops an entry when, after the one-hour grace period, no project dir under `projects/` with that path's encoded name holds a transcript. Claude Code deletes transcripts after `cleanupPeriodDays`, so this rule also applies that limit. When the scan finds no transcripts, nothing is dropped.

## The sweep

`runRetention()` in the `CLEANUP` region runs 5 minutes after startup, after the startup scan and prewarm, and then every hour.

- It uses async `fs.promises` calls, so the event loop keeps serving requests while it waits on the disk.
- Its cost is one directory listing per project plus one pass over the entries cck stores. It never opens a transcript.
- It writes `dispatched.json` only when an entry was dropped, and logs one `[retention]` line only when something was removed.
- Errors are caught per entry and per run; a failed run waits for the next one.

## Adding a store

For new per-session state, key it by session id, give each entry a time (`at`, or the file's `mtime`), and add it to `runRetention()` with the same `{known, maxAgeMs}` options. Update the list above in the same change.

# Retention

State that cck writes under `<config dir>/.cck/` must not grow without a limit. This doc says how each store is bounded and how to bound a new one.

## Who owns the data

- **User-managed:** pins (`pins.json`, the server copy of the board's session pins) and linked docs (`linked-docs.json`, the server copy of links made with `doc link`, at most 200 per session). They change only when the user pins, unpins, links or unlinks. The Storage Manager's Clean Orphaned removes the browser and server copies for sessions that no longer exist, so cck does not expire these files.
- **User-written:** `config.json`. cck only reads it.
- **cck-generated, short-lived:** `agent-activity/`. The sweep in the `CLEANUP` region of `server.js` runs every hour. It deletes a session folder older than 2 days, or an empty one older than 30 minutes, and the board's approval answers (`_decision-*.json`) older than 30 minutes. It skips `agent-activity/_task-maps/`, because the plugin mod rewrites those files in place and the folder's mtime does not change.
- **Task-list mappings:** `agent-activity/_task-maps/<task list id>.json`, written by the plugin mod, maps each session that runs with `CLAUDE_CODE_TASK_LIST_ID` to `{project, updatedAt}`. The per-session rule below drops a session by `updatedAt`, and a file with no sessions left is deleted.
- **cck-generated, per session:** dispatch markers (`dispatched.json`), pane layouts (`panes.json`, keyed by session with an `updatedAt` per layout and at most 50 panes each; a layout with no panes left stays until this sweep, so its pane ids are not reused), reviews (`reviews/<session id>/<ts>.md`) and context status (`context-status/<session id>.json`, written by the plugin mod). They live as long as the session's transcript, so an idle session keeps its context, cost and prompt-cache row. The rest of this doc covers them.
- **cck-generated, per project:** worktrees (`worktrees.json`). See [Worktrees](#worktrees).
- **cck-generated, live state:** each holds only what is live, so it needs no sweep.
  - `dispatch-groups.json`: a session leaves its group 1 minute after no member's `claude` runs, unless it is pinned (`lib/dispatch-groups.js`).
  - `terminals.json`: the open terminals and the ones still waiting to restore, at most `maxSessions` (`lib/terminal.js`). `CCK_TERMINALS_FILE` moves it out of `.cck`; a file there is the tester's to delete.
  - `server.json` and `terminal-tokens/<port>.json`: one per running board. The server removes its own when it exits, and at start removes token files of boards that no longer run.
- **Caches:** `session-cache.json` is rebuilt cold when it passes 8 MB (`lib/session-cache.js`).
- **Installer:** `plugin/`, a copy of the plugin, replaced on each `--install`.

## Rule for per-session data

`lib/retention.js` drops an entry when, after a one-hour grace period:

1. the session's transcript is gone, or
2. the entry is older than Claude Code's `cleanupPeriodDays` (read from `<config dir>/settings.json`, default 30 days).

Claude Code deletes transcripts on the same schedule, so cck never keeps state for a session that no longer exists. The user sets one retention value, not two.

- **Known transcripts** come from `scanTranscripts()`: the `.jsonl` names under `projects/*/`, read with async directory listings, with no stat and no parse. It does not use the session metadata cache, because that cache only updates when a board asks for sessions, so it can miss new transcripts while no board is open. When the list is empty (no `projects/` dir, or a failed read), the transcript check is skipped, so a bad read cannot delete everything; the age check still runs.
- **Grace period:** a started session writes its transcript a moment after cck records it, and a review folder exists a moment before its file. Entries younger than one hour are never dropped.
- **Cap:** for users who keep transcripts forever, `dispatched.json` keeps only the newest 500 entries and `context-status/` the newest 2000 files by mtime (`MAX_CONTEXT_STATUS`). Past 2000 sessions in the retention window, the oldest idle ones lose their context status before their transcript goes.

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
- It writes `dispatched.json` and `panes.json` only when an entry was dropped, and logs one `[retention]` line only when something was removed.
- Errors are caught per entry and per run; a failed run waits for the next one.

## Adding a store

For new per-session state, key it by session id, give each entry a time (`at`, or the file's `mtime`), and add it to `runRetention()` with the same `{known, maxAgeMs}` options. Update the list above in the same change.

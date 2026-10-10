# Session Scanning

How `cck` discovers and refreshes session data. **There is no periodic full scan** — discovery is event-driven via `chokidar` file watchers, backed by short-TTL caches for hot read paths.

## Mechanisms

### 1. File watchers (reactive, no polling)

All defined in `server.js`. Each watcher emits an SSE event to connected clients on relevant FS changes.

| Watcher | Path | Depth | Trigger | SSE event |
|---|---|---|---|---|
| `watcher` | `TASKS_DIR` | 2 | `*.json` add/change/unlink | `update` |
| `taskMapsWatcher` | `TASK_MAPS_DIR` | — | any | invalidates task-map cache |
| `teamsWatcher` | `TEAMS_DIR` | — | config change | team reload |
| `projectsWatcher` | `PROJECTS_DIR` | 2 | `*.jsonl` add/change/unlink | `metadata-update` (invalidates session metadata cache) |
| `plansWatcher` | `PLANS_DIR` | 0 | `*.md` add/change/unlink | `metadata-update`, `plan-update` |
| `agentActivityWatcher` | `AGENT_ACTIVITY_DIR` | 2 | `*.jsonl` / `_waiting.json` / `_stop.json` | `agent-update` (with team-leader fan-out; `unreadOnly` for `_stop.json`, which refreshes the list but not the message log) |
| `contextStatusWatcher` | `CONTEXT_STATUS_DIR` | 0 | `*.json` | context status broadcast |

Notable options:
- `agentActivityWatcher` uses `awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }` to coalesce rapid writes.
- `contextStatusWatcher` has `ignoreInitial: false` (others ignore initial scan). It fills `contextStatusCache`, which has no entry cap: it mirrors the files, which the retention sweep bounds. It broadcasts nothing during the initial scan and one `context-update` on `ready`.

Session discovery proper happens via `projectsWatcher` on `~/.claude/projects/**/*.jsonl`.

### 2. On-demand scans with TTL caches

These run only when an API request is served (no background timer).

| Function | Cache | TTL | Source |
|---|---|---|---|
| `loadSessionMetadata()` | `sessionMetadataCache` | `METADATA_CACHE_TTL = 10000` ms (per-path dirty set for hot updates) | `server.js:389` |
| `readSessionInfoFromJsonl()` | `sessionInfoCache` + `customTitleCache` | per path, valid while `sameFileGrown` (same inode, not shorter, and a new mtime only with new bytes); `slug`+`projectPath`+`logicalParentUuid`+`compactBoundaryUuid` pinned, `cwd`, title and `permissionMode` (the latest of a prompt line, an `auto_mode`/`auto_mode_exit` attachment or a `permission-mode` line, for the auto-mode waiting check) and `cacheTtl` (`5m`/`1h` from the `cache_creation` split of the last main-thread reply that wrote the prompt cache, for the cache timer in the context stats) and `lastReply` (`{at, model, usage}` of the last main-thread reply that is not `<synthetic>`; `at` is the timestamp of the user line before it, when the request went out; a later `compact_boundary` clears `usage`; served as `session.cache` for the Cache row and token rows, so they need no plugin) refreshed from appended bytes only. A cold read of a file over 1 MB reads the tail backward from the last 16 KB in 64 KB steps until it finds a reply, up to 2 MB; with none there, `lastReply` and `cacheTtl` are null; saved to disk, see [Persistent session cache](#3a-persistent-session-cache) | `lib/parsers.js` |
| `getGitBranch(cwd)` | `gitBranchCache` | `GIT_BRANCH_TTL_MS = 30000` ms, keyed by `cwd` | `server.js` + `lib/git-branch.js` |
| `getSessionLogStat()` → `transcriptActivityMs()` (the transcript time behind `modifiedAt`, `hasRecentLog`, agent status and the waiting checks) | `logActivityCache`: `{ino, size, mtimeMs}` per path, the file as it last changed size or inode | a `statSync` per call, no read. Same inode and size returns the stored mtime, because Claude Code, `claude --resume` and backup tools set a transcript's mtime without writing to it (#50); any other change stores the new one. Saved to disk, see [Persistent session cache](#3a-persistent-session-cache) | `lib/parsers.js` |
| `getAutoCompact(claudeDir, project)` (compaction window for the context bar; runs in `/api/sessions` after the limit slice, once per project, only for rows with `contextStatus`) | `fileCache`, one entry per settings file: `<config dir>/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`; misses cached too | keyed by `mtimeMs`: one `statSync` per file per call, a read only after a change | `lib/auto-compact.js`, cache in `lib/claude-settings.js` |
| `worktrees.resolve(dir)` | `createWorktreeStore` | hits saved to `.cck/worktrees.json`, pruned by the retention sweep; misses in memory, capped at 500 | `lib/worktrees.js` |
| Task-map scan | `sessionToTaskListCache` | `TASK_MAP_SCAN_TTL = 5000` ms | `server.js:271` |
| `readRecentMessages()` / session info | `messageCache` (keyed by mtime) | invalidates on file mtime change | `server.js:382` |
| `updateLoopInfo()` (ScheduleWakeup / Cron* scan) | `loopInfoStateByPath` (per-path incremental state) | warmed by `projectsWatcher` events; request path is O(1) on hit | `lib/parsers.js` + `server.js` |
| `extractAgentResultFromTranscript()` (subagent response) | saved on the agent record; a miss latches `resultUnavailable = RESULT_SCAN` | once per stopped agent and `RESULT_SCAN` value; workflow subagents retry until found | `lib/parsers.js` + `server.js` |
| `extractModelFromTranscript()` + `readSubagentMeta()` (subagent model, when the plugin's start record has none) | `model` (exact id) or `modelAlias` saved on the agent record; a stopped agent with no id latches `modelUnavailable = MODEL_SCAN` | live agents retry each poll; once per stopped agent and `MODEL_SCAN` value | `lib/parsers.js` + `server.js` |
| `getWorkflowInfoSummary()` (Workflow-tool script badge) | `workflowIndexCache` (`Map<sessionId, scripts[]>`) | `WORKFLOW_INDEX_TTL_MS = 5000` ms | `server.js` |
| `readWorkflowJournal()` / `getWorkflowMeta()` (workflow run + live views) | `workflowJournalCache` / `workflowMetaCache` | `cachedByMtime`, keyed by file path | `server.js` |

> `GET /api/sessions/known` returns `{id, project, name}` for each key of `loadSessionMetadata()` plus each folder in the tasks and agent-activity dirs and each session mapped to a custom task list, with no file reads per session. The Storage manager groups saved data by project and finds orphans against it, because the client's `sessions` holds only the sidebar's loaded, filtered page.

> `extractAgentResultFromTranscript()` fills the response of a subagent whose `lastMessage` is empty: the last `SubagentHandback` message or formatted `StructuredOutput` input in a 1 MB tail read of its transcript, else its last assistant text. The text fallback is the usual path today, because the plugin's mod gets an empty `turn.complete` answer for a subagent; it stops running once that answer is filled.

> A subagent's model comes from the plugin's start record, which writes the resolved id from `agent.spawn`. Without it (an older plugin or none), `extractModelFromTranscript()` reads the first 64 KB of the transcript, then the last 64 KB (`readTailLines()`, shared with `extractAgentResultFromTranscript()`), and takes the first line with a `model`, newest first in the tail. A long prompt or tool result at the start of a subagent transcript is the usual reason the head finds none. When neither finds an id, `readSubagentMeta()` reads the requested alias (`opus`, `haiku`, `inherit`) from the `agent-<id>.meta.json` next to the transcript, once per agent, and `server.js` saves it as `modelAlias`; `inherit` becomes the parent session's model. The client shows `model`, else `modelAlias` (`agentModel()`).

> `readRecentMessages()` dispatches transcript lines by `type`. Besides `user`/`assistant`/`teammate`, it surfaces `queue-operation` (`operation: 'enqueue'`) lines as user messages flagged `queued: true`. Queued text lives at the top-level `content`, not under `message.content`, and is never re-emitted as a `type:'user'` line, so without this branch it never renders.

> **Agent-sent messages → agent chip, not user input.** A subagent hand-back, teammate, or peer session delivering through `SendMessage` reaches the transcript twice, and neither copy is guaranteed: a `queue-operation` enqueue whose `content` is the `<agent-message from="…">body</agent-message>` envelope, and a delivered `type:'user'` record which since Claude Code 2.1 is `isMeta: true` (so the user-message branch drops it) but repeats the same fields on `origin: {kind:'peer', from, body, handback}`. `readRecentMessages()` therefore reads the `origin` record on its own branch — ahead of the `isMeta` filter — and `parseAgentMessage()`, called from `pushUserMessage()`, covers the two text paths; both feed `agentMessageParts()`, which strips a `[Subagent hand-back]` frame and its two-space report indent and builds the label. `pushUserMessage()` drops whichever twin arrives second (same sender, same body as the previous message) and clears `queued` when the delivered copy confirms it, so no renderer has to know about the double write. The message keeps `type:'user'` and carries `agentMessage: true`, `agentFrom`, and a `systemLabel` of `Subagent hand-back · <from8>` / `Agent message · <from8>` (a named sender like `code-review` is shown whole; only a hex agent id is truncated), which the client renders with the agent icon plus a markdown preview. The envelope must open the message — after the harness preamble, if any — because agent prose quoting the tag while describing the format is a user message, not an agent message; the body is unescaped agent text, so the real closing tag is the last one.

> **Compaction → one chip.** A single `/compact` writes up to four records around the boundary: the `/compact` command-name, the `isCompactSummary` continuation summary, the `compact_boundary`, and the `Compacted (ctrl+o…)` stdout echo. To avoid rendering three+ markers per compaction, `readRecentMessages()` keeps only the `isCompactSummary` record — emitted as a `type:'user'` system message with `systemLabel:'Compacted'` and the summary body on `compactSummary` (preamble stripped). The command-name and stdout echo are mapped to `__skip__` in `getSystemMessageLabel()`, and the adjacent-`Compacted` collapse pass carries `compactSummary` onto the surviving chip. The frontend renders the chip collapsed and expands `compactSummary` as markdown on click. Assumes the modern inline-summary format; legacy sessions whose summary lives in `subagents/agent-acompact-*.jsonl` are surfaced separately via `readCompactSummaries()`. `GET /api/sessions/:id/messages` calls `readCompactSummaries()` only when a `Compacted` chip on the page has no inline `compactSummary`, and `fillCompactSummaries()` gives each such chip the subagent summary nearest its timestamp (within 2 min), never by position, because a page can start at any compaction; a chip with an inline summary keeps it. `readCompactSummaries()` reads the whole transcript (30–140 ms on 10–55 MB), and its cache is keyed by mtime, so for an active session it would run on every page.

A FS event from the matching watcher updates the metadata pipeline incrementally:

- `projectsWatcher` `change` (jsonl appended) → `dirtyMetadataPaths.add(filePath)`. The next `loadSessionMetadata()` call runs `refreshSessionMetadataPath` on each dirty entry — one `stat` + tail-delta read per file, no directory walk.
- `projectsWatcher` `add` / `unlink` (jsonl created/removed) → `metadataNeedsFullScan = true`. Reshapes the session set, so the next call does the full directory scan.
- `plansWatcher` → no metadata invalidation; `getPlanInfo` runs fresh inside `buildSessionObject` every call. The broadcast alone is enough to make clients refetch.
- Workflow scripts (`projects/<projEnc>/<sessionId>/workflows/scripts/*.js`, written by the Workflow tool) sit at depth 4 — below `projectsWatcher`'s `depth: 2` — so there is no watcher for them. `getWorkflowInfoSummary(id)` reads `workflowIndexCache` inside `buildSessionObject` and self-refreshes on a 5 s TTL. The script's `projEnc` can differ from the session's own JSONL dir (the workflow may run from a different cwd), so the index scans every project dir once per refresh rather than deriving the path from `meta.jsonlPath`. Adds only a `Map` lookup per session on the hot path — no JSONL reads.
- `GET /api/sessions/:id/workflow-live` is the one workflow path on a repeating poll: the zen sidebar asks every 5 s while a run is live, so it reads the run's `journal.jsonl` and never an agent transcript, and both that read and the script's `meta` parse go through `cachedByMtime` — a repeat poll costs the `statSync` it already pays to test the run's idle time. It also passes `skipScan` to `resolveWorkflowRunDir`, because that function's fallback scan of every project dir is a cold-path cost a poll must not repeat; a run dir the two `existsSync` probes miss simply reads as not live.

`scratchpadDir` comes first from the transcript: Claude Code writes an `attachment` of type `environment` at each process start, and its `snapshot.scratchpadDirectory` is the dir that process used, so it already holds `CLAUDE_CODE_TMPDIR`, the uid suffix and the worktree key. `readSessionInfoFromJsonl` keeps the last one from the lines it already parses. A cold scan that leaves the middle of the file unread keeps one only from the tail: a resume in another dir writes a newer record that can sit in the unread middle, so the head's may be stale. Later records arrive through the incremental scan. On Windows the record holds the 8.3 short form, so `getScratchpadDir` turns its root (three levels up) into the long form once per root (`realpathDeepest` from `lib/contain.js`) and caches it. Older and short CLI or SDK transcripts have no such record, and neither has a large transcript whose last record is in the unread middle. For those, `scratchpadDir` is derived by convention from `meta.jsonlPath`, not looked up: `path.join(SCRATCHPAD_ROOT, path.basename(path.dirname(jsonlPath)), id, 'scratchpad')`. `SCRATCHPAD_ROOT` (`scratchpadRoot` in `lib/scratchpad-dir.js`) follows Claude Code's rule: the first absolute `CLAUDE_CODE_TMPDIR`, from `env` in `<config dir>/settings.json` and then from cck's own env, else `/tmp` on macOS and `os.tmpdir()` elsewhere, plus `claude-<uid>` on macOS and Linux or `claude` on Windows. It is read once at startup and resolved with realpath, as Claude Code resolves it, so on macOS it is `/private/tmp/claude-<uid>`. The harness creates the per-session dir lazily on first temp write, so a `statSync` here would both report "missing" for most sessions and add IO per session to the hot path. For a session that never moved its transcript it is a pure string join, the same cost as `projectDir`. Consequence: the path may not exist, and the UI's open-folder action fails with a toast in that case.

The exception is a session whose transcript moved, usually by entering a worktree (`claude -w` or EnterWorktree). Claude Code (2.1.289) keys the scratchpad on the process's original cwd, computed once per process, so a session that started in the main checkout keeps a repo-keyed scratchpad, and a resume from inside the worktree keys a fresh one there. `lib/scratchpad-dir.js` takes the launch dir as the other candidate: `meta.project` (the first `cwd` in the log), or its repo when that is itself a linked worktree, because an old `claude -w` log reads as the worktree from its first entry. An existing launch-keyed dir wins over an empty or missing by-project dir. A by-project dir that holds an entry wins for good and is cached, so only the launch-keyed files are hidden then, never merged. The transcript's `worktree-state` records carry `originalCwd` too, but they sit past the head the hot path reads, and a resume's new key is in no file. A worktree of a submodule points its `.git` at `<super>/.git/modules/<sub>/worktrees/<name>`; `lib/worktrees.js` maps that to the checkout `<super>/<sub>`. `encodeProjectDirName` mirrors the harness spelling of a path into a dir name: every non-alphanumeric character becomes a dash.

Listing what is *in* that dir is a separate, cold-path endpoint (`GET /api/sessions/:sessionId/scratchpad-files`), rendered as the file rows under the UI's Scratchpad path row. Clicking a row previews the file in the app: `/api/preview` now knows a third kind, `text`, for source and data extensions, rendered escaped in a `<pre>` and highlighted by extension, so the modal covers the `.py`/`.json`/`.js` files these dirs are full of. A 400 from that endpoint (an archive, an image, an unlisted extension like `.html.before`) is the client's signal to open the file in the editor instead. It returns one level of the dir — every file and folder, any extension, newest first whatever the kind (a folder's own mtime, which moves only when an entry is added or removed directly in it — deliberately not `max(mtime)` over its children, which would cost a `readdir` per folder to order a list the user scans by eye) — and never walks: sessions drop clones and build output in their scratchpad, and of 1302 real dirs measured the largest held 139k entries behind 64 top-level ones — an unpruned walk of it costs ~800 ms against 0.6 ms for the flat `readdir`. Top-level counts top out at 95 entries, so the endpoint returns the whole list and the client collapses it to three; expanding is a local re-render and costs no request. Folders render collapsed; opening one asks the same endpoint for that folder with `?path=<the absolute path the listing handed out>`, which `lib/scratch-files.js` resolves against the root and checks with `isContained` before the `readdir`, so a `..`, a symlink out or any path under another dir gets a 400 and nothing outside the root is ever listed. The client keeps one entry per *open* folder, keyed by that path, and drops it on close: the cache is bounded by what is on screen, a reopen costs one request and shows fresh contents, and a TTL refetch of the root list neither refetches nor collapses an open folder. The per-entry `stat` the sort needs, not the `readdir`, is where the time goes — 95 of them cost 2.0 ms awaited one at a time against 0.9 ms fanned out through `Promise.all`, which is what the endpoint does. Nothing is cached server-side, so the client holds each list on a 10 s TTL; without it the zen panel, which re-renders on every SSE tick, would poll the dir every 2 s. Keep this off the session-list hot path: at 0.05 ms per dir it would add ~60 ms to every scan.

Eager recursion is a deliberate omission, not an oversight: a pruned depth-3 walk measures 0-3 ms on the same worst-case dirs, but lazy folders give the same view at one `readdir` per click with no depth or entry cap to tune. Notes written by the `scratch` skill live at `_scratchpads/<name>/` under whatever working folder the session used, not under this dir; those reach the UI through `/api/sessions/:id/pads` instead.

`gitBranch` recorded in the JSONL is pinned to the launch-time repo and goes stale as soon as `cwd` shifts (Bash `cd`, submodule, sibling repo). A `claude -w` session is wrong from the start: every line records the main checkout's branch, though cwd never leaves the worktree. `sessionGitBranch` (`lib/git-branch.js`) reads HEAD when `cwd` differs from the project or the project is a linked worktree (the `worktrees.resolve` result `buildSessionObject` already holds for the `worktree` field), via `getGitBranch(cwd)`, cached per-cwd, and falls back to the JSONL value when it finds none. `readGitBranch` (`lib/git-branch.js`) walks up from `cwd` to the first `.git`, follows a `gitdir:` pointer file (linked worktree, submodule) and reads the branch from `HEAD`. It spawns no git, because a sync spawn here blocks the event loop for up to half a second per cwd on Windows, and terminal input waits behind it. A detached HEAD reads as no branch.

`worktree` names the main checkout a linked worktree belongs to, so the session card can show `<repo> ⑂ <worktree>` instead of a leaf folder name that loses the repo. `worktrees.resolve(meta.project)` reads `<project>/.git` — a *file* in a linked worktree, holding `gitdir: <main>/.git/worktrees/<name>` — and parses the main checkout out of it. No git spawn, and no dependence on path shape: only some worktrees live under `<repo>/.claude/worktrees/`, the rest sit beside the repo under any name. Cost on the hot path is one failed `readFileSync` (`EISDIR` for an ordinary checkout's `.git` directory) or one small successful read, once per distinct project dir: a path cannot change between checkout and worktree without being recreated, and a recreated path is a new key. Misses are cached in memory, since most projects are not worktrees. Hits are saved to `.cck/worktrees.json` in one write at the end of the tick, because Claude Code deletes a worktree while its transcripts stay; a saved hit costs no read. When the pointer file is gone, a path under `<repo>/.claude/worktrees/<name>` resolves by its shape. `null` for an ordinary checkout, and for any other path whose pointer file is unreadable. Retention of the saved hits: `docs/retention.md`.

`readSessionInfoFromJsonl` also captures `logicalParentUuid` **and** `compactBoundaryUuid` (the boundary record's own `uuid`) from any `compact_boundary` record found in the bounded preamble (head cap 1 MB). The `/api/sessions` compact-continuation suppression pass reads both off the cached metadata — no per-request full-JSONL rescan. `findCompactBoundary` remains as a fallback in `lookupParentSession` for paths that bypass the metadata cache, and also runs when a cached entry has the anchor but no boundary uuid (entries cached before the field existed).

**Fork vs compact continuation.** A fork taken off an already-compacted transcript copies the parent's `compact_boundary` record verbatim, so the child gets a `logicalParentUuid` and is indistinguishable from a real compact continuation by anchor alone — which used to make the suppression pass delete the (still running) parent card. The discriminator is `compactBoundaryUuid`: a fork's copy is present in the parent JSONL, a genuine continuation's is freshly generated and is not. `findSessionContainingUuid` probes it with one `String.includes` on the winning candidate's text (already read for the anchor scan) and returns `isFork`.

`lookupParentSession` turns that evidence into a single verdict, `relation: 'none' | 'compact' | 'fork'` (`isCompact`/`isFork` are derived views kept for the `/api/sessions/:id/parent` response shape). An anchor found by `findForkAnchorUuid` — no boundary record at all — is a fork by construction. Consumers: the suppression pass only deletes a parent when `relation === 'compact'`, and the session-info modal labels the row *Continued from* vs *Forked from* off the same field. Two safeguards remain independent of the heuristics: the pass keeps its cheap `metadata[sid].logicalParentUuid` pre-gate (a `lookupParentSession` without a cached verdict reads JSONLs, so it must not run for every session), and a post-pass drops any id present in the live-session registry (`loadLiveSessions`, 5 s cache) — a running process is never a superseded lineage.

`readTitles` is the one reader that can cover a whole file, once per file per cache lifetime. It reads 1 MB chunks from the end and stops at the first chunk with a title, because the last such chunk wins; `extractTitlesFromBuffer` decodes only the lines that hold a marker. The same pass keeps the last `agent-name` record apart as `agentName`, the session's peer name, which outlives the live registry entry. The task routes use it to link a card's owner to a session that the list's session dispatched or that is mapped to the list (`ownerLinks` in `lib/owner-routing.js`). `buildSessionObject` itself never reads a full JSONL.

### 3. Boot-time prewarm

`prewarmCaches()` runs once, after the first `/api/sessions` answer is sent, or `PREWARM_FALLBACK_MS` (5 s) after `app.listen` when no client asks. It primes the metadata + loop-info caches in the background so later requests land warm. It does not start on the ready line because its full read of every transcript competes for disk and CPU with the hub's other apps while they render.

Steps, with a `setImmediate` yield after every `PREWARM_SLICE_MS` (10 ms) of work so any inbound request isn't starved. The yield is by time, not by session count, because one large transcript is a long synchronous read:

1. `loadSessionMetadata()` — full directory scan, populates `sessionMetadataCache`.
2. For each metadata entry: `refreshLoopInfoState(meta.jsonlPath)` — primes `loopInfoStateByPath` so the per-session loop scan is a single `statSync` afterwards.

Previously this also pre-warmed `gitBranchCache` per distinct `cwd` and ran a self-request to `/api/sessions?limit=all` to drive task-count / plan / team / agent caches. Both were removed once the `/api/sessions` handler grew a **cheap-probe** for `?filter=active`: inactive non-pinned sessions short-circuit before `buildSessionObject`, so the survivors (typically <10) don't need bulk-warmed caches. The self-request was 690× wasted work for an active-filter first hit.

No new SSE event. Watchers remain authoritative for incremental updates after boot.

### 3a. Persistent session cache

`sessionInfoCache`, `customTitleCache`, `logActivityCache` and the parent verdicts (`lib/parent-cache.js`) are saved to `<config dir>/.cck/session-cache.json` (`lib/session-cache.js`) and loaded before `listen`, so the first `/api/sessions` after a restart does not parse every transcript again. Without it, that parse is most of the cold list time.

- **When it is saved:** after the prewarm, every `SESSION_CACHE_SAVE_MS` (30 s) when an entry changed, and on `exit`. The timer is needed because under the hub a child can end by `TerminateProcess` on Windows, where no exit handler runs.
- **How it is written:** the whole file each time, to a temp file and then renamed over the old one. Never appended.
- **What bounds it:** `exportSessionCaches` leaves out entries whose transcript is gone, so the file holds at most the live transcripts (≤ `SESSION_INFO_CACHE_MAX`, 2000, per map). A file over 8 MB is deleted and rebuilt cold. A file with another `VERSION`, or one that does not parse, is ignored.
- **Why it is safe:** an entry is used only while `sameFileGrown` holds for the file's current `stat`: same inode, not shorter, and a changed mtime only together with new bytes. A grown file is read from `scannedUpTo`, as in memory. A file rewritten in place, replaced or truncated is parsed from the start. The worst case is a cold parse, never a stale row. A `logActivityCache` entry is the other way round: it is kept exactly while inode and size match, so a transcript touched while cck was stopped does not move its session on the first list.

**Parent verdicts.** A `lookupParentSession` verdict depends on sibling transcripts, not on one file, so it has its own check (`getParentVerdict`), run on every use, in memory and after a restart alike. A parent is always born before its child, so only the transcripts of the child's folder born before it can change a verdict; new sessions cannot. The entry keeps the child's inode, the parent's inode, the child's `logicalParentUuid`, and the number of transcripts in the folder born before the child (`countTranscriptsBornBefore`, from the `birthtimeMs` in `sessionInfoCache`, so the check reads no other file). A replaced child or parent, an anchor seen later, or an older transcript moved into the folder makes the entry stale, and the lookup runs again. A deleted transcript stays in `sessionInfoCache` until the next save, so it does not change the count; a deleted parent fails the inode check. A lookup that finds no anchor is not stored, because the child's head is not written yet.

**Task counts.** `getTaskCounts` keeps a per-folder result in `taskCountsCache`, which the tasks and task-maps watchers clear. Under it, `lib/task-counts.js` keeps the status of each task file, saved in the same file under `taskCounts`. A recount stats every task file and reads again only a file whose size, mtime or inode changed, so a change made while cck was stopped is seen on the first list. `pending`, `completed` and `in_progress` have different lengths, so a status edit changes the size even when the mtime does not move. A file written less than `RACY_MS` (3 s) before it was read is not stored, because a coarse mtime (2 s on FAT) could stay the same over a second write of the same size. A read that fails is not stored either. A folder's entry is replaced on each recount, so deleted files drop out, and folders that are gone are left out of the save.

Loop state is not saved, so a cold first list still computes it.

### 3b. Cheap-probe on `?filter=active`

In `/api/sessions`, when `req.query.filter === 'active'`, each candidate session is gated by a probe **before** the expensive enrichers (`buildSessionObject`, `getPlanInfo`, `loadTeamConfig`, `sessionGitBranch`, `getLoopInfoSummary`, `getContextStatus`):

```
hasMessages && (
  hasVisibleLogActivity(id, logAge)  // grace window OR hasRecentLog, see below
  || agentStatus.hasActive
  || agentStatus.waitingForUser
  || pending > 0 || inProgress > 0   // pass 1 only (tasks dir exists)
)
```

`agentStatus.hasActive` (from `checkAgentStatus`) is set only by agents with `status: 'active'` — `idle` never counts, since an idle teammate can linger for hours after work ends and would pin the session in the active filter. Team sessions skip the freshness (`AGENT_TTL_MS`) check so long-running teammates stay visible; non-team agents must be fresh.

`hasRecentLog` is `hasRecentLogActivity(sessionId, logAge)`, not raw mtime recency: an open-but-idle interactive session keeps touching its JSONL (metadata-line rewrites), so mtime alone would read as activity for as long as the terminal stays open. The live-session registry (`~/.claude/sessions/<pid>.json`, already cached 5 s by `loadLiveSessions()`) carries the session's real `status`; a registry `status: 'idle'` suppresses the recent-log signal. No registry entry (process exited) or any other status falls back to the mtime rule.

The same registry entry gives a running session its `name`, the address SendMessage and ListAgents use. `getPeerName(sessionId)` reads it from the cached registry and probes the pid, because a crashed claude leaves its file behind. The session object carries it as `peerName`, which the board shows as "Peer name" in the session info. Ctrl+Shift+C and that row's copy button copy it as `SendMessage(<name>)`. It is not the display name: Claude Code often derives it from the folder name (`nameSource: 'derived'`), so the title stays the transcript title (`customTitle`, then `slug`). A name set by the user (`--name`, `/rename`) is also written to the transcript as `agent-name` records, which cck keeps as `agentName` after the session ends.

`hasVisibleLogActivity(sessionId, logAge)` widens `hasRecentLogActivity` with a `SESSION_GRACE_MS` (2 min) raw-mtime window, deliberately ungated by registry-idle, so a session doesn't vanish from the active list the instant a turn ends. It is exposed as `hasRecentActivity` on the session object and drives **visibility only** — the probe, the post-filter, and the client's active-list predicate — never the "active" status badges, which stay on `hasRecentLog`. The one place it shows is the gray "recently active, idle" dot, which tells a session in the grace window from an inactive one (see [session-states.md](session-states.md)). Trade-off: an open idle terminal's metadata rewrites keep re-arming the window, so each open terminal stays a probe survivor while it's open.

Pinned IDs (regular pins, sticky pins, revealed-plan, revealed-storage, focused `currentSessionId`) bypass the probe and always get full enrichment. The post-filter at the end of the handler stays as a safety net but operates on a now-small map.

Cost: per-candidate work is one `statSync`, one `getTaskCounts` map lookup, one `checkAgentStatus` `readdirSync` of the session's activity dir (it answers `_waiting.json`, `_stop.json` and the agent files from one listing). ~690 candidates → ~5 survivors hit `buildSessionObject`.

### 3c. Team-leader enrichment & auto self-team filtering

After the session map is built, a pass over `TEAMS_DIR` enriches the leader session of each team (`cfg.leadSessionId`) with `isTeam`, `teamName`, `memberCount`, and the team-named task dir, and removes the team-named duplicate entry.

Recent Claude Code releases auto-create a single-member **self-team** per session: `teams/session-<id>/config.json` whose only member is the `team-lead` (the session itself), plus an empty `tasks/session-<id>/` dir. Without filtering, every solo session renders a team badge, member panel, and a shared-task-list link (from the empty task dir). `isAutoSelfTeam(cfg)` skips these in the enrichment loop: a config whose `name` starts with `session-` and whose members are empty or a sole `team-lead`. The team-named duplicate removal runs **before** this skip — otherwise a `session-<id>` self-team dir leaves a duplicate session card whose `session-<id>` id resolves no messages, so switching to it shows a stale log. Genuinely-named teams (e.g. `dev-qa-team`, `code-review`) are unaffected, and a self-team that gains a real teammate (`members.length > 1`) is enriched as a true team again.

**Orphaned self-team task recovery.** Claude Code 2.1.x stores a session's tasks in its self-team list (`tasks/session-<id>/`), not a UUID-named dir, so those tasks are dropped by the `isAutoSelfTeam` skip. Recovery runs in the enrichment loop and attaches the tasks to the **owning card** via `attachTeamTasks()`, resolved in order:

1. `cfg.leadSessionId` — usually the session itself, already carded. The common case; an exact id match, no heuristic.
2. The live session **continuing** it. A resumed/continued session keeps writing to the original team's list under a new session id, so `leadSessionId` becomes a ghost with no card. The bridge is the live-session registry `~/.claude/sessions/<pid>.json` (`{sessionId, cwd, startedAt, kind}`, live processes only): `resolveSelfTeamOwner(cfg)` matches the interactive session sharing the team's cwd whose `startedAt` is within `SELF_TEAM_BOOT_WINDOW_MS` (60s) of the team's `createdAt` — both written at boot, so the window is tight. `loadLiveSessions()` caches the registry for 5s.
3. Fallback — neither resolves (ended session, no registry entry): a card is built under the lead id, named from `cfg.name`. This branch is gated on `taskCount > 0` so an empty stale self-team never fabricates a card (the noise case). When an owning card **does** exist, an empty dir is still attached — a resumed session's freshly-emptied current dir (task list closed) must win latest-wins to suppress its own stale prior-boot dir.

`getCustomTaskDir(sessionId)` mirrors steps 1–2 (`cfg.leadSessionId === sessionId || resolveSelfTeamOwner(cfg) === sessionId`) so the per-session task/detail endpoints load the tasks under the live session id too. A live session can own **several** team dirs at once — a **stale dir from a prior boot** of the same session id, plus the **current run's dir** (a resume creates a fresh self-team) — so `getCustomTaskDir` picks the **most recently written** owning dir ("latest wins"): compare each dir's last-write mtime — the newer of its **directory mtime** (bumps on add/remove) and its **newest task-file mtime** (bumps on in-place status edits) — and break ties by task count. Using the directory mtime is what lets a **freshly-emptied current dir** (task list closed → no files, task-file mtime 0) still outrank a stale prior-boot dir by the time it was cleared, rather than falling back to yesterday's tasks. The earlier "richest wins" (most tasks) rule picked a **stale** dir whenever a completed prior run had accumulated more tasks than the live one — the board then showed yesterday's frozen task list while marking the session active from its live JSONL. `attachTeamTasks()` uses the same latest-wins rule (recomputing the currently-attached dir's mtime from the path-cached counts, so no extra field is stored on the card) and is shared with the true-team leader enrichment.

### 4. Periodic timers (cleanup only — not scanning)

| Timer | Interval | Purpose |
|---|---|---|
| `cleanupAgentActivity` | 60 min (`CLEANUP_INTERVAL_MS`) | prune old agent-activity files |
| `runRetention` | 60 min, first run 5 min after start | drop per-session state, context-status files included, whose transcript is gone (`docs/retention.md`) |
| SSE heartbeat | 30 s | keep-alive on `/api/events` |

No timer enumerates projects or sessions.

### 5. Client-side polling

`public/app.js` is largely SSE-driven, with these timers:

- `agentPollInterval` — every 3 s, while any footer agent is active or idle, refetches agents for the focused session, or for every session in project view (`renderAgentFooter`). It catches status changes that come only from the server's TTL checks and write no file.
- `agentDurationInterval` — re-renders elapsed time in the agent footer every 1 s (10 s when no agent is active or idle); pure render, no fetch.
- Fallback poll — `fetchSessions()` every 30 s in case SSE drops silently (`setupEventSource`).

Session list updates arrive via SSE (`metadata-update`, `agent-update`, …), debounced in the SSE dispatcher: 500 ms for tasks, 2 s for metadata. The metadata debounce is capped at 5 s (`METADATA_MAX_WAIT_MS`), because busy sessions emit events faster than the 2 s quiet period and a pure debounce would never fire.

All of the above do no work while cck is off screen: the browser tab is hidden, or the hub has sent `hub:active` false. They call `skipOffScreen()`, which sets `missedWhileHidden`. When cck is back on screen, `catchUp()` cancels the pending debounces and runs one refresh for the current view. The fallback poll marks a miss only when SSE is not open. Other SSE events, such as the CLI commands, are still handled while hidden.

## Loop activity scan (`updateLoopInfo`)

The clock badge on session cards needs to know whether a session contains `ScheduleWakeup` / `CronCreate` / `CronDelete` tool calls. Computed by `updateLoopInfo(jsonlPath, prevState)` in `lib/parsers.js`, called from `getLoopInfoSummary` in `server.js`.

### Hot-path constraint: no full scans

`getLoopInfoSummary(meta)` runs in `/api/sessions` after the limit, once per row sent, not in `buildSessionObject`. A cold state is a full read of the transcript, so running it for every session made the first list pay for all of them. `buildSessionObject` is still invoked **once per session per `/api/sessions` response**. Anything that reads a full JSONL there scales N×file-size per list refresh — unacceptable.

> **Hot-path rule.** Code reachable from `buildSessionObject` MUST NOT do full-JSONL reads. Use incremental / append-only scanning with a per-path state cache warmed by `projectsWatcher`. Full-file readers in `lib/parsers.js` (`readFullToolResult`, `readUserImage`, `readToolResultImage`, `readMessagesPage`, `buildSessionDigest`, `readCompactSummaries`, `readArtifactLinks`, `readScratchpadCreations`, `extractTranscriptStats`) are fine — but they run on dedicated endpoints, never in the list path. Except `readMessagesPage`, they are async and stream the file through `readLines` (1 MB chunks), as does `buildToolStats` in `server.js`. A transcript reaches hundreds of megabytes, and a whole-file `readFileSync` blocked the event loop for up to a second per call, which froze typing in the embedded terminal: its keys and output pass through the same loop. Their caches (`sessionDigestCache`, `toolStatsCache`, `compactSummaryCache`, `artifactsByPath`, `padsByPath`) hold the pending promise, so concurrent asks share one read, and a transcript that grows during a read starts no second one until it settles. `extractTranscriptStats` (model + summed output tokens + first/last timestamp per subagent transcript) is called only by the workflow run view (`GET /api/sessions/:id/workflows/:wfId/run`), once per agent when that modal is opened — cold path. `readArtifactLinks` (published artifact links, keyed by URL) is the same shape: `GET /api/sessions/:id/artifacts`, asked for when the zen panel or the session-info modal opens. Its cache is `artifactsByPath` in `server.js`, keyed by JSONL path and invalidated by `mtimeMs`/`size`, so a repeat ask costs one `statSync` — which is what lets the panel re-ask on every render instead of going stale after a publish. Why a result is tied back to its `tool_use` is explained next to the code.

`readScratchpadCreations` shares that shape and that `tool_use`→`tool_result` pairing, for `GET /api/sessions/:id/pads` — the pads a session made with `scratch new`, folded into the linked-documents list. It returns one `{ ts, path, name }` per call. `path` is the manifest the CLI printed, which names the pad outright; it is null whenever the command piped its output away, which is the common case rather than an edge one — the manifest is the 4th of ~13 lines of output, so any `| tail -N` an agent writes cuts it off (`scratch new … | tail -2` is a real transcript). `name` is the pad name read back out of the command, which the manifest stores as its own `name`. `readCreatedPads` in `server.js` reads the reported paths directly and falls back to a walk of `meta.project` and of the session's scratchpad dir (`getScratchpadDir`, always in the long form of an 8.3 short temp path) for the unresolved calls, claiming each scanned pad by the strongest rule that applies to it. A manifest `id` decides ownership outright and both ways — `scratch new --id <session-id>` stamps the session that asked for the pad, so an id naming another session disowns it whatever else matches. Only a pad with no id is guessed at: first by a `name` the command asked for, and failing that by the clock, pairing the pad's `created` with a `ts` inside `PAD_CREATE_WINDOW_MS`. That last comparison floors `ts` to its second, because `created` has second resolution and a pad written during the same second as its command otherwise reads as older than it. The `--id` flag is optional in the CLI, so the guessing tiers stay live for every pad made without it. That walk is pruned and capped at depth 3, for the reason measured above: unpruned it costs ~800 ms on the worst-case project dirs. The cache is `padsByPath`, through the same `cachedByFileStat` helper as `artifactsByPath`; it stores the pending promise, so concurrent asks share one read. The rows are derived on every read and never stored. The client links each one into the ordinary linked-documents list, `preview-paths-<sessionId>`, exactly once — after that a pad row is indistinguishable from a hand-linked document, so the badge and the unlink button need no special case. Rows are matched through `canonicalPath`, not by string equality, because a pad path is built with `path.join` while a hand-typed one is stored as it was typed — on Windows the same file otherwise linked twice, once per separator. `autolinked-pads-<sessionId>` records which pads that has already happened for, which is what stops a re-read of the transcript undoing an unlink.

### Design: append-only incremental scan

JSONL is append-only: new tool_use / tool_result lines only appear at the end. So we keep per-path state:

```
{ mtimeMs, size, scannedOffset,
  wakeups[], crons[],
  taskIdByToolUseId<Map>,   // resolves CronCreate tool_use_id → cron task id
  deletedTaskIds<Set> }     // populated by CronDelete
```

Each call to `updateLoopInfo(path, prev)`:

1. `statSync` the file. If `mtimeMs` + `size` match `prev` → return `prev` as-is (zero IO beyond `stat`).
2. Otherwise `fs.openSync` + `readSync` from `prev.scannedOffset` to current `size` — reads only the appended delta.
3. Process complete lines (anything past the last `\n` is held back until next call).
4. Mutate `wakeups` / `crons` / `taskIdByToolUseId` / `deletedTaskIds` in place; advance `scannedOffset`.

If `size < prev.size` (file truncated/replaced) → start over from offset 0.

A `ScheduleWakeup` call first drops every wakeup that has not fired by the call's timestamp, because the harness keeps one pending wakeup per session: a newer call replaces it, and `stop: true` cancels it. A stop call adds no row. Wakeups that already fired stay, so the 5-min grace filter below still shows the last one.

`buildLoopInfoFromState(state)` resolves cron task ids on read and filters out cancelled crons. This keeps the cron state monotonic (append-only) — `CronDelete` doesn't mutate prior entries, it only adds to `deletedTaskIds`.

### Watcher warming

`projectsWatcher.on('all', …)` in `server.js` calls `refreshLoopInfoState(filePath)` on every `add`/`change` event. By the time the client refetches `/api/sessions` after the corresponding `metadata-update` SSE, the state cache is already current. Steady-state request cost: one `statSync` per session, no `readSync` at all.

`unlink` events delete the entry to bound memory.

### Substring fast-reject (still applies)

Two gates run before `JSON.parse`:

1. **Bytes.** `hasLoopMarker` tests the appended bytes with `Buffer.includes` for `"ScheduleWakeup"` / `"CronCreate"` / `"CronDelete"`, and for the id of each `CronCreate` call whose task id is still unknown. Bytes with no marker are never decoded: `scannedOffset` moves to the last `\n` and a partial last line waits for the next call. Most appends take this path.
2. **Lines.** When the bytes hit, each complete line is checked for the tool names. A tool result is parsed only when it holds `"tool_use_id"` and the id of a pending `CronCreate`, because `buildLoopInfoFromState` reads `taskIdByToolUseId` only for cron ids, and a result is always written after its `tool_use`. Other tool results, most lines of a transcript, are skipped.

### 5-min fired-grace filter

`filterActiveLoopInfo` (`server.js`) hides wakeups whose computed fire time is more than `WAKEUP_FIRED_GRACE_MS` (5 min) in the past. Applied at consumption sites only (`getLoopInfoSummary`, `/api/sessions/:id/loop`), because it depends on the current time; the cached state does not.

### Cost summary

| Scenario | Work per call |
|---|---|
| Unchanged file | `statSync` + Map lookup |
| File grew by Δ bytes | `statSync` + `readSync(Δ)` + parse only the new substring-matching lines |
| First-time access (cold) | Single `readSync` of full file, processed once per process lifetime |
| File truncated/replaced | Cold-start rescan |

The cold first-access is the only remaining full read. In practice the watcher warms it before any request arrives.

### Live updates

No new SSE event. The existing `projectsWatcher` `metadata-update` flow already triggers the client to refetch.

## Summary

- **Discovery latency** ≈ chokidar FS event latency (ms).
- **Worst-case staleness** for a cached read with no FS event = `METADATA_CACHE_TTL` (10 s).
- **No interval-based scanning** of the projects directory.
- **Loop scan** is per-session on `/api/sessions` but cheap-rejected via substring check + mtime-cached for unchanged files.

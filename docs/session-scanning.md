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
| `agentActivityWatcher` | `AGENT_ACTIVITY_DIR` | 2 | `*.jsonl` / `_waiting.json` | `agent-update` (with team-leader fan-out) |
| `contextStatusWatcher` | `CONTEXT_STATUS_DIR` | 0 | `*.json` | context status broadcast |

Notable options:
- `agentActivityWatcher` uses `awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }` to coalesce rapid writes.
- `contextStatusWatcher` has `ignoreInitial: false` (others ignore initial scan).

Session discovery proper happens via `projectsWatcher` on `~/.claude/projects/**/*.jsonl`.

### 2. On-demand scans with TTL caches

These run only when an API request is served (no background timer).

| Function | Cache | TTL | Source |
|---|---|---|---|
| `loadSessionMetadata()` | `sessionMetadataCache` | `METADATA_CACHE_TTL = 10000` ms (per-path dirty set for hot updates) | `server.js:389` |
| `readSessionInfoFromJsonl()` | `sessionInfoCache` | inode-keyed; `slug`+`projectPath`+`logicalParentUuid` pinned, `cwd`+`goal` refreshed from appended bytes only | `lib/parsers.js:225` |
| `getGitBranch(cwd)` | `gitBranchCache` | `GIT_BRANCH_TTL_MS = 30000` ms, keyed by `cwd` | `server.js` |
| Task-map scan | `sessionToTaskListCache` | `TASK_MAP_SCAN_TTL = 5000` ms | `server.js:271` |
| `readRecentMessages()` / session info | `messageCache` (keyed by mtime) | invalidates on file mtime change | `server.js:382` |
| `updateLoopInfo()` (ScheduleWakeup / Cron* scan) | `loopInfoStateByPath` (per-path incremental state) | warmed by `projectsWatcher` events; request path is O(1) on hit | `lib/parsers.js` + `server.js` |

> `readRecentMessages()` dispatches transcript lines by `type`. Besides `user`/`assistant`/`teammate`, it surfaces `queue-operation` (`operation: 'enqueue'`) lines as user messages flagged `queued: true`. Queued text lives at the top-level `content`, not under `message.content`, and is never re-emitted as a `type:'user'` line, so without this branch it never renders.

> **Compaction → one chip.** A single `/compact` writes up to four records around the boundary: the `/compact` command-name, the `isCompactSummary` continuation summary, the `compact_boundary`, and the `Compacted (ctrl+o…)` stdout echo. To avoid rendering three+ markers per compaction, `readRecentMessages()` keeps only the `isCompactSummary` record — emitted as a `type:'user'` system message with `systemLabel:'Compacted'` and the summary body on `compactSummary` (preamble stripped). The command-name and stdout echo are mapped to `__skip__` in `getSystemMessageLabel()`, and the adjacent-`Compacted` collapse pass carries `compactSummary` onto the surviving chip. The frontend renders the chip collapsed and expands `compactSummary` as markdown on click. Assumes the modern inline-summary format; legacy sessions whose summary lives in `subagents/agent-acompact-*.jsonl` are surfaced separately via `readCompactSummaries()`.

A FS event from the matching watcher updates the metadata pipeline incrementally:

- `projectsWatcher` `change` (jsonl appended) → `dirtyMetadataPaths.add(filePath)`. The next `loadSessionMetadata()` call runs `refreshSessionMetadataPath` on each dirty entry — one `stat` + tail-delta read per file, no directory walk.
- `projectsWatcher` `add` / `unlink` (jsonl created/removed) → `metadataNeedsFullScan = true`. Reshapes the session set, so the next call does the full directory scan.
- `plansWatcher` → no metadata invalidation; `getPlanInfo` runs fresh inside `buildSessionObject` every call. The broadcast alone is enough to make clients refetch.

`gitBranch` recorded in the JSONL is pinned to the launch-time repo and goes stale as soon as `cwd` shifts (Bash `cd`, submodule, sibling repo). `buildSessionObject` resolves the live branch via `getGitBranch(cwd)` (`git rev-parse --abbrev-ref HEAD`, cached per-cwd) and falls back to the JSONL value when the spawn fails.

`readSessionInfoFromJsonl` also captures `logicalParentUuid` from any `compact_boundary` record found in the bounded preamble (head cap 1 MB). The `/api/sessions` compact-continuation suppression pass reads this off the cached metadata — no per-request full-JSONL rescan. `findCompactAnchorUuid` remains as a fallback in `lookupParentSession` for paths that bypass the metadata cache.

The same scan also extracts the active session `goal` (`{condition}` or `null`) from `/goal`. The condition is carried by `goal_status` attachment records (latest-wins as the Stop hook re-evaluates). Only an **unmet** goal is surfaced — a `met:true` status means the goal was satisfied and auto-cleared by Claude Code, so it is treated as removal (`null`), exactly like a `/goal clear` command line. Extraction is folded into the existing per-line `applyLine` (forward, last-write-wins) plus the tail backward-scan (tail bytes are newer, so a tail goal/met/clear supersedes the head value) — **no extra IO**, it rides the bytes already read for `cwd`/`slug`. `goal` is cached in `sessionInfoCache`, merged through `loadSessionMetadata`/`refreshSessionMetadataPath` (direct-assigned, not guarded, so a met/clear propagates as `null`), and surfaced by `buildSessionObject`. The client renders a compact truncated subtitle on the session card and the full condition in the session-info modal; it never feeds `getSessionDisplayName`, so a user rename (`customTitle`) always takes precedence.

### 3. Boot-time prewarm

`prewarmCaches()` runs once via `setImmediate` after `app.listen` fires. It primes the metadata + loop-info caches in the background so the first user request lands warm.

Steps, with periodic `setImmediate` yields so any inbound request isn't starved:

1. `loadSessionMetadata()` — full directory scan, populates `sessionMetadataCache`.
2. For each metadata entry: `refreshLoopInfoState(meta.jsonlPath)` — primes `loopInfoStateByPath` so the per-session loop scan is a single `statSync` afterwards.

Previously this also pre-warmed `gitBranchCache` per distinct `cwd` and ran a self-request to `/api/sessions?limit=all` to drive task-count / plan / team / agent caches. Both were removed once the `/api/sessions` handler grew a **cheap-probe** for `?filter=active`: inactive non-pinned sessions short-circuit before `buildSessionObject`, so the survivors (typically <10) don't need bulk-warmed caches. The self-request was 690× wasted work for an active-filter first hit.

No new SSE event. Watchers remain authoritative for incremental updates after boot.

### 3b. Cheap-probe on `?filter=active`

In `/api/sessions`, when `req.query.filter === 'active'`, each candidate session is gated by a probe **before** the expensive enrichers (`buildSessionObject`, `getPlanInfo`, `loadTeamConfig`, `resolveSessionGitBranch`, `getLoopInfoSummary`, `getContextStatus`):

```
hasMessages && (
  logAge <= SESSION_STALE_MS        // hasRecentLog
  || agentStatus.hasActive
  || agentStatus.waitingForUser
  || pending > 0 || inProgress > 0  // pass 1 only (tasks dir exists)
)
```

`agentStatus.hasActive` (from `checkAgentStatus`) is set only by agents with `status: 'active'` — `idle` never counts, since an idle teammate can linger for hours after work ends and would pin the session in the active filter. Team sessions skip the freshness (`AGENT_TTL_MS`) check so long-running teammates stay visible; non-team agents must be fresh.

`hasRecentLog` is `hasRecentLogActivity(sessionId, logAge)`, not raw mtime recency: an open-but-idle interactive session keeps touching its JSONL (metadata-line rewrites), so mtime alone would read as activity for as long as the terminal stays open. The live-session registry (`~/.claude/sessions/<pid>.json`, already cached 5 s by `loadLiveSessions()`) carries the session's real `status`; a registry `status: 'idle'` suppresses the recent-log signal. No registry entry (process exited) or any other status falls back to the mtime rule.

Pinned IDs (regular pins, sticky pins, revealed-plan, revealed-storage, focused `currentSessionId`) bypass the probe and always get full enrichment. The post-filter at the end of the handler stays as a safety net but operates on a now-small map.

Cost: per-candidate work is one `statSync`, one `getTaskCounts` map lookup, one `checkAgentStatus` file check. ~690 candidates → ~5 survivors hit `buildSessionObject`.

### 3c. Team-leader enrichment & auto self-team filtering

After the session map is built, a pass over `TEAMS_DIR` enriches the leader session of each team (`cfg.leadSessionId`) with `isTeam`, `teamName`, `memberCount`, and the team-named task dir, and removes the team-named duplicate entry.

Recent Claude Code releases auto-create a single-member **self-team** per session: `teams/session-<id>/config.json` whose only member is the `team-lead` (the session itself), plus an empty `tasks/session-<id>/` dir. Without filtering, every solo session renders a team badge, member panel, and a shared-task-list link (from the empty task dir). `isAutoSelfTeam(cfg)` skips these in the enrichment loop: a config whose `name` starts with `session-` and whose members are empty or a sole `team-lead`. The team-named duplicate removal runs **before** this skip — otherwise a `session-<id>` self-team dir leaves a duplicate session card whose `session-<id>` id resolves no messages, so switching to it shows a stale log. Genuinely-named teams (e.g. `dev-qa-team`, `code-review`) are unaffected, and a self-team that gains a real teammate (`members.length > 1`) is enriched as a true team again.

**Orphaned self-team task recovery.** Claude Code 2.1.x stores a session's tasks in its self-team list (`tasks/session-<id>/`), not a UUID-named dir, so when that dir is non-empty the tasks are dropped by the `isAutoSelfTeam` skip. Recovery runs in the enrichment loop, gated on `taskCount > 0` (the empty-self-team noise case stays suppressed), and attaches the tasks to the **owning card** via `attachTeamTasks()`, resolved in order:

1. `cfg.leadSessionId` — usually the session itself, already carded. The common case; an exact id match, no heuristic.
2. The live session **continuing** it. A resumed/continued session keeps writing to the original team's list under a new session id, so `leadSessionId` becomes a ghost with no card. The bridge is the live-session registry `~/.claude/sessions/<pid>.json` (`{sessionId, cwd, startedAt, kind}`, live processes only): `resolveSelfTeamOwner(cfg)` matches the interactive session sharing the team's cwd whose `startedAt` is within `SELF_TEAM_BOOT_WINDOW_MS` (60s) of the team's `createdAt` — both written at boot, so the window is tight. `loadLiveSessions()` caches the registry for 5s.
3. Fallback — neither resolves (ended session, no registry entry): a card is built under the lead id, named from `cfg.name`.

`getCustomTaskDir(sessionId)` mirrors steps 1–2 (`cfg.leadSessionId === sessionId || resolveSelfTeamOwner(cfg) === sessionId`) so the per-session task/detail endpoints load the tasks under the live session id too. A live session can own **several** team dirs at once — its own (usually empty) self-team `session-<id>` plus a resumed session's dir holding the real tasks — so `getCustomTaskDir` picks the **richest** owning dir (most tasks), mirroring `attachTeamTasks()`'s "prefer more tasks" rule. Returning the first readdir match instead would pick the empty self-team dir, making the board show 0 tasks while the session card counts the other dir. `attachTeamTasks()` is shared with the true-team leader enrichment (prefer the team task dir over an empty UUID-named dir).

### 4. Periodic timers (cleanup only — not scanning)

| Timer | Interval | Purpose |
|---|---|---|
| `cleanupAgentActivity` | 60 min (`CLEANUP_INTERVAL_MS`) | prune old agent-activity files |
| `cleanupContextStatus` | 30 min | prune stale context-status files |
| SSE heartbeat | 30 s | keep-alive on `/api/events` |

No timer enumerates projects or sessions.

### 5. Client-side polling

`public/app.js` is largely SSE-driven, with one polling exception:

- `agentPollInterval` — refreshes the agent footer for the active project (`app.js:2225`). Stopped when no project is focused.
- `agentDurationInterval` — re-renders elapsed time in the agent footer every 1 s (10 s when idle); pure render, no fetch.

Session list updates arrive via SSE (`metadata-update`, `agent-update`, …), debounced in the SSE dispatcher (500 ms for tasks, 2 s for metadata).

## Loop activity scan (`updateLoopInfo`)

The clock badge on session cards needs to know whether a session contains `ScheduleWakeup` / `CronCreate` / `CronDelete` tool calls. Computed by `updateLoopInfo(jsonlPath, prevState)` in `lib/parsers.js`, called from `getLoopInfoSummary` in `server.js`.

### Hot-path constraint: no full scans

`getLoopInfoSummary(meta)` runs inside `buildSessionObject`, which is invoked **once per session per `/api/sessions` response**. Anything that reads a full JSONL there scales N×file-size per list refresh — unacceptable.

> **Hot-path rule.** Code reachable from `buildSessionObject` MUST NOT do full-JSONL reads. Use incremental / append-only scanning with a per-path state cache warmed by `projectsWatcher`. Full-file readers in `lib/parsers.js` (`readFullToolResult`, `readUserImage`, `readMessagesPage`, `buildSessionDigest`, `readCompactSummaries`) are fine — but they run on dedicated endpoints, never in the list path.

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

`buildLoopInfoFromState(state)` resolves cron task ids on read and filters out cancelled crons. This keeps the cached state monotonic (append-only) — `CronDelete` doesn't mutate prior entries, it only adds to `deletedTaskIds`.

### Watcher warming

`projectsWatcher.on('all', …)` in `server.js` calls `refreshLoopInfoState(filePath)` on every `add`/`change` event. By the time the client refetches `/api/sessions` after the corresponding `metadata-update` SSE, the state cache is already current. Steady-state request cost: one `statSync` per session, no `readSync` at all.

`unlink` events delete the entry to bound memory.

### Substring fast-reject (still applies)

Each complete line is checked for `"tool_use_id"` / `"ScheduleWakeup"` / `"CronCreate"` / `"CronDelete"` substrings before `JSON.parse`. Lines that match none are skipped — the overwhelming majority of session content (user/assistant text, other tool calls) pays only a few `String.includes`.

### 5-min fired-grace filter

`filterActiveLoopInfo` (`server.js`) hides wakeups whose computed fire time is more than `WAKEUP_FIRED_GRACE_MS` (5 min) in the past. Applied at consumption sites only (`getLoopInfoSummary`, `/api/sessions/:id/loop`); the cached state stays immutable.

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

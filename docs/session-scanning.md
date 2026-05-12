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
| `loadSessionMetadata()` | `sessionMetadataCache` | `METADATA_CACHE_TTL = 10000` ms | `server.js:389` |
| Task-map scan | `sessionToTaskListCache` | `TASK_MAP_SCAN_TTL = 5000` ms | `server.js:271` |
| `readRecentMessages()` / session info | `messageCache` (keyed by mtime) | invalidates on file mtime change | `server.js:382` |
| `updateLoopInfo()` (ScheduleWakeup / Cron* scan) | `loopInfoStateByPath` (per-path incremental state) | warmed by `projectsWatcher` events; request path is O(1) on hit | `lib/parsers.js` + `server.js` |

A FS event from the matching watcher resets `lastMetadataRefresh = 0`, forcing the next call to rescan.

### 3. Periodic timers (cleanup only — not scanning)

| Timer | Interval | Purpose |
|---|---|---|
| `cleanupAgentActivity` | 60 min (`CLEANUP_INTERVAL_MS`) | prune old agent-activity files |
| `cleanupContextStatus` | 30 min | prune stale context-status files |
| SSE heartbeat | 30 s | keep-alive on `/api/events` |

No timer enumerates projects or sessions.

### 4. Client-side polling

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

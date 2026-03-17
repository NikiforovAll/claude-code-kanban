# Agent Log — Specification

## Overview

The Agent Log visualizes Claude Code subagent lifecycle events (start, stop, idle) in a collapsible footer panel below the Kanban board. It works for both regular subagent sessions and team sessions.

## Architecture

```
Claude Code spawns subagent
  → hook (SubagentStart/SubagentStop/TeammateIdle) fires
  → agent-spy.sh writes JSON to ~/.claude/agent-activity/{sessionId}/{agentId}.json
  → chokidar detects file change
  → server broadcasts SSE "agent-update" event
  → frontend fetches updated agent list via REST API
  → renders Agent Log footer
```

## Hook Events

### Available Claude Code hook events

| Event | Used | Purpose |
|-------|------|---------|
| `SubagentStart` | Yes | New subprocess spawned (Agent tool or team member) |
| `SubagentStop` | Yes | Subprocess exits |
| `TeammateIdle` | Yes | Team member waiting for work |
| `PermissionRequest` | Yes | Agent needs user permission |
| `PreToolUse` | Yes | Before tool execution (matched: AskUserQuestion) |
| `PostToolUse` | Yes | After tool execution (clears waiting state) |
| `SessionStart` | No | Session begins |
| `SessionEnd` | No | Session ends |
| `Stop` | No | Agent finishes responding |
| `TaskCompleted` | No | Task completes |
| `PreCompact` | No | Before context compaction |
| `Notification` | No | Notification sent |
| `WorktreeCreate` | No | Git worktree created |
| `WorktreeRemove` | No | Git worktree removed |

**Not available:** No `TeammateStart`, `TeammateStop`, or `SendMessage` hooks exist.

### Hook input fields by event

**Common fields (all events):** `session_id`, `cwd`, `hook_event_name`, `transcript_path`, `permission_mode`

| Event | Additional fields |
|-------|------------------|
| `SubagentStart` | `agent_id`, `agent_type` |
| `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active` |
| `TeammateIdle` | `teammate_name`, `team_name` (**no** `agent_id` or `agent_type`) |
| `PreToolUse` | `tool_name`, `tool_use_id`, `tool_input` |
| `PostToolUse` | `tool_name`, `tool_use_id`, `tool_input`, `tool_response` |
| `PermissionRequest` | `tool_name`, `tool_use_id`, `tool_input` |

Key discovery: `agent_transcript_path` (subagent's own JSONL path) is only available at `SubagentStop`, not `SubagentStart`.

## Hook: `~/.claude/hooks/agent-spy.sh`

Configured in `~/.claude/settings.json` for six events: `SubagentStart`, `SubagentStop`, `TeammateIdle`, `PermissionRequest`, `PreToolUse`, `PostToolUse`.

**File layout:** `~/.claude/agent-activity/{sessionId}/{agentId}.json` — one file per agent, grouped by session.

**SubagentStart:** Creates file with `status: "active"`. Skips internal agents (empty `agent_type`, e.g. AskUserQuestion). Also writes a name→ID mapping file `_name-{agent_type}.id` for TeammateIdle resolution. If the mapping pointed to a different ID, the old agent file is deleted **only if its status is not `active`** — this preserves parallel subagents of the same type while still deduplicating teammate re-spawns (which transition `active → idle → re-spawn`).

**SubagentStop:** Overwrites file with `status: "stopped"`, preserves `startedAt` from existing file, captures `last_assistant_message`. Falls back to reading `type` from existing file if `agent_type` is empty.

**TeammateIdle:** Has no `agent_id` — resolves it by reading the `_name-{teammate_name}.id` mapping file. Updates the agent file to `status: "idle"`, preserves `startedAt`.

### Name→ID mapping (teammate dedup vs parallel subagents)

Team members get a new `agent_id` each time they wake up (each `SendMessage` creates a new subprocess). To avoid duplicate agent entries while supporting parallel subagents:

1. `SubagentStart` writes `_name-{type}.id` containing the `agent_id`
2. If a mapping file already exists with a different ID, the old agent's status is checked:
   - **`active`** → old file is **kept** (parallel subagent of the same type, e.g. multiple Explore agents)
   - **`idle`/`stopped`/missing** → old file is **deleted** (teammate re-spawn)
3. `TeammateIdle` reads the mapping to find the correct agent file to update

**Why status-based:** Teammates transition `active → idle → re-spawn` — the old instance is always `idle` (not `active`) when the new one starts. Parallel subagents are `active` simultaneously.

### Agent JSON schema

```json
{
  "agentId": "a1b2c3...",
  "type": "general-purpose",
  "status": "active|idle|stopped",
  "startedAt": "2026-03-01T17:00:00Z",
  "updatedAt": "2026-03-01T17:00:30Z",
  "stoppedAt": "2026-03-01T17:00:30Z",
  "lastMessage": "Task completed. Summary: ..."
}
```

## Team member lifecycle

Team members differ from regular subagents — they persist across multiple interactions.

### Lifecycle events

```
Team lead spawns teammate (Agent tool with name param)
  → SubagentStart fires → agent file created (active) + mapping written
  → SubagentStop fires → agent file updated (stopped)
  → TeammateIdle fires → mapping lookup → agent file updated (idle)

Lead sends SendMessage to teammate
  → SubagentStart fires → NEW agent ID, old file deleted, new file created (active)
  → SubagentStop fires → agent file updated (stopped)
  → TeammateIdle fires → mapping lookup → agent file updated (idle)

Lead sends shutdown_request via SendMessage
  → SubagentStart fires → new subprocess for shutdown
  → Teammate approves → teammate_terminated in JSONL
  → Server detects termination → marks agent stopped
  → No SubagentStop hook fires for terminated teammates
```

### Key differences from regular subagents

| Aspect | Regular Subagent | Team Member |
|--------|-----------------|-------------|
| Created by | `Agent` tool call | Team framework (also fires SubagentStart) |
| Process lifetime | Single task, then exits | Persists across messages, goes idle between |
| New agent_id per wake | No | Yes (each SendMessage creates new subprocess) |
| Communication | Returns result to parent | SendMessage / `<teammate-message>` protocol |
| Idle state | N/A | Normal — waiting for work |
| Termination detection | SubagentStop hook | JSONL `teammate_terminated` protocol message |
| Stale timeout | Applied (force-stopped after 15min) | **Exempt** — idle is normal state |

### SendMessage does NOT spawn a process

When the lead uses `SendMessage`, **no new hook fires for the send itself**. The teammate's existing process receives the message. A new `SubagentStart` fires only when the teammate wakes up to process it.

### Stale filtering exemption

Team members are exempt from stale timeout. The server checks team config and skips force-stopping agents whose `type` matches a team member name. This prevents idle teammates from being incorrectly shown as stopped.

## Server (`server.js`)

### REST endpoints

`GET /api/sessions/:sessionId/agents` — returns agent objects + team colors. For team sessions, resolves `sessionId` to the leader's UUID via team config before reading files. Team members are exempt from stale timeout. Model extraction reads `obj.message.model` (or `obj.model`) from the subagent's JSONL transcript and persists it back to the agent file.

`GET /api/teams/:name` — returns team config including `configPath`.

### Team session detection

Team sessions are detected by scanning `TEAMS_DIR` (`~/.claude/teams/`) after building the sessions map. Each team config has a `leadSessionId` — the leader's UUID session is enriched with `isTeam: true`, `teamName`, and `memberCount`. The team-named duplicate session (created from the task directory `~/.claude/tasks/{teamName}/`) is removed from the response. The frontend uses `session.teamName` to fetch team config via `/api/teams/{teamName}`.

`GET /api/sessions/:sessionId/agents/:agentId/messages` — returns the subagent's own session log by reading `subagents/agent-{agentId}.jsonl`.

### File watcher

Watches `~/.claude/agent-activity/` (depth 2). On `add`/`change` of `.json` files:
1. Broadcasts `{ type: "agent-update", sessionId }` via SSE
2. For team sessions, also broadcasts with team name so frontend picks it up
3. On `add`: enforces file cap (20 files per session), deletes oldest by mtime

### File cap

`AGENT_FILE_CAP = 20` — when a new agent file is added and the session directory exceeds the cap, the oldest files (by modification time) are deleted. This prevents unbounded disk growth across long sessions.

## Frontend (`public/app.js`)

### Agent log button

The clock icon button appears on:
- `Agent` tool calls (links to subagent session log)
- `SendMessage` tool calls (resolves recipient name to agent via `currentAgents`)
- Teammate messages (idle, protocol, regular — resolves `teammateId` to agent)
- System `teammate_terminated` messages (extracts name from "X has shut down" message)

Clicking opens the agent's session log in the message panel via `viewAgentLog(agentId)`.

### Display

- Collapsible footer panel below the Kanban board
- Horizontal scrollable row of agent cards
- Each card shows: status dot (green=active, yellow=idle, gray=stopped), agent type, duration, truncated last message (60 chars + ellipsis)
- Clicking a card opens a modal with full details (status, ID, duration, timestamps, markdown-rendered last message)
- ESC closes modal
- Collapse state persisted in `localStorage` key `agentFooterCollapsed`
- Display cap: `AGENT_LOG_MAX = 8` most recent agents

### Ghost filtering

Shutdown handshake creates duplicate agent instances per worker. Three rounds:

| Round | Behavior | How filtered |
|-------|----------|-------------|
| Real worker | Runs task, stops with meaningful message | Kept |
| Shutdown recap | Same type, starts after original stops, has recap message | Temporal dedup |
| Shutdown approval | Same type, starts after recap, often no SubagentStop | Temporal dedup |

**Temporal dedup algorithm:** For same-type agents sorted by `startedAt`:
- If agent overlapped with previous (started before previous stopped) → keep (parallel real agents)
- If agent started >30s after previous stopped → keep (legitimate re-spawn)
- Otherwise → filter (shutdown ghost)

### SSE handler

Listens for `type: "agent-update"` events. If `sessionId` matches current session, triggers debounced `fetchAgents()` call.

### Poll interval (chokidar reliability workaround)

On Windows, chokidar's `add` events for new files are unreliable when multiple files are created in rapid succession (e.g., parallel agent spawning). The `change` event (file update) fires reliably.

**Symptom:** Only 1 of N parallel agents appears in the footer; the rest appear when any agent finishes (the `SubagentStop` rewrite triggers a `change` event which causes a re-fetch that discovers all agents).

**Fix:** `agentPollInterval` — a 3-second polling interval that re-fetches agents while any are active/idle. Runs alongside the 1-second `agentDurationInterval` (which only re-renders elapsed time from cached data). The poll stops when all agents are stopped or invisible. `fetchAgents()` uses `lastAgentsHash` to bail when data is unchanged, so the poll adds minimal overhead.

### Agent ID resolution for team members

Message `agentId` values for team members use the format `name@team` (e.g., `reuse-reviewer@code-review`), while agent-activity files use hex IDs (e.g., `aa5faea19f7e3202d`). `findAgentById()` resolves this by extracting the name before `@` and matching against `agent.type`.

### `<teammate-message>` wrapper stripping

Team member prompts are wrapped in `<teammate-message teammate_id="..." summary="...">` XML by the Claude Code team framework. `stripTeammateWrapper()` extracts the inner content for display in agent cards and the agent modal.

## Configuration constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `AGENT_FILE_CAP` | 20 | server.js | Max agent files per session on disk |
| `AGENT_LOG_MAX` | 8 | index.html | Max agents shown in footer |
| `AGENT_STALE_MS` | 900000 | server.js | Stale timeout (15 min); team members exempt |
| `AGENT_TTL_MS` | 3600000 | server.js | Agent freshness for session-level status checks; does NOT filter agents from detail endpoint |
| `AGENT_COOLDOWN_MS` | 180000 | index.html | Cooldown period constant (3 min) |

## Known limitations

- **chokidar `add` unreliable on Windows** — file creation events are dropped when multiple agents spawn in parallel. Mitigated by 3s poll interval.
- `SubagentStop` is intermittently unreliable — may not fire for some agents. Mitigated by stale timeout.
- `SubagentStop` does not fire for terminated teammates. Mitigated by server-side JSONL `teammate_terminated` detection.
- Shutdown handshake spawns transient agent instances that never receive `SubagentStop`. Mitigated by temporal dedup filter + hook-level dedup for team members.
- Hook `SubagentStart` does not provide agent prompt/description — only `agent_type` is available for identification. Prompt is extracted from the parent session's JSONL transcript (progress map) or the subagent's own transcript.
- Hook `SubagentStart` does not provide `teammate_name` — cannot distinguish teammates from parallel subagents by field alone. Resolved by checking old agent's status (`active` = parallel, `idle`/`stopped` = re-spawn).
- `TeammateIdle` provides no `agent_id` — resolved via name→ID mapping files written on `SubagentStart`.
- Internal agents (e.g. AskUserQuestion) have empty `agent_type` and are excluded.
- `agent_transcript_path` is only available at `SubagentStop`, not `SubagentStart`.
- Team member prompts contain `<teammate-message>` XML wrapper that must be stripped for display.

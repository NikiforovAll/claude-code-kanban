# Agent Log — Specification

## Overview

The Agent Log visualizes Claude Code subagent lifecycle events (start, stop, idle) in a collapsible footer panel below the Kanban board. It works for both regular subagent sessions and team sessions.

## Architecture

```
Claude Code spawns subagent
  → mod event (agent.spawn / turn.complete / classic.TeammateIdle) fires
  → the plugin's mod (hooks/activity.ts) appends a line to <config-dir>/.cck/agent-activity/{sessionId}/{agentId}.jsonl
  → chokidar detects file change
  → server broadcasts SSE "agent-update" event
  → frontend fetches updated agent list via REST API
  → renders Agent Log footer
```

## Mod: `hooks/activity.ts`

The plugin's mod uses native mod events. It does not use `classic.*` where a native event exists, because on a machine with managed settings Claude Code's `cc-plugin-sec-default` skips user-tier mods on those events.

| Mod event | What the mod writes |
|---|---|
| `session.start` | maps the session to `CLAUDE_CODE_TASK_LIST_ID` in `_task-maps/` |
| `agent.spawn` (after the agent starts, for its `agentId`) | a `start` line with `status: "active"`, and the `_name-{name or type}.id` map |
| `turn.complete` with an `agentId` | a `stop` line with `status: "stopped"`, only when the agent file exists (internal agents have none) |
| `turn.complete` without one, not interrupted | the `_stop.json` unread marker |
| `classic.TeammateIdle` | an `idle` line; it has no native event, so it does nothing under managed settings |
| `tool.check` / `tool.call` | the `_waiting.json` marker and the board decision, see [ui-approvals.md](ui-approvals.md) |

`turn.complete` gives an empty `answer` for a subagent, so the stop line has an empty `lastMessage`, and the server takes the last assistant text from the subagent's transcript (`extractAgentResultFromTranscript`).

**File layout:** `<config-dir>/.cck/agent-activity/{sessionId}/{agentId}.jsonl` — one append-only file per agent, grouped by session. Each line is one lifecycle event; the server folds them last-key-wins, so a line leaves out a field it does not know (a stop line has no `type` or `startedAt`).

**TeammateIdle:** It may have no `agent_id`. The mod then reads the `_name-{teammate_name}.id` map, and writes the line only when that agent file exists.

### Name→ID mapping

Team members get a new `agent_id` each time they wake up (each `SendMessage` creates a new subprocess).

1. `agent.spawn` writes `_name-{name or type}.id` containing the latest agent id
2. `TeammateIdle` reads the mapping to find the agent file to update

The mod cannot delete files, so each re-spawn leaves its earlier agent file in place.

### Agent file lines

Each line is one event. The server folds them in order, last key wins:

```jsonl
{"agentId":"a1b2c3","type":"general-purpose","event":"start","status":"active","startedAt":"2026-03-01T17:00:00Z","updatedAt":"2026-03-01T17:00:00Z"}
{"agentId":"a1b2c3","event":"stop","status":"stopped","stoppedAt":"2026-03-01T17:00:30Z","updatedAt":"2026-03-01T17:00:30Z"}
```

The folded agent also gets `lastMessage`, from the transcript when the stop line has none.

## Team member lifecycle

Team members differ from regular subagents — they persist across multiple interactions.

### Lifecycle events

```
Team lead spawns teammate (Agent tool with name param)
  → agent.spawn → agent file created (active) + mapping written
  → turn.complete → stop line (stopped)
  → TeammateIdle → mapping lookup → idle line

Lead sends SendMessage to teammate
  → agent.spawn → NEW agent ID, new file created (active); the old file stays
  → turn.complete → stop line (stopped)
  → TeammateIdle → mapping lookup → idle line

Lead sends shutdown_request via SendMessage
  → agent.spawn → new subprocess for shutdown
  → Teammate approves → teammate_terminated in JSONL
  → Server detects termination → marks agent stopped
  → No stop line is written for terminated teammates
```

### Key differences from regular subagents

| Aspect | Regular Subagent | Team Member |
|--------|-----------------|-------------|
| Created by | `Agent` tool call | Team framework (also fires agent.spawn) |
| Process lifetime | Single task, then exits | Persists across messages, goes idle between |
| New agent_id per wake | No | Yes (each SendMessage creates new subprocess) |
| Communication | Returns result to parent | SendMessage / `<teammate-message>` protocol |
| Idle state | N/A | Normal — waiting for work |
| Termination detection | turn.complete stop line | JSONL `teammate_terminated` protocol message |
| Stale timeout | Applied (force-stopped after 15min) | **Exempt** — idle is normal state |

### SendMessage does NOT spawn a process

When the lead uses `SendMessage`, **no event fires for the send itself**. The teammate's existing process receives the message. A new `agent.spawn` fires only when the teammate wakes up to process it.

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

Watches `<config-dir>/.cck/agent-activity/` (depth 2). On `add`/`change`/`unlink` of a `.jsonl` file, `_waiting.json` or `_stop.json`:
1. Broadcasts `{ type: "agent-update", sessionId }` via SSE
2. For team sessions, also broadcasts with team name so frontend picks it up
3. On `add` of a `.jsonl` file: enforces file cap (20 files per session), deletes oldest by mtime

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
- A stop line may be missing for some agents. Mitigated by stale timeout.
- No stop line is written for terminated teammates. Mitigated by server-side JSONL `teammate_terminated` detection.
- Shutdown handshake spawns transient agent instances that never get a stop line. Mitigated by temporal dedup filter.
- The start line carries only the agent type, not the prompt. Prompt is extracted from the parent session's JSONL transcript (progress map) or the subagent's own transcript.
- `TeammateIdle` may provide no `agent_id` — resolved via name→ID mapping files written on `agent.spawn`.
- Internal agents (e.g. AskUserQuestion) get no file: `agent.spawn` does not fire for them, and the stop line is written only when the file exists.
- Team member prompts contain `<teammate-message>` XML wrapper that must be stripped for display.

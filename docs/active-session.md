# Active Session Definition

The **"Active Only"** filter in the session sidebar determines which sessions are considered active and worth showing. A session is active if **any** of the following conditions are true:

## Conditions

### 1. Has pending tasks
The session has one or more tasks with status `pending`.

### 2. Has in-progress tasks
The session has one or more tasks with status `in_progress`.

### 3. Has active agents
The session has at least one subagent with `active` or `idle` status in its agent-activity JSON. We trust the actual data written by Claude Code — no artificial staleness timeout. For team sessions, agents are resolved via the team leader's session ID.

### 4. Has a recent plan
The session has an associated plan file **and** was last modified within the last **15 minutes**. Plans alone don't keep a session active indefinitely — once activity stops, the session fades from the active list.

### 5. Recently modified
The session was last modified within the last **5 minutes**, regardless of task/agent/plan state. This catches sessions with recent activity that may not yet have tasks or agents visible.

### 6. Waiting for user input
The session has a fresh `_waiting.json` marker (< 120s old) in its agent-activity directory. This covers both permission prompts (`PermissionRequest`) and user questions (`AskUserQuestion`). These sessions need attention even if they have no tasks or agents.

## Design Principles

- **Tasks and agents are always-on signals** — if work is happening, the session is active regardless of age.
- **Waiting for user is an always-on signal** — permission prompts and questions require attention regardless of age (within the 120s TTL).
- **Plans are time-gated** — a plan file persists on disk indefinitely, so we use recency to avoid showing stale sessions.
- **Recency as a catch-all** — the 5-minute window ensures any recently touched session stays visible briefly.
- **Trust the source data** — agent status comes directly from the JSON files Claude Code writes. No client-side staleness override.

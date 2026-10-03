# Session states

How the board decides what state a session is in, and how the sidebar card and the session picker draw each state. The server computes the signals; the client maps them to the Active filter, the card classes and the dots.

Change a signal, a window, the filter or a drawn state, and update this doc in the same change.

## Signals

The server builds these fields on every session object (`buildSessionObject` and the agent pass in `/api/sessions`, `server.js`).

| Field | True when | Window |
|---|---|---|
| `hasMessages` | The transcript is larger than 1000 bytes. A session without messages is never active. | none |
| `pending`, `inProgress` | Counts of tasks with that status. | none |
| `hasRecentLog` | The transcript was written in the window **and** the live-session registry does not mark the session `idle`. See [session-scanning.md §3b](session-scanning.md#3b-cheap-probe-on-filteractive). | `SESSION_STALE_MS`, 5 min |
| `hasRecentActivity` | The transcript was written in the grace window, or `hasRecentLog`. The grace window ignores registry-idle, so a session stays listed for 2 min after its turn ends. | `SESSION_GRACE_MS`, 2 min |
| `hasRunningAgents` | A subagent has `status: 'active'` and is fresh (teams skip the freshness check). Idle agents never count. | `AGENT_TTL_MS`, 60 min |
| `hasWaitingForUser` | A `_waiting.json` marker exists (permission prompt or question), and the transcript did not move on after it. | `PERMISSION_TTL_MS`, 30 min; resolved when the log is written more than `WAITING_RESOLVE_GRACE_MS` (15 s) after the marker |
| `hasActiveAgents` | `hasRunningAgents` or `hasWaitingForUser`. | as above |
| `unread` | A `_stop.json` marker exists (the plugin's mod writes it when a main turn completes; opening the session deletes it), and the transcript did not move on after it. | resolved when the log is written more than `WAITING_RESOLVE_GRACE_MS` (15 s) after the marker |

When the transcript is older than `AGENT_STALE_MS` (30 min), the server skips the agent check for a non-team session. The waiting check still runs.

The client adds one more signal. `isSessionLive` (`public/app.js`) is `hasRecentLog` with a transcript write in the last `LIVE_INDICATOR_MS` (10 s).

## Active filter

A session is in the **Active** list when it has messages and at least one of these is true:

- open tasks: `pending > 0` or `inProgress > 0`, unless the task list is shared (`sharedTaskList`);
- `hasActiveAgents`;
- `hasWaitingForUser`;
- `hasRecentActivity`.

The server applies this rule on `?filter=active` (`/api/sessions`), and the client applies it again in `getFilteredSessions`. On both sides, some sessions skip the rule:

- pinned and sticky sessions, and the open session;
- sessions with a terminal running in the board.

The client also hides a session the user dismissed, for `DISMISS_TTL_MS` (24 h).

The 24h project filter is a separate filter. It keeps sessions of projects with any transcript written in the last 24 h. Pinned and sticky sessions skip it. An explicit project filter still hides them.

## Drawn states

The client maps the signals to one state per session. The order matters: the first match wins.

| State | Rule (client) | Sidebar card | Picker dot |
|---|---|---|---|
| Waiting | `hasWaitingForUser` | `warm permission-pending`: yellow time and dot, waiting badge | `waiting`: yellow, filled |
| Live | `isSessionLive` | `warm`: green time and dot, pulse | `live`: green, filled |
| Working | `hasRecentLog` or `hasRunningAgents` (`isActiveSession`) | `warm`: green time and dot; agent badge and pulse when agents run | `active`: accent, filled |
| Just finished | `hasRecentActivity` and a transcript write in the last `JUST_NOW_MS` (1 min), nothing above (`isJustFinished`) | `warm idle just-finished`: soft green time and dot | `justFinished`: soft green, filled |
| Recently active, idle | `hasRecentActivity` or `inProgress > 0`, nothing above | `warm idle`: gray time and filled gray dot | `recent`: gray, filled |
| Inactive | none of the above | `stale`: muted time, hollow ring, card at 0.85 opacity | `idle`: hollow ring |

A stale card returns to full opacity on hover, when it is the open session, when the keyboard selects it, or when it is sticky.

The sidebar computes `warm`/`stale` and `idle` in `renderSessions` (`tempClass`, `idleClass`). The picker picks the state in `spState` and draws it with `spDotHtml`: a 14px `.sp-state` slot from `SP_STATES` sets the state color, and holds a dot, or the terminal glyph for a session with a terminal running in the board (`runningTerminals`). The slot keeps the names aligned. Rerenders go through `renderSessionViews`, which redraws the sidebar and the open picker.

Soft green is `--success-faded`, `color-mix(in srgb, var(--success) 35%, var(--text-muted))`, declared on the just-finished elements so it follows the theme's `--success`. It stays apart from the Working green in both themes.

The 1 min mark is a client-side boundary. No server update arrives when a session crosses it, and `fetchSessions` redraws only when the data changes. So `renderSessions` calls `scheduleJustFinishedExpiry`, which sets one timer for the next session to leave the Just finished state and redraws the sidebar, and the picker when it is open.

`formatDate` matches these steps: "just now" under `JUST_NOW_MS`, then "Nm ago".

The sidebar's `warm` rule does not include `hasRunningAgents`. A session whose subagents run longer than 5 min with no write to the main transcript draws as `stale` in the sidebar, with the agent badge and pulse on it, while the picker shows it as Working.

The activity chips above the sidebar use `ACTIVITY_PREDICATES`: `waiting` counts `isWaitingSession`, `active` counts `isActiveSession` (Live and Working), and `terminal` counts sessions with a terminal running in the board. Just finished and Recently active, idle sessions are in no chip.

## Constants

| Constant | Value | File |
|---|---|---|
| `SESSION_GRACE_MS` | 2 min | `server.js` |
| `SESSION_STALE_MS` | 5 min | `server.js` |
| `AGENT_STALE_MS` | 30 min | `server.js` |
| `AGENT_TTL_MS` | 60 min | `server.js` |
| `PERMISSION_TTL_MS` | 30 min | `server.js` |
| `WAITING_RESOLVE_GRACE_MS` | 15 s | `server.js` |
| `LIVE_INDICATOR_MS` | 10 s | `public/app.js` |
| `JUST_NOW_MS` | 1 min | `public/app.js` |
| `RECENT_PROJECT_HOURS` | 24 h | `public/app.js` |
| `DISMISS_TTL_MS` | 24 h | `public/app.js` |

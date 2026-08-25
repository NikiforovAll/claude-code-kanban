# UI Approvals

Answer a Claude Code permission ask or `AskUserQuestion` from the board instead of the terminal. The waiting card grows Allow / Deny buttons (or an answer form for questions); clicking one resolves the prompt in the live session, for any session the board can see — cck does not need to have spawned it.

Off by default. Nothing changes until you opt in.

## Enable

Create `~/.claude/.cck/approvals.json`:

```json
{
  "enabled": true,
  "mode": "permission",
  "waitSeconds": 60
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. Absent, `false`, or unparseable config = feature off, today's behavior |
| `mode` | `"permission"` | `"permission"` gates only permission asks; `"permission+question"` also gates `AskUserQuestion` |
| `waitSeconds` | `30` | How long the hook holds the ask open for a board decision. Capped at `1800` (30 min, `PERMISSION_TTL_MS` — the board hides the card after that anyway) |

## How it works

The plugin's `approval-gate.sh` runs on `PermissionRequest` — for regular permission asks, `AskUserQuestion`, and `ExitPlanMode` plan approval alike. Questions and plans deliberately ride `PermissionRequest` rather than `PreToolUse`: the TUI question and plan dialogs render while a `PermissionRequest` hook blocks, so both surfaces stay live, whereas a blocking `PreToolUse` hook freezes the dialog for the whole wait. It always writes the `_waiting.json` marker first — the amber badge works exactly as before, enabled or not. Then, only when the config enables it **and** the board's server answers a TCP probe on the port in `~/.claude/.cck/server.json`, the hook waits up to `waitSeconds`, polling for a decision file the server writes when you click Allow / Deny / Answer.

```
hook ──> _waiting.json (marker, id) ──> board shows card with buttons
board ──> POST /api/sessions/:sid/waiting/respond ──> _decision-<id>.json
hook ──> consumes decision, deletes both files, returns it to Claude Code
```

## Precedence — first writer wins

The terminal prompt stays fully live while the hook waits. Whichever side answers first wins:

- **Terminal answers first** — the tool runs (or is denied) immediately; the marker is cleared and the waiting gate exits silently. A board click after that returns 410 and just drops the card.
- **Board answers first** — Claude Code applies the decision (the transcript shows "Allowed/Denied by PermissionRequest hook", with your deny message verbatim).
- **Nobody answers within `waitSeconds`** — the gate gives up (exit 0) and everything proceeds exactly as if the feature were off: the terminal prompt remains, the badge stays until answered or expired.

A newer ask from the same session displaces the older one (the marker's `id` changes); the older gate exits and its card is replaced.

## Fail-open by design

Every failure path degrades to today's behavior — the hook never blocks a session on a broken board:

- no config / `enabled: false` / corrupt config → no wait
- no `server.json` / board not listening on its port → no wait
- corrupt or empty decision file → no wait
- `waitSeconds` elapsed → no wait

## Scope

- **In:** permission asks (allow / deny with optional message), `AskUserQuestion` (single- and multi-select answers keyed by question text, plus free-text), and `ExitPlanMode` plan approval — the plan card opens the plan modal with Approve / Reject (optional feedback), and inline row buttons offer the quick path. An approve echoes `tool_input` back as `updatedInput` (required — Claude Code silently drops an ExitPlanMode allow without it); a reject sends the feedback as the deny message.
- **Coexistence:** plan-review tools like plannotator also gate `ExitPlanMode` on `PermissionRequest`. Multiple blocking hooks are safe — the first decision wins and the others are orphaned (measured), same as the terminal-vs-board race.

## Files

All under `~/.claude/.cck/`:

| Path | Writer | Purpose |
|---|---|---|
| `approvals.json` | you | opt-in config |
| `server.json` | board server | `{port, pid}` liveness beacon |
| `agent-activity/<sid>/_waiting.json` | hook | the pending ask (kind, id, tool, input, suggestions) |
| `agent-activity/<sid>/_decision-<id>.json` | board server | your answer; consumed and deleted by the hook |

Orphaned decision files (a click that lost the race) are swept by the server after 30 minutes.

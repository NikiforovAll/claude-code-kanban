# UI Approvals

Answer a Claude Code permission ask or `AskUserQuestion` from the board instead of the terminal. The waiting card grows Allow / Deny buttons (or an answer form for questions); clicking one resolves the prompt in the live session, for any session the board can see — cck does not need to have spawned it.

On by default. The terminal prompt stays live the whole time, so nothing is lost if you never click.

## Configure

Settings live in the `approvals` section of `<config-dir>/.cck/config.json`, where `<config-dir>` is `CLAUDE_CONFIG_DIR` (or `~/.claude`). Each Claude config dir has its own file. Create it only to opt out or to tune:

```json
{
  "approvals": {
    "enabled": false
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. Only an explicit `false` turns the feature off; a missing or unparseable file means defaults |
| `mode` | `"permission+question"` | `"permission+question"` gates permission asks, plans, and `AskUserQuestion`; `"permission"` leaves questions to the terminal |
| `waitSeconds` | `1800` | How long the hook holds the ask open for a board decision. Capped at `1800` (30 min, `PERMISSION_TTL_MS` — the board hides the card after that anyway) |

When a kind is not gated (opted out, or a question in `"permission"` mode), the board shows the waiting card without buttons and says "answer in the terminal", so a click can never pretend to work.

A pre-existing `approvals.json` (the old opt-in file) is folded into `config.json` and removed the next time the server starts.

## How it works

The plugin's `approval-gate.sh` runs on `PermissionRequest` — for regular permission asks, `AskUserQuestion`, and `ExitPlanMode` plan approval alike. Questions and plans deliberately ride `PermissionRequest` rather than `PreToolUse`: the TUI question and plan dialogs render while a `PermissionRequest` hook blocks, so both surfaces stay live, whereas a blocking `PreToolUse` hook freezes the dialog for the whole wait. It always writes the `_waiting.json` marker first — the amber badge works exactly as before, enabled or not. Then, unless the config opts out, and only while the board's server answers a TCP probe on the port in `<config-dir>/.cck/server.json`, the hook waits up to `waitSeconds`, polling for a decision file the server writes when you click Allow / Deny / Answer.

```
hook ──> _waiting.json (marker, id) ──> board shows card with buttons
board ──> POST /api/sessions/:sid/waiting/respond ──> _decision-<id>.json
hook ──> consumes decision, deletes both files, returns it to Claude Code
```

## Auto-open

A new answerable ask in the selected session opens the waiting modal by itself, in follow mode. It does not open when any modal is already visible — you are reading something, so the ask stays on the card and the sidebar badge until you get to it. Each ask opens once: closing the modal does not bring it back on the next poll, and a newer ask (new `id`) opens again.

## Precedence — first writer wins

The terminal prompt stays fully live while the hook waits. Whichever side answers first wins:

- **Terminal answers first** — the tool runs (or is denied) immediately; the marker is cleared and the waiting gate exits silently. A board click after that returns 410 and just drops the card.
- **Board answers first** — Claude Code applies the decision (the transcript shows "Allowed/Denied by PermissionRequest hook", with your deny message verbatim).
- **Nobody answers within `waitSeconds`** — the gate gives up (exit 0) and everything proceeds exactly as if the feature were off: the terminal prompt remains, the badge stays until answered or expired.

A newer ask from the same session displaces the older one (the marker's `id` changes); the older gate exits and its card is replaced.

## Fail-open by design

Every failure path degrades to today's behavior — the hook never blocks a session on a broken board:

- `enabled: false`, or a question in `"permission"` mode → no wait
- no `server.json` → no wait
- corrupt or empty decision file → no wait
- `waitSeconds` elapsed → no wait

A `server.json` whose port is closed is the one case that is not immediate: the server deletes its own beacon on the way out, so a beacon that outlives its port means the board is restarting — under the hub every sub-app binds an ephemeral port, so it comes back on a different one. The gate re-reads the beacon and re-probes every 5 s and gives up only after 15 s of an unreachable board.

## Scope

- **In:** permission asks (allow / deny with optional message), `AskUserQuestion` (single- and multi-select answers keyed by question text, plus free-text), and `ExitPlanMode` plan approval — the plan card opens the plan modal with Approve / Reject (optional feedback), and inline row buttons offer the quick path. An approve echoes `tool_input` back as `updatedInput` (required — Claude Code silently drops an ExitPlanMode allow without it); a reject sends the feedback as the deny message.
- **Coexistence:** plan-review tools like plannotator also gate `ExitPlanMode` on `PermissionRequest`. Multiple blocking hooks are safe — the first decision wins and the others are orphaned (measured), same as the terminal-vs-board race.

## Files

All under `<config-dir>/.cck/`:

| Path | Writer | Purpose |
|---|---|---|
| `config.json` | you | cck settings; the `approvals` section holds the opt-out and tuning |
| `server.json` | board server | `{port, pid}` liveness beacon; written on start, removed on exit when the pid is still the server's own |
| `agent-activity/<sid>/_waiting.json` | hook | the pending ask (kind, id, tool, input, suggestions) |
| `agent-activity/<sid>/_decision-<id>.json` | board server | your answer; consumed and deleted by the hook |

Orphaned decision files (a click that lost the race) are swept by the server after 30 minutes.

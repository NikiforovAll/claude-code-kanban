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
| `waitSeconds` | `1800` | How long the mod holds the ask open for a board decision. Capped at `1800` (30 min, `PERMISSION_TTL_MS` — the board hides the card after that anyway) |

When a kind is not gated (opted out, or a question in `"permission"` mode), the board shows the waiting card without buttons and says "answer in the terminal", so a click can never pretend to work.

A pre-existing `approvals.json` (the old opt-in file) is folded into `config.json` and removed the next time the server starts.

## How it works

The plugin's mod (`hooks/activity.ts`) does the work in two hooks, for permission asks, `AskUserQuestion` and `ExitPlanMode` plan approval alike:

- `tool.check` sees the permission verdict. On `ask` it writes the `_waiting.json` marker, so the amber badge works whether the feature is on or off.
- `tool.call` holds the call. While the terminal prompt is open, and unless the config opts out, it polls every 500 ms, for up to `waitSeconds`, for a decision file the server writes when you click Allow / Deny / Answer.

```
mod ──> _waiting.json (marker, id) ──> board shows card with buttons
board ──> POST /api/sessions/:sid/waiting/respond ──> _decision-<id>.json
mod ──> reads the decision, clears the marker, answers the call
```

The mod answers the call itself. Only a hook that returns closes the terminal prompt, so:

- **Allow** runs the tool again through `$.tool.call`, with the board's `updatedInput` merged in. Its `tool.check` is allowed once. While it runs, the status line shows "Approved from the board — running".
- **Deny** returns the deny message, or "Denied from the board".
- **Answer** returns the answers as the `AskUserQuestion` result.

The mod does not check that a board is running. Polling a missing file costs nothing, and the terminal prompt stays live.

### Auto mode

In auto mode, `tool.check` says `ask` before the classifier decides, and most of those asks never open a dialog. The mod cannot tell: no mod API gives the live permission mode or says when a dialog opens, and `classic.PermissionRequest` does not reach user mods under managed settings. So the server drops a permission marker when the session's latest mode in the transcript is `auto` (`readSessionInfoFromJsonl`, read incrementally). The mode comes from the last prompt line, an `auto_mode` / `auto_mode_exit` attachment (written with the first tool result after a Shift+Tab), or a `permission-mode` line (rewritten with the live mode, often tens of seconds later). Questions and plans still show.

An ask from a settings `ask` rule always opens the dialog, in auto mode too. `tool.check` names that rule, and the mod writes it to the marker as `rule`, so the server keeps those asks. A dialog that the classifier itself falls back to shows only in the terminal.

## Auto-open

A new answerable ask in the selected session opens the waiting modal by itself, in follow mode. It does not open when any modal is already visible — you are reading something, so the ask stays on the card and the sidebar badge until you get to it. Each ask opens once: closing the modal does not bring it back on the next poll, and a newer ask (new `id`) opens again.

## Precedence — first writer wins

The terminal prompt stays fully live while the mod waits. Whichever side answers first wins:

- **Terminal answers first.** The tool runs (or is denied), the mod stops polling and clears the marker, and the card drops. This holds for allow and deny alike. A board click after that returns 410 and just drops the card.
- **Board answers first.** The mod answers the call as described above.
- **Nobody answers within `waitSeconds`.** The mod stops polling, and the call goes on as if the feature were off: the terminal prompt stays, and the badge stays until the prompt is answered or expires.

A newer ask from the same session (a parallel call) displaces the older one: the marker's `id` changes, and the older call leaves the newer marker in place when it ends.

### Accepted risk: a double run

A board allow runs the tool a second time, while the original prompt is still on screen. The prompt closes only when that run ends. If you choose "Yes" in the terminal during that run, the original call runs too, so the tool runs twice. This was measured: `echo run >> file && sleep 15` wrote two lines.

This needs both answers for one ask within the run's duration. The status line note ("Approved from the board — running") tells you not to answer the terminal. The risk is accepted because no mod API closes the prompt without the hook returning.

## Fail-open by design

Every failure path leaves the ask to the terminal. The mod never blocks a session on a broken board:

- `enabled: false`, or a question in `"permission"` mode → no wait
- no board, or a board that never answers → the terminal prompt, as if the feature were off
- a decision file that does not parse → read again on the next poll
- `waitSeconds` elapsed → no wait

## Scope

- **In:** permission asks (allow / deny with optional message), `AskUserQuestion` (single- and multi-select answers keyed by question text, plus free-text), and `ExitPlanMode` plan approval — the plan card opens the plan modal with Approve / Reject (optional feedback), and inline row buttons offer the quick path. A reject sends the feedback as the deny message.
- **Out:** "always allow" rules. Mods cannot add permission rules, and `tool.check` gives no permission suggestions.
- **Plan approval** leaves plan mode for the default mode, which asks before each edit. The terminal dialog's other choices (auto-accept edits) are terminal only.
- **Managed settings:** `tool.check` and `tool.call` are native mod events, so the gate works under managed settings, where user-tier mods are skipped on `classic.*` events.

## Files

All under `<config-dir>/.cck/`:

| Path | Writer | Purpose |
|---|---|---|
| `config.json` | you | cck settings; the `approvals` section holds the opt-out and tuning, and `boardEvents` the doorbell's off switch |
| `agent-activity/<sid>/_waiting.json` | mod | the pending ask (kind, id, tool, input, the settings rule that asked); `{"status":"cleared"}` once it is over |
| `agent-activity/<sid>/_decision-<id>.json` | board server | your answer; read by the mod |

Mods cannot delete files, so the server sweeps decision files after 30 minutes.

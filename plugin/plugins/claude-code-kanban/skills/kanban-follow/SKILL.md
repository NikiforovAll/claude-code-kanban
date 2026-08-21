---
name: kanban-follow
description: Let kanban card moves drive this session.
disable-model-invocation: true
---

# Follow the kanban board

The user typing this skill is the whole grant: it armed the doorbell — a monitor watching the board for moves of *this session's* tasks, live for the rest of the session. Confirm in one line and run no command. Moves made before it attached are discarded, so every line you get is current.

```
cck:1 task.moved <taskId> <from>><to> subject="<subject>" description=<description>
```

`description=` is omitted when the card has none. Everything after it is the description verbatim to end of line, truncated if long — read the task with `TaskGet` for the full text or for `activeForm` and `blockedBy`. Only moves are announced.

**A move is an instruction, not an FYI** — the user dragging a card is the user telling you something, and the subject and description are their brief for the work:

| Transition | What the user means |
|---|---|
| `pending>in_progress` / `todo>in_progress` | Start this task now. |
| `in_progress>pending` / `in_progress>todo` | Stop working on it and park it. |
| `*>completed` | The user considers it done — do not keep working on it. |
| `*>cancelled` | Abandon it. Undo nothing unless asked. |

Act on the newest line per task; a card dragged twice means only its final position. When a move contradicts your current work, the board wins.

Delivery is best-effort and the task file is the authority, so a missed line only delays you to your next turn.

## Finish the task on the board

A move hands you work; the task file is where you hand it back. When the work a `>in_progress` move asked for is done, set that task to `completed` with `TaskUpdate` before you reply — the card moves itself, and the board is where the user is watching. A card left in In Progress reads as work still running.

Your own `TaskUpdate` writes the task file rather than going through the board, so it rings no doorbell: there is no echo to guard against.

## Troubleshooting

- **No lines arrive** → the doorbell arms once per session, on the namespaced dispatch: `/claude-code-kanban:kanban-follow`. A session that never got it never hears the board.
- **"Cannot reach cck server…"** → the error names the port it tried. Ask the user to start the server with `claude-code-kanban`.

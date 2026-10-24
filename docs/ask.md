# Ask

The ask modal is a question over the embedded terminal. The Claude Code session in that terminal opens it with the plugin's `ask` tool, and the tool call waits until the user answers. The answer is the tool result. It is the HTML counterpart of AskUserQuestion: the card can be a form, a quiz sheet, a set of sliders or a whole playground, and its scripts run.

## Parts

| Part | Where | Job |
|---|---|---|
| Mod | `plugin/.../hooks/ask.ts` | Registers the `ask` tool, opens the question, long-polls for the answer |
| Skill | `plugin/.../skills/ask/` | How the agent writes the card and sends the answer; `references/playground.md` for a playground |
| Store and routes | `lib/ask.js` | One open question per terminal, in memory, `/api/terminals/:terminalId/ask` |
| Modal | `public/app.js` and `public/style.css`, region `ASK` | Renders the question of the terminal on screen, and the chip that reopens it |

## Flow

```
terminal  ptyEnv sets CCK_URL and CCK_TERMINAL_ID (lib/terminal.js)
mod       session.start registers ask, only when both vars are set and the session is interactive
model     ask {title, file, size?}   file: an HTML fragment in the scratchpad
mod       POST /api/terminals/<tid>/ask {sessionId, title, file, size} -> {id}
cck       ask:opened to the board
board     GET /api/terminals/<tid>/ask -> {ask: {id, title, size, content, ...}}, opens the modal
mod       GET .../ask/<id>/wait?ms=20000, again on {status: 'pending'}
board     POST .../ask/<id> {status: 'answered', data} or {status: 'dismissed'}
cck       settles the wait, ask:closed to the board
mod       tool result: the data as JSON, or a line that says the user skipped
```

- POST, the wait and DELETE need the terminal token and a live terminal with that id. The GET of the question needs neither, because the board reads it.
- The card must be an HTML file. `size` is `md` (560 px), `lg` (960 px, the default) or `full` (the whole terminal).
- Nothing is on disk: a question lives as long as the board and its terminal.

## Waiting

A tool.call hook has a budget of 10 s of its own time, but time spent in `$.http.fetch` does not count. `$.http.fetch` gives up at 30 s, so the mod loops 20 s long-polls (the server caps one at 25 s) until the answer comes. The call can take minutes.

- An answer that lands between two polls is kept for 60 s, so the next poll gets it.
- An interrupt aborts `next.signal`: the mod sends `DELETE .../ask/<id>`, the question ends as `cancelled`, the board closes the modal and shows a toast.
- A new question on the same terminal replaces the open one. The old call ends with "was replaced by a newer question".
- A terminal that ends settles its question as dismissed. An unknown id answers `gone`.

## The modal

- The card renders in the show card's sandbox (`allow-scripts allow-forms`, `connect-src 'none'`), with the same theme tokens. The ask skill holds the card's HTML contract.
- Two ways to answer:
  - `<form data-cck-submit="name">` or `<button data-cck-action="name">`, through `reviewBridge`. The data is `{action, label, fields}`.
  - `cck.send(data)` from the card's script, for any JSON value. `askBridge` defines `window.cck` in the head, ahead of the card's scripts.
- Both need transient user activation, the same as a card action: a script cannot answer on its own.
- ✕, Esc or a click outside the box only hides the modal. The frame stays, so a half-filled card comes back as it was. A pulsing chip next to the show chip reopens it.
- Skip ends the question as dismissed.
- Switching to another terminal drops the frame. Coming back loads the question again, without what was typed.

## Performance

Nothing runs at startup or while no question is open. An open question costs one held connection per 20 s poll on the server, one file read per board GET, and one GET per `ask:opened` on the board.

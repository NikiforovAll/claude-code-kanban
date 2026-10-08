# Sequence

For requests and replies between actors over time: an API call path, an auth flow, an incident replay.

- Actors are boxes in one row at the top; at most 4 on a card (about 100 units apart in a 440 viewBox). A fifth actor makes the labels too small.
- Lifelines: dashed vertical lines in `--color-text-muted` under each actor. Time runs down.
- Messages are horizontal arrows, labeled above the line:

| Kind | Line | Head |
|---|---|---|
| Call | solid, muted | filled |
| Return | dashed, muted | filled |
| Async, fire and forget | dashed, muted | open (a `polyline`, no fill) |
| The one result that matters | solid, accent | filled, accent |

- A self-call is a short U loop on the same lifeline, label on its right.
- An activation bar (8 units wide, `--color-bg-subtle`, hairline) shows who holds control, only when that matters.
- A branch goes in one frame: a rect over the lifelines it spans, with a tab at its top left (`ALT`, `OPT`, `LOOP`) in mono and the guard (`[token valid]`) under it. `ALT` splits its regions with a dashed line. At most one frame, no nesting.
- At most 12 messages. Past that, post the overview and put the detail on a second card.

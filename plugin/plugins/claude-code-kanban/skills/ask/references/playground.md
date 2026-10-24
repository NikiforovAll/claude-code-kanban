# Playground

A playground is an ask card with controls on one side and a live preview on the other. The user moves the controls until the preview looks right, then sends. The answer is the settings and a sentence that says what they mean. Post it with `size: "full"`.

## Layout

- Two columns: controls on the left, about 280 px, and the preview filling the rest. Below 720 px the columns stack, preview first.
- Group the controls by concern under small headings. Put the rarely used ones in a `<details>` that starts closed.
- Presets sit above the controls as a row of buttons: 3 to 5 named combinations that look good. The first one is the default, so the card looks right on first load.
- One Send button closes the controls column. The card has no foot: the preview takes all the height.

## State

- Keep every setting in one `state` object, with a frozen `DEFAULTS` beside it.
- One `draw()` builds the preview from `state`. Every control only writes to `state` and calls `draw()`; there is no Apply button.
- Declare presets in markup, `<button data-preset='{"radius":8,"shadow":"soft"}'>Soft</button>`, and read them in one place. A new preset is one line of HTML.
- Keep the computation apart from the drawing, so the preview and the summary read the same numbers.
- Read colors from the theme variables on each draw, in canvas and SVG too.

## The answer

Send calls `cck.send({ summary, state })`:

- `summary` is one short sentence, built at send time, that an agent can act on without the card: the last preset picked and only the settings that differ from it, with words next to the numbers ("a soft 8 px shadow"). Keep that preset in `state`, so the summary compares against it, not against `DEFAULTS`.
- `state` is the full settings object, for exact values.

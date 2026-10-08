# State

For finite states: order status, connection lifecycle, job status, a wizard.

- States are rects with `rx` 8, name in sans.
- Start: a filled dot, `r` 6. End: a ring, `r` 8, around a filled dot, `r` 5.
- Every transition has a label in mono: `event [guard] / action`, each part only when it says something.
- A self-transition loops over the top of its state.
- Run top to bottom; reorder states before you let transitions cross.
- A transition from every state (timeout, cancel) is one note under the diagram, `* → Failed on timeout`, not an arrow from each state.
- Accent on the state the reader should notice, usually the failure state or the done state.
- More transitions than twice the states means two machines: post two cards.

# Flow

For decision logic, triage, routing: "if this, then that".

- Node shapes:
  - start and end: a pill, `rx` 16
  - step: a rect, `rx` 6
  - decision: a diamond with at most 3 exits; more exits means nested decisions
  - merge: a filled dot, `r` 4, where branches meet again
- Label every edge out of a decision (`yes`, `no`, `timeout`). By habit "yes" goes down and "no" goes right, but the label is what counts.
- Accent goes on the happy path or on the one decision that matters most, not on every decision.
- A long chain of steps is a numbered list.
- On a narrow card keep side branches one column wide and return them to the main column.

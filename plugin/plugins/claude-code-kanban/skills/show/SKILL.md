---
name: show
description: Show card guide for the cck overlay. Use before a show call that posts HTML (a chart, mockup or diagram), a mermaid diagram, or explains code (a call stack or tree).
argument-hint: '[explain|diagram|chart|mockup] [what to show]'
---

# Show cards

The `mcp__claude-code-kanban__show` tool exists only in a Claude Code session started in cck's terminal. Without it, tell the user that and stop.

An argument names a card kind from [Card kinds](#card-kinds) and what to show: read that kind's guide and post the card. With no kind, pick the one that makes the point best; with no topic, show the subject of this conversation.

## HTML contract

This applies to the `.html` file that a `kind: "html"` post names.

- Write a body fragment: no `<!doctype>`, `<html>`, `<head>` or `<body>`. The overlay wraps it in a sandboxed document. `<style>` and `<script>` work; the script has no access to the page around it.
- The card is about 360 to 640 px wide and sizes its height to the content. Keep the content in normal flow, without `position: fixed` or `100vh`.
- One chart or diagram per card, under an `<h2>` that says what to see. Keep it flat: solid fills and 1 px lines.
- Open links with `<a href="https://...">`; the overlay opens them in a new browser tab.
- To ask the user something, let the card answer for them. You get the answer as your next prompt, with a file that holds the fields as JSON.
  - One choice: a button per answer, sent on click: `<button data-cck-action="approve">Approve</button>`.
  - Several inputs: one form, sent once on submit with every field: `<form data-cck-submit="plan">…<button>Send</button></form>`. Give each input a `name`. `required` works.
  - Action names use letters, digits, `.`, `_` and `-`. The button text is the label you get. Nothing else in the card sends.
- Take every color and font from these variables, so the card follows the user's light or dark theme:

| Variable | Use |
|---|---|
| `--color-bg`, `--color-bg-subtle` | Page and panel background |
| `--color-text`, `--color-text-muted` | Body text, secondary text |
| `--color-border` | Lines, box outlines |
| `--color-accent` | The one thing to look at |
| `--color-info`, `--color-success`, `--color-warning`, `--color-danger` | Status |
| `--color-series-1` … `--color-series-8` | Chart series, in order |
| `--color-ramp-1` … `--color-ramp-5` | One-hue magnitude, least to most |
| `--font-sans`, `--font-mono` | Fonts |

## Card kinds

Any HTML that helps the user see the point is a good card: a comparison table, a checklist, a before and after, a diff, a small interactive widget, a mix of these. The HTML contract above is all it needs. Four kinds have their own guide; read it before you write that kind:

- Chart, stat tile or meter: [references/chart.md](references/chart.md)
- Mockup of a screen, dialog or form: [references/mockup.md](references/mockup.md)
- Diagram in SVG of a system, flow, states or layers: [references/diagram.md](references/diagram.md)
- Explain code (call stack, pseudocode, component or file tree, or a diff of one), in markdown: [references/explain.md](references/explain.md)

## Mermaid

The card is narrow. Use `flowchart TD`, short node labels and `subgraph` blocks, and split a big system map into several cards.

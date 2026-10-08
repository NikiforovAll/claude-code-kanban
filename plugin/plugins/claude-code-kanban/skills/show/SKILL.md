---
name: show
description: HTML contract and theme variables for an HTML card in the cck overlay, and layout tips for a mermaid card. Use before you show an HTML card or a mermaid diagram with the show tool.
---

# Show cards

The `mcp__claude-code-kanban__show` tool exists only in a Claude Code session started in cck's terminal. Without it, tell the user that and stop.

## HTML contract

This applies to `kind: "html"` content and to the `.html` file of a claim.

- Write a body fragment: no `<!doctype>`, `<html>`, `<head>` or `<body>`. The overlay wraps it in a sandboxed document. `<style>` and `<script>` work; the script has no access to the page around it.
- The card is about 360 to 640 px wide and sizes its height to the content. Keep the content in normal flow, without `position: fixed` or `100vh`.
- Open links with `<a href="https://...">`; the overlay opens them in a new browser tab.
- Take every color and font from these variables, so the card follows the user's light or dark theme:

| Variable | Use |
|---|---|
| `--color-bg`, `--color-bg-subtle` | Page and panel background |
| `--color-text`, `--color-text-muted` | Body text, secondary text |
| `--color-border` | Lines, box outlines |
| `--color-accent` | The one thing to look at |
| `--color-info`, `--color-success`, `--color-warning`, `--color-danger` | Status |
| `--font-sans`, `--font-mono` | Fonts |

## Mermaid

The card is narrow. Use `flowchart TD`, short node labels and `subgraph` blocks, and split a big system map into several cards.

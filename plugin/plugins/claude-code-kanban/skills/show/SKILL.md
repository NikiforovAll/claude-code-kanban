---
name: show
description: Show a diagram, plan, diff or HTML sketch in the cck overlay above this session's terminal. Use when the user asks to show, draw or visualize something, or asks for an overlay card kept current while you work.
---

# Show in the overlay

The overlay needs a Claude Code session started in cck's terminal. Without the `mcp__claude-code-kanban__show` tool, tell the user that and stop.

The overlay is a card at the top right of the cck terminal the user is looking at. The user decides what goes there: post what they asked for. A standing request, such as "keep the plan in the overlay", holds until the user ends it.

## Post

1. Pick the form for `mcp__claude-code-kanban__show`:
   - `kind: "markdown"` with `content` for prose, tables and fenced code. A ```` ```mermaid ```` fence renders as a diagram, and ```` ```diff ````, ```` ```json ```` and language fences are highlighted.
   - `kind: "html"` with `content` for anything you draw: SVG, a custom layout, a small interaction. Follow the HTML contract below.
   - `file` with an absolute path for a markdown, HTML, image or text file you already wrote. Big or data-heavy content (over 64 KB inline is refused) goes this way, best from a script that generates the file. Text files such as `.json` show as highlighted code. The overlay reads the file each time the card shows, so nothing is sent twice.
2. Give it a `title`. To keep one card current (a plan, a progress board), pass the same `key` on every update: the post with that key is replaced where it sits.

Done when the tool answers `Shown "<title>" (…)`. Tell the user in one line what you showed.

## HTML contract

- Send a body fragment: no `<!doctype>`, `<html>`, `<head>` or `<body>`. The overlay wraps it in a sandboxed document. `<style>` and `<script>` work; the script has no access to the page around it.
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

The card is narrow. Use `flowchart TD`, short node labels and `subgraph` blocks, and split a big system map into several posts.

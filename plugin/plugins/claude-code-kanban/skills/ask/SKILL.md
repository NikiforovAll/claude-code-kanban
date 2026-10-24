---
name: ask
description: Ask card guide for the cck ask modal, an HTML question the user answers over the terminal. Cards can be a form, quiz sheet, sliders over a preview, a diagram to pick from, or a playground.
argument-hint: '[playground|quiz|form] [what to ask]'
---

# Ask cards

The `mcp__claude-code-kanban__ask` tool exists only in a Claude Code session started in cck's terminal. Without it, ask with AskUserQuestion.

An argument names what to ask. A first word of `playground`, `quiz` or `form` sets the card kind; for a playground, read [references/playground.md](references/playground.md) and build one. With no argument, ask the open question of this conversation.

The tool opens the card as a modal over the terminal and waits. The user's answer comes back as the tool result.

## HTML contract

- Write a body fragment to an `.html` file in your scratchpad: no `<!doctype>`, `<html>`, `<head>` or `<body>`. The modal wraps it in a sandboxed document. `<style>` and `<script>` work; the script has no network and no access to the page around it.
- Pick the size with `size`: `md` 560 px wide for a short form, `lg` 960 px (default) for most cards, `full` the whole terminal for a playground or a quiz sheet. `md` and `lg` take the content's height up to the terminal's, then scroll, so keep their content in normal flow, without `position: fixed` or `100vh`. A `full` card always fills the terminal.
- Open the card with an `<h2>` that states the question. The modal title is the short form of it.
- Open links with `<a href="https://...">`; they open in a new browser tab.
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

## Sending the answer

- From a script: `cck.send(data)`, any JSON value, called from a click or a key press. Use it when the answer is state the card holds, such as a playground's settings or a quiz's picks.
- From markup: a form `<form data-cck-submit="name">` sends `{action, label, fields}` on submit, with each input's `name` as a field; `required` works. A button `<button data-cck-action="name">` sends its action and label. Action names use letters, digits, `.`, `_` and `-`.
- Put only the Send button where the card sends: the user's picks are already on screen.
- Send once, with everything you need: the first answer ends the question. Make each value self-explanatory, so the result reads without the card.
- A skip comes back as a line that says so. Go on without the answer, and ask in chat only if you cannot.

## Exhibits in the card

A picture the user answers about follows the show skill's guides, read before you draw: [chart](../show/references/chart.md), [diagram](../show/references/diagram.md), [mockup](../show/references/mockup.md). Their widths are for the narrower show card; the `size` above sets this one.

# Mockup card

A wireframe in an HTML card: a screen, a dialog, a form or a component, to agree on layout and wording before code.

## Content

- Real labels and real copy from the task: "Delete 3 sessions?", not "Lorem ipsum" or "Button".
- Plain boxes in place of logos, brand names and product chrome. A gray block (`--color-bg-subtle`) with a mono caption stands in for an image, chart or map.
- One screen or one state per card. For a flow, post one card per step under one `key` prefix, or show 2 or 3 states side by side when they fit.
- Mark open questions with numbered callouts: a small circle in `--color-accent` with a number, and the notes as a list under the sketch.

## Building blocks

The card already styles `button`, `button.primary`, `input`, `select`, `textarea`, `table` and headings from the tokens. Use them as they are.

```html
<style>
  .m { border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden; }
  .m-bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: var(--color-bg-subtle); border-bottom: 1px solid var(--color-border); }
  .m-body { padding: 12px; display: grid; gap: 8px; }
  .m-img { background: var(--color-bg-subtle); border: 1px dashed var(--color-border); border-radius: 6px; min-height: 64px; display: grid; place-items: center; font: 11px var(--font-mono); color: var(--color-text-muted); }
  .m-note { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--color-accent); color: #fff; font: 600 11px var(--font-sans); }
</style>
```

## Fit the card

- A sketch narrower than the card sits centered (`margin-inline: auto`).
- A phone screen fits at real size, about 360 px. A desktop screen does not: sketch the part under discussion (one panel, the toolbar, the dialog), not the whole window.
- Scripts may toggle a state (open a menu, switch a tab) to show the interaction. Keep it to a few lines; the card has no storage and no network.

# Diagram card

An SVG diagram in an HTML card, for a picture that mermaid lays out badly: layers, zones, lanes, a timeline, or one node that must stand out. For a plain flowchart, sequence or ER sketch, a mermaid block in a markdown card is cheaper; use this only when layout or emphasis carries the meaning.

## Decide first

- Would a table or three sentences say the same? Then write those.
- Pick one type from the table, then read its file before you draw.
- Delete before you add. Every node is a distinct idea: two nodes that always travel together are one. Every line carries information: if the layout already shows the link, drop the line.
- More than 9 nodes is two cards: an overview and a detail.

| Showing | Type | File |
|---|---|---|
| Decision logic with branches | Flow | `diagram/flow.md` |
| Messages between actors over time | Sequence | `diagram/sequence.md` |
| States and the events that move between them | State | `diagram/state.md` |
| Stacked levels of abstraction | Layers | `diagram/layers.md` |
| Components, connections, trust zones | Architecture | `diagram/architecture.md` |
| Parent and children | Tree | `diagram/tree.md` |
| A process with handoffs between teams | Swimlane | `diagram/swimlane.md` |
| Events in time | Timeline | `diagram/timeline.md` |
| Entities, fields, relationships | ER | `diagram/er.md` |

Bars, lines, scatter and Gantt are charts: read `chart.md`.

## Fit the card

Content wider than the card scrolls sideways, which reads badly; content taller than the card scrolls down, which reads fine.

- Draw for a narrow card: viewBox width 400 to 480, top to bottom. A wide left-to-right map turns its 12 px labels into 8 px at the default size.
- Scale with the card: `<svg viewBox="0 0 440 H" style="width:100%;max-width:660px;height:auto">`. Never a fixed `width`.
- Text at least 12 viewBox units, so it stays readable at 360 px.
- The title goes in the `<h2>` above the SVG, not inside it.

## Colors

Presentation attributes do not take `var()`, so color the SVG through classes in a `<style>` block. Then the diagram follows the user's theme switch with no script.

| Role | Token |
|---|---|
| Canvas, node mask | `--color-bg` |
| Container, zone fill | `--color-bg-subtle` |
| Node name, main stroke | `--color-text` |
| Sublabel, default arrow, lifeline | `--color-text-muted` |
| Hairline, zone outline | `--color-border` |
| Focal node or path, 1 or 2 per diagram | `--color-accent` |
| Status meaning only | `--color-info`, `--color-success`, `--color-warning`, `--color-danger` |

Make tints with `color-mix(in srgb, var(--color-accent) 12%, var(--color-bg))`, not opacity, so lines behind a node do not show through.

```html
<style>
  .d text { font: 12px var(--font-sans); fill: var(--color-text); }
  .d .sub { font: 12px var(--font-mono); fill: var(--color-text-muted); }
  .d .node { fill: var(--color-bg); stroke: var(--color-text); stroke-width: 1; }
  .d .store { fill: var(--color-bg-subtle); stroke: var(--color-text-muted); }
  .d .focal { fill: color-mix(in srgb, var(--color-accent) 12%, var(--color-bg)); stroke: var(--color-accent); }
  .d .edge { fill: none; stroke: var(--color-text-muted); stroke-width: 1.2; }
  .d .edge.hot { stroke: var(--color-accent); }
  .d .dash { stroke-dasharray: 4 3; }
  .d .head { fill: var(--color-text-muted); }
  .d .label-mask { fill: var(--color-bg); }
</style>
<svg class="d" viewBox="0 0 440 300" style="width:100%;max-width:660px;height:auto" role="img" aria-labelledby="d1-t">
  <title id="d1-t">Order service writes to the queue</title>
  <defs>
    <marker id="d1-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon class="head" points="0 0, 8 3, 0 6" />
    </marker>
  </defs>
  <!-- edges first, then nodes -->
</svg>
```

Give each marker and title an id with a per-card prefix (`d1-`), so two SVGs in one card do not clash.

## Shapes and lines

- Node: `rx` 6, name in `--font-sans`, a technical sublabel (port, path, type) in `--font-mono`. Names in mono read as noise.
- Node kinds by fill and stroke, not by color: plain step `.node`, store `.store`, external a thin stroke, optional or async a dashed stroke, focal `.focal`.
- Lines go straight or bend at right angles with a rounded corner (radius 8), also between nodes that are not on one axis.
- Draw edges before nodes, so nodes cover the line ends.
- An edge label sits horizontal on an opaque `.label-mask` rect, 6 to 10 units off its line, at most 14 characters.
- Each line has its own path and attach point, 12 units from the next.
- Corner radius at most 8.
- A legend, when the diagram needs one, is a row below the diagram, not inside it.
- Coordinates and sizes on a 4-unit grid keep the spacing even.

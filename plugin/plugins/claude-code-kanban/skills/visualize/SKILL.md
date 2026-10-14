---
name: visualize
description: Present a topic as one static HTML page — findings, options and a pick, a system overview. Use when the user asks to visualize something, or when an answer outgrows chat (options plus a pick, a diagram plus a table).
argument-hint: '[what to present]'
---

# Visualize

Present this: $ARGUMENTS. With no argument, present the subject of this conversation.

The page is a document to read: every mark is in the HTML, and it works offline with scripts off. Two leading words run through it: the **pick** is the option the page recommends (on a page with no options, its main path), and an **exhibit** is the one table, figure or block that proves a section's claim.

## Steps

1. **Copy.** `cp` [template.html](template.html) from this skill's base directory to the output path. Edit the `<title>` and inside `<main>`; the `<style>` block stays byte for byte, and your own CSS goes in a second `<style>` after it.
2. **Write the story.** The `<h1>`, the lead and the `<h2>`s alone carry the whole point:
   1. `.kicker`, then `<title>` and `<h1>`: a name of 2 to 5 words. `.sub`: the question, in one line.
   2. `.lead`: the answer in 1 or 2 sentences, the pick in `<b>`.
   3. Sections. Each `<h2>` is a claim that can be false ("A breaker alone trips again on release", not "Breaker"), with one exhibit and at most 2 short paragraphs under it.
   4. Close with what to do next and `.sources`.
3. **Invent each exhibit.** Ask what form makes this claim obvious at a glance, then build that, the template's blocks or something new: a slope chart, an annotated timeline, small multiples, a cutaway, a ranked strip, a map. The Blocks table is a palette of ready parts, not a menu to choose from. Before you draw an SVG, read the matching guide in the `show` skill — [chart](../show/references/chart.md), [diagram](../show/references/diagram.md) and its type file, [mockup](../show/references/mockup.md) — for shapes, arrows and labels; the Fit rule below replaces their card sizes, and label masks fill with `--color-bg-subtle`, the figure's background.
4. **Check.** Render the page headless (Playwright) in light and in dark, and look at each screenshot. Done when no text is clipped, no arrow crosses a label, `scrollWidth` equals `clientWidth`, and, when the topic comes from a source such as a file or a conversation, every section and number of it is named where it landed on the page or reported to the user as left out.
5. **Show.** When `$CCK_URL` is set, the session runs in the cck board: run `claude-code-kanban pane add <page> --title '<h1>'` and tell the user the page waits in that tab. Else give the user the page path.

## Principles

Every exhibit, ready or new, keeps these:

- **Accent marks the pick**, one or two marks per exhibit: its tile, card, row, node, or the one bar or point in a chart. The rest stays muted. Status colors mean status.
- **Chart data takes series colors**: `--color-series-1` for the main series, `--color-text-muted` or `--color-series-3` for a second, up to 8 series; past that, fold the tail into "Other" or split into small multiples. The accent can sit close to `--color-danger`, so a whole data series in it reads as an alarm.
- **Tokens color everything**: `var(--color-*)`, tints by `color-mix(in srgb, var(--color-accent) 12%, var(--color-bg))`. Then the page follows light, dark and a host's theme with no script.
- **Fit**: an SVG has a `viewBox` up to 960 wide, no `width` attribute, text of 12 units or more. A flow runs left to right when it has 6 steps or fewer.
- **Remove test**: each node, arrow, label and decoration stays only if removing it loses meaning. A diagram past 9 nodes or 12 arrows splits into an overview and a detail. Each SVG has `role="img"` and `aria-labelledby` pointing at its `<title>`, with a per-figure id prefix.
- **Real**: real names, numbers and `file:line`, estimates and invented data marked, each claim cited. Repeated marks, such as small multiples, are generated while you write the page.

## Blocks

Ready parts in the template's CSS; its body has one of each.

| Block | Markup | Good for |
|---|---|---|
| Kicker | `p.kicker` | Ticket or kind of page |
| Lead | `p.lead` | The answer; `<b>` takes the accent |
| Lineup | `.lineup > div > b + span + small` | Every option as a tile: index, name, 2-word verdict |
| Stat tiles | `.kpis > .kpi > span + b + small` | 1 to 4 headline numbers |
| Section | `section > p.eyebrow + h2` | CSS numbers the eyebrow |
| Cards | `.cards > .card > h3 + p.verdict + p + pre + ul` | Trade-offs; `li.pro`, `li.con` |
| Table | `.table > table`; `td.num`, `td.c`, `tr[data-tone]` | A matrix |
| Heatmap | `td.yes`, `td.part`, `td.no` | Tinted cells: `yes` the good outcome, `no` the bad, whatever word the cell holds |
| Figure | `figure > svg + figcaption` | A diagram or a chart |
| Points | `ul.points > li > b + text` | Findings, each led by its claim |
| Callout | `div.callout` | A warning |
| Steps | `ol.steps` | What to do next |
| Tag, dot, legend | `span.tag`, `span.dot`, `.legend > span > i` | Labels and keys |
| Sources | `div.sources` | Where each claim comes from |

`data-tone` takes `accent`, `info`, `success`, `warning`, `danger` or `muted` on any block, legend keys included.

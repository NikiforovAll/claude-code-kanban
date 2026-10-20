---
name: visualize
description: Present a topic as one self-contained HTML page whose form fits the content — a diagram of a system, a chart of numbers over time, a model the reader can change, a comparison with a pick. Use when the user asks to visualize something, or when an answer outgrows chat.
argument-hint: '[what to present]'
---

# Visualize

Present this: $ARGUMENTS. With no argument, present the subject of this conversation.

The page is a document to read: its text and static exhibits are in the HTML, and it works offline. Two leading words run through it: the **pick** is the option the page recommends, and an **exhibit** is the one table, figure or block that proves a section's claim. A page with no options has no pick: never invent one to recommend.

The content sets the page's shape. The template gives the theme and a bare frame; [blocks.html](blocks.html) holds ready parts that share the theme, and a page takes only the parts its content has.

## Steps

1. **Choose the form.** Before you open the template, name the content's shape (a system, a process, a timeline, a comparison, numbers that change, a set of findings) and the page's main exhibit: the one picture a reader remembers. State both in one line. The form makes the claim obvious at a glance. When the content has parts that connect, steps in order or states that change, the main exhibit is a diagram. Else a chart, an annotated timeline, small multiples, a working model or a ready part, whichever proves the claim.
2. **Copy.** `cp` [template.html](template.html) from this skill's base directory to the output path. Edit the `<title>` and inside `<main>`. Leave the template's `<style>` block as it is, because it holds the theme tokens, and put your own CSS in a second `<style>` after it.
3. **Write the story.** The `<h1>`, the lead and the `<h2>`s alone carry the whole point. A page has a title, a lead, sections and, when it cites, sources; every other part is there only when the content has that shape:
   1. `<title>` and `<h1>`: a name of 2 to 5 words. `.kicker` and `.sub` (the question, in one line) when they add something.
   2. `.lead`: the answer, short enough that a reader who stops here has it. When the page has a pick, name it in `<b>`; else `<b>` holds the main finding, or nothing.
   3. A lineup when the page compares options, stat tiles when it has a few headline numbers.
   4. Sections. Each `<h2>` is a claim that can be false ("A breaker alone trips again on release", not "Breaker"), with one exhibit and the short text that supports it.
   5. Close with what to do next, when there is a next step, and `.sources`, one `li` per source. Each `[n]` in the text is an `a.cite` to its row.
4. **Build each exhibit.** Each section's claim gets the form that makes it obvious, as in step 1: a slope chart, an annotated timeline, small multiples, a cutaway, a ranked strip, a map, or a ready part. Before you draw an SVG, read the matching guide in the `show` skill — [chart](../show/references/chart.md), [diagram](../show/references/diagram.md) and its type file, [mockup](../show/references/mockup.md) — for patterns: shapes, arrows and labels. Their sizes and directions are for cards; on a page, the Principles below set them. Label masks fill with `--color-bg-subtle`, the figure's background. When the source or the request has a value the reader would want to change, or states one after another, the exhibit is interactive: a slider or toggle that computes the figure again, a stepper through states, or a model that runs over time. Use the simplest one that proves the claim, and follow [Interactive exhibits](#interactive-exhibits). Never add a control on an input you made up: a claim that rests on fixed facts gets a static exhibit.
5. **Check.** Render the page in light and in dark, and look at each render, not the source. Done when a reader who sees only a thumbnail can tell what the page is about, no text is clipped, no arrow crosses a label, `scrollWidth` equals `clientWidth`, and, when the topic comes from a source such as a file or a conversation, every section and number of it is named where it landed on the page or reported to the user as left out. For an interactive exhibit, also: no console errors, and the numbers the text states are the ones the exhibit shows at its default settings.
6. **Show.** When `$CCK_URL` is set, the session runs in the cck board: run `claude-code-kanban pane add <page> --title '<h1>'` and tell the user the page waits in that tab. Else give the user the page path.

## Principles

Every exhibit, ready or new, keeps these:

- **Accent marks the pick**, one or two marks per exhibit: its tile, card, row, node, or the one bar or point in a chart. In a chart that compares options, the pick's series keeps its series color and the accent goes on its label or end point. With no pick, the accent marks the one thing the claim is about, or nothing. The rest stays muted. Status colors mean status.
- **Chart data takes series colors**: `--color-series-1` for the main series, `--color-text-muted` or `--color-series-3` for a second, up to 8 series; skip `--color-series-2`, which is the accent's hue; past that, fold the tail into "Other" or split into small multiples. The accent can sit close to `--color-danger`, so a whole data series in it reads as an alarm.
- **Tokens color everything**: `var(--color-*)`, tints by `color-mix(in srgb, var(--color-accent) 12%, var(--color-bg))`. Then the page follows light, dark and a host's theme with no script.
- **Fit**: an SVG has a `viewBox` up to 960 wide, no `width` attribute, text of 12 units or more. A flow runs left to right when it has 6 steps or fewer.
- **Remove test**: each node, arrow, label and decoration stays only if removing it loses meaning. A diagram past 9 nodes or 12 arrows splits into an overview and a detail. Each SVG has `role="img"` and `aria-labelledby` pointing at its `<title>`, with a per-figure id prefix.
- **Real**: real names, numbers and `file:line`, estimates and invented data marked, each claim cited. Repeated marks, such as small multiples, are generated while you write the page.
- **Structure follows the content**: the sections, their order and the parts in them come from the data and the question, so two pages on different topics have different shapes. A part the content does not call for stays out: stat tiles with no headline numbers, next steps nobody asked for, a lineup with no options.

## Interactive exhibits

- An exhibit is the figure, its controls and the outputs they drive. The script draws the figure and writes only inside its exhibit; the text outside it is static HTML.
- Keep it small to edit: all inputs in one state object, one draw function that builds every figure from that state, and controls that only change state and call draw. Keep the computation apart from the drawing.
- Declare controls and presets in the markup, next to the text that names each scenario, and read them in one place. A new scenario is then one line of HTML.
- Colors come from the tokens on every draw, in canvas too, so a theme change needs no extra code.
- Nothing runs while the reader does nothing, except a running model that is on screen.
- Numbers from a model are marked as model numbers.
- The script goes at the end of `<body>`; its CSS goes in the second `<style>`.

## Blocks

Ready parts in the template's CSS. [blocks.html](blocks.html) shows the markup of each; read the rows you use, in the order the story needs.

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
| Sources | `.sources > ol > li#src-n > code + span`, then `p` | Where each claim comes from: one source per `li`, numbered in order (CSS prints `[n]`), the path or `a` link, and in `span` what it backs; a closing line, such as how estimates are marked, goes in the `p` |
| Citation | `a.cite[href="#src-n"]` holding `[n]` | An in-text marker that jumps to its source row |

`data-tone` takes `accent`, `info`, `success`, `warning`, `danger` or `muted` on any block, legend keys included.

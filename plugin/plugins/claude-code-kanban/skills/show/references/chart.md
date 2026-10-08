# Chart card

A chart in an HTML card. The card's CSP allows inline script only, so no chart library loads: draw bars with CSS or SVG, and lines with SVG.

## Choose the form before the colors

The data's job picks the form, and often the right form is not a chart.

| The data is | Post | Not |
|---|---|---|
| One current value, maybe with its change | A stat tile | A bar chart with one bar |
| 2 to 4 headline numbers | A row of stat tiles | A grouped bar chart |
| One ratio against a limit | A meter: a track with a fill | A pie with 2 slices |

When it is a chart, the reader's job picks the type:

| The reader must | Type | Color |
|---|---|---|
| Compare sizes | Horizontal bars, sorted | One color, `--color-series-1` |
| See a trend over time | A line; an area for one series | One color |
| Tell series apart | Grouped or stacked bars, several lines | Series tokens in order |
| See that one item stands out | Bars or lines with one in `--color-accent`, the rest in `--color-border` | Accent and gray |
| See above or below a baseline | Bars that grow both ways from a zero line | `--color-success` and `--color-danger` only when up is good |
| See a magnitude across a grid | A heatmap | The ramp |
| See part of a whole | One stacked bar; at most 6 parts | Series tokens |

Horizontal bars suit the card best: long labels fit at the left and the bars use the width. Close values go in bars, because a pie hides small differences. One y-axis per chart: for two scales, post two charts or index both series to 100.

## Series

- Use the series tokens in order: the order keeps neighbors apart for color-blind readers.
- 1 to 3 series: color with direct labels is enough.
- 4 to 6: a legend, and label the lines at their ends.
- 7 or 8: the most the tokens allow. Past that, fold the smallest into "Other" or post a table. Never make up a ninth color.
- A series keeps its color when you filter or sort: color follows the item, not its rank.
- The ramp is for ordered values. Groups with no order (teams, endpoints) take series colors.
- Labels and values use `--color-text` or `--color-text-muted`; a small swatch or line key beside the text carries the series color.

## Marks

- Bars at most 24 px thick, with a 2 px gap between neighbors, rounded 4 px at the value end and square at the baseline. All bars grow from one baseline.
- Lines 2 px, round joins. End dots at least 8 px wide.
- An area fill is the series color at about 10% opacity.
- Gridlines and axes are solid 1 px `--color-border`, never dashed. Fewer is better: direct labels first, gridlines next.
- Separate touching marks with a gap in the background color, not with a stroke.

## Labels

- The `<h2>` says what to see ("p95 latency doubled after the deploy"), not what is plotted.
- Label the few values that matter: the last point, the extreme, the item the card is about. Put the value at the bar end or the line end.
- Round axis ticks (0, 1,000, 2,000) and use thousands separators.
- A label that does not fit inside a bar goes outside its end. Never clip it.
- Stat tile: a short label in sentence case, the value in sans, semibold, compact (`12.9K`, `$4.2M`), and an optional change against a named period (`+8% vs last week`), green or red only by whether up is good.
- `font-variant-numeric: tabular-nums` only for numbers in a column; a large single value uses normal figures.

## Fit the card

Size bars in `%`, or give SVG a `viewBox` and `width:100%`, so the chart scales with the card.

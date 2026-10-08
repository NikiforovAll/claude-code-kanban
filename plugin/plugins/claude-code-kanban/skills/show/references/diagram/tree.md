# Tree

For parent and children: a dependency tree, a taxonomy, a breakdown, an ownership chart.

- Root at the top. At most 4 levels and 4 children per level on a card; past that, split it, or turn the tree on its side as an indented list with elbow lines on the left, which fits a narrow card well.
- Nodes are rects with `rx` 6, 32 to 48 units tall, at most two widths.
- Lines are elbows: a short drop from the parent, a horizontal bus over the children, a short drop into each child's top edge. Hairline, muted.
- A leaf can have a thinner stroke, or let its position say it.
- Accent on one node: the root or one key leaf, not both.
- No level skipped: a parent links only to its own children.

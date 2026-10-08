# Architecture

For components and how they connect: a system overview, an integration map, trust zones.

- Group by tier, top to bottom: clients, services, stores.
- A zone (tier, network, trust boundary) is a rect with `rx` 8, `--color-bg-subtle` fill and a `--color-border` hairline, drawn first. Its name is a small mono label in its top left corner with 16 units of space above the first node. At most 3 zones; a dashed outline marks a trust boundary.
- 1 or 2 focal nodes: the main entry point or the main store.
- A two-bend path from (x1,y1) down to (x2,y2), with `m` halfway down:

```svg
<path class="edge" d="M x1,y1 V m-8 Q x1,m x1+8,m H x2-8 Q x2,m x2,m+8 V y2" marker-end="url(#d1-arrow)"/>
```

  Flip the signs for the other directions. A line between nodes on one axis is a straight `V` or `H`.
- A vertical connection leaves the bottom edge and enters the top edge, not the sides.
- Where two lines must cross, the less important one hops over with a small arc: `H cx-8 a 8,8 0 0,1 16,0 H x2`.
- A call to an outside API may use `--color-info` for its line, when the diagram mixes internal and external calls.
- No two-headed arrows when one direction is the obvious one.

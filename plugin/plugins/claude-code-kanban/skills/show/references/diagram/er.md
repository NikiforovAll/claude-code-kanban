# ER

For a data model: tables, API resources, domain entities. A model with plain relationships is cheaper as a mermaid `erDiagram`; draw SVG when you need to group entities or mark the central one.

- At most 6 entities on a card; 2 columns of entities, relations between them.
- An entity is a box in two parts: a header with its name in sans on `--color-bg-subtle`, and a body with one field per line in mono. Mark the key `#id`, a foreign key `→ user_id`. Show only the fields the point needs.
- Boxes take the height of their fields; do not pad them to match.
- Relations are lines with the cardinality near each end in mono, 8 to 12 units off the box: `1`, `N`, `0..1`, `1..*`. Use one notation for both ends.
- An optional verb (`owns`, `belongs to`) sits on the middle of the line on a mask.
- Accent on the aggregate root or the entity the card is about.

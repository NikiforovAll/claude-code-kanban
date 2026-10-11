---
name: swarm-viewer
description: Open the swarm viewer for a swarm as a cck pane. Reuses the hub's Swarm app or a running viewer, else starts one.
argument-hint: '[listId]'
---

# Open the swarm viewer

The argument is the swarm id (`listId`). With no id, the viewer opens the newest running swarm, else the newest one.

1. Get the viewer's URL from this skill's base directory:

   ```bash
   node "<base directory>/../../scripts/viewer.mjs" <listId>
   ```

   It prints `{url, source}`. `source` is `hub` (the hub's Swarm app), `running` (a viewer started earlier) or `started` (a new viewer, which keeps running after this session ends). On an error, report it as it is and stop.

2. Add the URL as a pane next to Board:

   ```bash
   claude-code-kanban pane add "<url>" --title Swarm
   ```

   Run `npx claude-code-kanban` when the bare binary is not on PATH. The pane goes to this session. The board does not switch to it; the user opens the tab when ready.

3. Report the URL and the pane id to the user. When `pane add` fails because no cck server is reachable, give the user the URL to open in a browser.

To run the viewer by hand, add it to the hub or choose its port, see [references/swarm-viewer.md](references/swarm-viewer.md).

# Swarm viewer

A read-only web page for a running or ended swarm. It answers: is the swarm on track, who works on what, what did the workers find, and what changed. It reads the same store as the workers and updates live as events arrive.

It lives at `<base directory>/../../viewer` (this skill's base directory). It needs Node with `node:sqlite` available without a flag (22.13 or later) and no npm install.

## Which swarm it shows

- Each swarm is a folder under `<CLAUDE_CONFIG_DIR>/.cck/swarm/`. The folder name is the swarm id, the `listId` the start script prints.
- `?swarm=<listId>` selects a swarm. With no id, the viewer opens the newest running swarm, else the newest one.
- `?view=<id>` selects a tab: `summary`, `queue`, `timeline`, `knowledge`, `changes` or `log`.
- A picker in the top bar lists every swarm in the config dir.

## Run it

Start it as a long-lived process: a tmux window, or a terminal in cck. Never as a shell job with `&`.

```bash
CLAUDE_CONFIG_DIR=<config dir> node "<base directory>/../../viewer/server.js" --port 3546
```

It prints `Swarm running at http://localhost:<port>` when it is ready.

| Option | Default | Meaning |
|---|---|---|
| `--port <n>` or `PORT` | 3546 | Port. `0` picks a free one. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | The config dir whose swarms it lists. Use the dir the swarm started in. |
| `--swarm <folder>` | | Show only this swarm folder. The picker and `?swarm=` are then ignored. |
| `HOST` | `127.0.0.1` | Bind address. |
| `ALLOWED_HOSTS` | | More Host header values to accept, comma-separated. Others get 403. |

## Show it in a cck pane

With the viewer running, add it to a session as a background tab next to Board:

```bash
claude-code-kanban pane add "http://localhost:3546/?swarm=<listId>" --title Swarm
```

The pane goes to this session (`$CLAUDE_CODE_SESSION_ID`). Pass `--session <id>` for another session. The user opens the tab when ready.

## Run it as a hub app

Add an entry to the `apps` list in the hub's `config.json` (`~/.claude-hub/config.json`, or the `--hub-dir` folder), then restart the hub:

```json
{
  "apps": [
    { "id": "swarm", "path": "<absolute path to the viewer folder>", "port": 3546 }
  ]
}
```

- `id` must be `swarm`, the id in the viewer's `hub-app.json`.
- `path` is absolute, or relative to the hub dir.
- `port` is optional; it is the hub's proxy port for the app. Apps not listed keep their default order.

The hub starts the viewer with the active config dir, so the swarm list follows a config-dir switch. Under the hub the page follows the hub's theme, and the app launcher (`Ctrl+Alt+A`) lists Swarm.

Other hub apps open a swarm with the hub action `swarm.open` and the param `{ "swarm": "<listId>" }`. With no param it opens the default swarm.

# Swarm viewer

A read-only web page for a running or ended swarm. It answers: is the swarm on track, who works on what, what did the workers find, and what changed. It reads the same store as the workers and updates live as events arrive.

It lives at `<base directory>/../../viewer` (this skill's base directory). It needs Node with `node:sqlite` available without a flag (22.13 or later) and no npm install.

## Which swarm it shows

- Each swarm is a folder under `<CLAUDE_CONFIG_DIR>/.cck/swarm/`. The folder name is the swarm id, the `listId` the start script prints.
- `?swarm=<listId>` selects a swarm. With no id, the viewer opens the newest running swarm, else the newest one.
- `?view=<id>` selects a tab: `summary`, `request`, `queue`, `timeline`, `knowledge`, `changes` or `log`.
- On the `request` tab, `&rev=<n>` opens request revision n (1 is the spec), and `&sec=sec-<section>` opens a spec section, such as `sec=sec-goal`.
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
| `--idle-exit <minutes>` | off | Exit after this long with no HTTP request and no open live stream. Fractions work. |
| `HOST` | `127.0.0.1` | Bind address. |
| `ALLOWED_HOSTS` | | More Host header values to accept, comma-separated. Others get 403. |

## One viewer per config dir

The viewer keeps a record at `<config dir>/.cck/swarm-viewer.json`:

```json
{ "pid": 4242, "port": 61258, "configDir": "C:\\Users\\me\\.claude" }
```

- On start, it reads the record. When that viewer still runs and its `GET /api/health` names the same config dir, the new process prints that viewer's `Swarm running at` line and exits 0 without listening.
- Else it listens, then claims the record with an exclusive create. Of two viewers that start together, the one that loses prints the winner's line and exits 0. A record left by a dead viewer is replaced.
- It removes the record when it exits, only if the record is its own. A killed viewer leaves the record behind; the next start finds it dead and replaces it.
- A viewer under the hub (`CLAUDE_HUB=1`) or with `--swarm` does not read or write the record.

`GET /api/health` answers `{ ok, pid, port, configDir, pinned }`. Check `configDir` before using a recorded port, because a port can be reused by another config dir's viewer.

## The viewer the skill starts

`scripts/viewer.mjs` checks the hub first: it reads `hub.json` and `token` in the hub dir (`CLAUDE_HUB_DIR`, else `~/.claude-hub`) and asks the hub's `/api/config` for the Swarm app. When the hub lists it, the script uses it and starts nothing.

Else it starts the viewer on a free port as a detached process, with `--idle-exit`, and reads the port from the `Swarm running at` line. The viewer keeps its own record, so a later run, or a parallel one, reuses it while it answers. To stop it, end the process with the recorded `pid`.

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

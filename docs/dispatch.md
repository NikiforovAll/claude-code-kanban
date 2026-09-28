# Dispatch

`claude-code-kanban dispatch start` lets one Claude Code session start another through cck. The new session runs in cck's embedded terminal, so the user can open it at any time. It is an ordinary session: the board shows no parent, tree, or dispatch status.

## Flow

```
starter  dispatch start --cwd <dir> --spec-file <f> --name <n> --group <g> [--peer <p>] [--report] [--model <m>] [--worktree [n]]
cck      POST /api/dispatch -> record + terminal.startNew(prompt) -> {dispatch, session, cwd, group}
started  (only with --report) dispatch done <id> --cap <cap> --outcome succeeded|failed --summary <text>
starter  dispatch wait [<id>...] --timeout 15m, or a pushed line from the kanban-dispatch postman
```

- The starter id comes from `CLAUDE_CODE_SESSION_ID` and is stored as `parent`. It routes a report to the starter's inbox and lets the board follow the starter into a named group. The board never shows it.
- `POST /api/dispatch` needs the terminal token, which the CLI reads from `<config dir>/.cck/terminal-tokens/<port>.json` for the board it reaches (`CCK_URL`, `PORT`, then `server.json`). Each board writes its own file, so two boards on one config dir do not overwrite each other's token. `done` needs only the per-dispatch capability from the preamble; the started session never holds the terminal token.
- With neither `--report` nor `--peer` the prompt is the task alone. Otherwise it starts with a preamble (`formatPreamble`): `--peer` names the starter's Claude Code peer to ask with `SendMessage`, and `--report` adds the exact `done` command. The peer name goes into the prompt verbatim, so the server accepts only `isPeerName` values.
- Records are in memory (`lib/dispatch.js`). The terminals die with the server, so a restart loses nothing that could still settle. A session whose terminal ends before `done` settles as `exited`.
- A report is pushed to the starter only with `--report`, on the `dispatch` doorbell topic, so a `kanban-dispatch` postman never gets `task.moved` lines.

## Placement

A started session must not jump into a group after it appears, so its place is decided when it starts:

1. `--group <g>` (kebab-case, `^[a-z0-9]+(-[a-z0-9]+)*$`), else
2. the starter's transient group, else
3. the starter's named group, which only the browser knows (resolved at render time from `startedBy`), else
4. its project block.

`dispatch-update` makes the board fetch `GET /api/dispatch` and show a "starting" placeholder in that place until the transcript appears. `/api/sessions` then carries `dispatchGroup` and `startedBy`, so the real card lands in the same place.

## Transient groups

`lib/dispatch-groups.js`, persisted in `<config dir>/.cck/dispatch-groups.json` as `{version: 1, sessions: {<id>: <group>}}`.

- `--group` puts the started session in the group. The starter stays where it is, because moving it would jump it under the user. Each started session records its starter in `starters` (`{<started id>: <starter id>}` in the same file), so the starter's later dispatches default to the group of its latest one. The link goes when that session leaves the group.
- A group lives while any member's claude runs (a cck terminal or a live registry pid), and for 60 s after (a claude that has not registered yet, a resume, registry lag).
- After that, only pinned members (`pins.json`) stay. So a pinned group survives a server restart; everything else returns to its project block, once its session has ended.
- Named groups (localStorage) win: a session the user placed, or whose project sits in a named group, stays there. A named group with the transient group's name takes its sessions in.
- **Keep** on a transient group header creates a named group with the same name and its sessions. Later dispatches with that `--group` land in it by name.

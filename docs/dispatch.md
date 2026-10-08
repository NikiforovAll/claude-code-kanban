# Dispatch

`claude-code-kanban dispatch start` lets one Claude Code session start another through cck. It is a thin wrapper: cck runs `claude` in its embedded terminal with a fresh session id, the cck flags and any args after `--`, and types the spec as the first message. The user can open the terminal at any time.

The started session is an ordinary session, not a child: the board shows no tree. Its card carries a marker: `/api/sessions` carries `dispatched: {parent}`, and the card shows a send icon whose tooltip names the starter and whose click reveals it. The markers are kept in `<config dir>/.cck/dispatched.json` (`lib/retention.js`), so they outlive the terminal and a restart, and they expire with the session's transcript (see `docs/retention.md`).

cck has no report channel. The two sessions talk with Claude Code's own `SendMessage`, and the starter writes the report instruction into the spec (`skill-guides/dispatch.md`).

## Flow

```
starter  dispatch start --cwd <dir> --spec-file <f> --name <n> [--group <g>] [--model <m>] [--worktree [n]] [-- <claude args>]
cck      POST /api/dispatch -> terminal.startNew -> {session, cwd, group}
started  SendMessage to the starter, as the spec says
```

- The starter id comes from `CLAUDE_CODE_SESSION_ID` and is stored as `parent`. It links the card back to the starter.
- `POST /api/dispatch` needs the terminal token, which the CLI reads from `<config dir>/.cck/terminal-tokens/<port>.json` for the board it reaches (`CCK_URL`, `PORT`, then `server.json`). Each board writes its own file, so two boards on one config dir do not overwrite each other's token. The started session never holds the token.
- Args after `--` go to `claude` after `--session-id` (`claudeArgsFor` in `lib/terminal.js`). They reach a shell command line inside plain quotes, so `parseNewSpec` refuses a value with a quote, `%` or a control character, more than 64 args, and the flags cck sets or that would not start a new session (`OWNED_FLAGS`). A restored terminal runs `claude --resume <id>` without them.
- `--task-list [id]` (opt-in) sets `CLAUDE_CODE_TASK_LIST_ID` in the PTY env, never on the command line, so the session shares that task list; with no value the CLI sends the starter's own list (`CLAUDE_CODE_TASK_LIST_ID`, else `CLAUDE_CODE_SESSION_ID`). `ptyEnv` strips an inherited value, so no terminal shares a list unless asked. `terminals.json` keeps it as `taskLists: {<id>: <list>}`, so a restored terminal resumes with it.
- A task in the starter's list whose `owner` is a started session's name links to that session (`addOwnerSessions` in `server.js`, see `docs/session-scanning.md`).
- The running list (`running` of the store in `lib/retention.js`) is the markers in `dispatched.json` whose session has a running cck terminal. A marker keeps `parent`, `name`, `group`, `cwd` and `worktree`, so a session that cck resumes after a restart, or that the user reopens, is in the list again. It feeds the placeholder, `dispatch list` and `dispatch end`. A marker never ends, so a session the user reopens weeks later is again in its starter's `dispatch list`, until the marker expires.
- A resumed starter gets a new `SendMessage` peer name, and `SendMessage` cannot address a session by id. The starter sends each running worker its new name (`skills/dispatch/SKILL.md`).

## Placement

A started session must not jump into a group after it appears, so its place is decided when it starts. Only an explicit `--group <g>` (kebab-case, `^[a-z0-9]+(-[a-z0-9]+)*$`) puts it in a group; without the flag it goes to its project block. The starter's own group is never inherited, so each dispatch states its group.

`dispatch-update` makes the board fetch `GET /api/dispatch` and show a "starting" placeholder in that place until the transcript appears. `/api/sessions` then carries `dispatchGroup`, so the real card lands in the same place.

## Transient groups

`lib/dispatch-groups.js`, persisted in `<config dir>/.cck/dispatch-groups.json` as `{version: 1, sessions: {<id>: <group>}}`.

- `--group` puts the started session in the group. The starter stays where it is, because moving it would jump it under the user.
- A group lives while any member's claude runs (a cck terminal or a live registry pid), and for 60 s after (a claude that has not registered yet, a resume, registry lag).
- After that, only pinned members (`pins.json`) stay. So a pinned group survives a server restart; everything else returns to its project block, once its session has ended.
- Named groups (localStorage) win: a session the user placed, or whose project sits in a named group, stays there. A named group with the transient group's name takes its sessions in.
- **Keep** on a transient group header creates a named group with the same name and its sessions. Later dispatches with that `--group` land in it by name.

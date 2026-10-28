# Dispatch

`claude-code-kanban dispatch start` lets one Claude Code session start another through cck. It is a thin wrapper: cck runs `claude` in its embedded terminal with a fresh session id, the cck flags and any args after `--`, and types the spec as the first message. The user can open the terminal at any time.

The started session is an ordinary session. Its card carries a marker: `/api/sessions` carries `dispatched: {parent, child}`, and the card shows a send icon whose tooltip names the starter and whose click reveals it. The markers are kept in `<config dir>/.cck/dispatched.json` (`lib/retention.js`), so they outlive the terminal and a restart, and they expire with the session's transcript (see `docs/retention.md`).

cck has no report channel. The two sessions talk with Claude Code's own `SendMessage`, and the starter writes the report instruction into the spec (`skill-guides/dispatch.md`).

## Flow

```
starter  dispatch start --cwd <dir> --spec-file <f> --name <n> (--child | --group <g>) [--model <m>] [--worktree [n]] [-- <claude args>]
cck      POST /api/dispatch -> terminal.startNew -> {session, cwd, group}
started  SendMessage to the starter, as the spec says
```

- The starter id comes from `CLAUDE_CODE_SESSION_ID` and is stored as `parent`. It links the card back to the starter.
- `POST /api/dispatch` needs the terminal token, which the CLI reads from `<config dir>/.cck/terminal-tokens/<port>.json` for the board it reaches (`CCK_URL`, `PORT`, then `server.json`). Each board writes its own file, so two boards on one config dir do not overwrite each other's token. The started session never holds the token.
- Args after `--` go to `claude` after `--session-id` (`claudeArgsFor` in `lib/terminal.js`). They reach a shell command line inside plain quotes, so `parseNewSpec` refuses a value with a quote, `%` or a control character, more than 64 args, and the flags cck sets or that would not start a new session (`OWNED_FLAGS`). A restored terminal runs `claude --resume <id>` without them.
- `--task-list [id]` (opt-in) sets `CLAUDE_CODE_TASK_LIST_ID` in the PTY env, never on the command line, so the session shares that task list; with no value the CLI sends the starter's own list (`CLAUDE_CODE_TASK_LIST_ID`, else `CLAUDE_CODE_SESSION_ID`). `ptyEnv` strips an inherited value, so no terminal shares a list unless asked. `terminals.json` keeps it as `taskLists: {<id>: <list>}`, so a restored terminal resumes with it.
- A task whose `owner` is the name of a session the list's session started, or of a session mapped to the list in `_task-maps/`, links to that session (`ownerLinks` in `lib/owner-routing.js`, see `docs/session-scanning.md`). A name two of them share gets no link.
- A board move on a list with a task map goes to the linked owner, else to the one `parent` of the list's dispatched sessions, else to no one (`moveRecipients`). A session's own list (a UUID) keeps the old rule: the move goes to that session.
- The running list (`running` of the store in `lib/retention.js`) is the markers in `dispatched.json` whose session has a running cck terminal. A marker keeps `parent`, `name`, `group`, `cwd` and `worktree`, so a session that cck resumes after a restart, or that the user reopens, is in the list again. It feeds the placeholder, `dispatch list` and `dispatch end`. A marker never ends, so a session the user reopens weeks later is again in its starter's `dispatch list`, until the marker expires. When `/clear` or `/resume` moves the terminal to another session id, the marker moves with it (`move`, through the terminal's `onRekey`), so the starter keeps `dispatch end` on the same terminal. Its group membership stays on the old id.
- A resumed starter gets a new `SendMessage` peer name, and `SendMessage` cannot address a session by id. The starter sends each running worker its new name (`skills/dispatch/SKILL.md`).

## Placement

A started session must not jump after it appears, so its place is decided when it starts. The CLI takes exactly one of two flags, and the dispatch skill makes the agent choose: will the result come back to the starter?

- `--child` (yes): the marker gets `child: true`, and the session joins no group. The sidebar renders it in its starter's place, nested under the starter's card, wherever the starter is: a group, a project block of a group, a project block, or Sessions (`computeChildAnchors`, `placementOf` and `nestChildren` in `public/app.js`; `sgGroupForSession` and `sgHostOf` resolve through `placementOf`, so drag, pins, search and reveal agree with the render). It works across projects, so a worktree or another cwd still nests. A child the user places in a group keeps that place. When the starter is not in the shown list (ended, dismissed, filtered out, or on a page not loaded), the child shows in its own project block. The CLI refuses `--child` outside a Claude Code session, and the server refuses it with no `parent` or with a `group`.
- `--group <g>` (no): the session joins that group, as below. It is not nested.

The server API still takes neither, which places the session in its project block; only the CLI insists on a choice.

`POST /api/dispatch` adds the started id to the group (`joinDispatch` in `lib/user-groups.js`) and broadcasts `group:changed` before `dispatch-update`. `dispatch-update` makes the board fetch `GET /api/dispatch` and show a "starting" placeholder in that place until the transcript appears. A new placeholder expands the collapsed sections that would hide it once, and the Recent project filter keeps any session modified in its window, because a new folder is in no recent project until the project list reloads. The real card is a member of the group, so it lands in the same place.

## Transient groups

A dispatch group is a user group in `.cck/groups.json` with `transient: true`.

- `--group` takes a group name (any case), path (`parent/child`) or id. An existing group is joined as it is; the missing steps of the path are made, marked transient. The starter stays where it is, because moving it would jump it under the user.
- The session leaves the group it was in. A grouping error does not fail the dispatch: the response carries `groupError` and the CLI prints it.
- The board deletes a transient group when its Active view shows none of its sessions and none of its child groups stay (`sgSweepTransient` in `public/app.js`). A dismissed session counts as not shown. A session that runs in the terminal or has a placeholder counts as shown, so a group is not deleted before its first card appears. The sweep runs only on a full Active list (no search, no activity filter, all projects or Recent, every page loaded), because a paged or filtered list does not prove a session left.
- **Keep** on the header, a rename (board or `group rename`) or a placement by the user clears the flag, and the group stays like any other.
- `group create --transient` makes transient groups too. A group with no session goes at the board's next sweep, so a script that needs a group to hold its sessions makes it with `dispatch start --group` instead: the swarm's first worker makes the swarm group with itself in it, and the supervisor joins after.
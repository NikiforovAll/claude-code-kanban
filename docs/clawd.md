# Clawd: the board's chat assistant (experimental)

Clawd is a Claude Code session that belongs to the board, not to a project. The user opens it from a button next to the version in the sidebar footer. It runs in a popover over the board, in the same embedded terminal the board uses for sessions.

## What the user sees

- A small clawd glyph left of `v<version>` in the sidebar footer. A click toggles the popover; the – in its header hides it. Hiding drops only the socket: the claude process keeps running, and the next open reattaches to the same screen.
- The popover sits above the footer at the bottom left, 460 × 560 px, capped to the window. It holds one terminal frame (`terminal.html`), on the same frame origin as the board terminal (`terminalFrameOrigin()`), so it gets its own renderer process and handles keys the same way. It also has a header with the name and the session id it resumed.
- × in the header ends the claude process. The next open resumes the same chat.
- In the terminal manager, the Clawd row is named Clawd, and Open opens the popover.
- While Clawd is attached and the popover is open, the board's close guard is on, as for the board terminal: Ctrl+W in a browser tab asks before it closes the page.
- Clawd never shows in the session list, the live feed or the session picker.

## The agent

- The agent lives in `clawd/` at the package root, a plugin dir with one agent, `cck-clawd:clawd` (`clawd/agents/clawd.md`). It moves into the `claude-code-kanban` plugin once it settles, and the flag becomes `--agent claude-code-kanban:clawd`.
- cck starts it with `--plugin-dir <pkg>/clawd --agent cck-clawd:clawd --append-system-prompt-file <clawd folder>/kanban-skill.md`.
- `kanban-skill.md` is the kanban `SKILL.md` without its frontmatter, written on each start: the file flag appends text as is.
- The kanban skill goes in through `--append-system-prompt-file`, because an agent run with `--agent` (the main thread) does not preload the `skills:` of its frontmatter. That was checked with `claude -p`: the skill body was in context only with the file flag.
- `--agent` and the plugin dir belong to the process, so `/clear` keeps Clawd.

## Hidden from the board

- Clawd runs in its own folder, `<config dir>/.cck/clawd`. Every transcript it writes lands in one project folder, `projects/<encoded clawd folder>`, whatever the session id, before and after `/clear`.
- The board skips that project folder: the metadata scan, `resolveSessionFolder` and the projects watcher. A transcript event there updates Clawd's state and broadcasts nothing.
- A skipped folder has no metadata, so the terminal host drops a Clawd PTY at restore instead of resuming it as a plain session.
- Clawd's folder is in the allowed-folder set from startup, so the terminal service accepts it as a cwd.

## Always resume

- `POST /api/clawd/start` (terminal token) returns the running Clawd PTY when there is one.
- If not, it resumes the newest transcript in the Clawd project folder (`claude --resume <id>` plus the agent flags), else it starts a new session. `/clear` writes a new transcript there, so the next start resumes the chat after the clear.
- The projects watcher keeps the current id: an `add` or `change` in the folder sets it. The start response carries it.
- When claude exits (`/exit`), the popover does not restart it. The next open resumes. A dropped socket with claude still running reconnects after 1 s.
- The terminal service takes `resume` in a new-session spec: `--resume <id>` in place of `--session-id`. The PTY keeps its own id, as it does after `/clear`.

## Ambient context

- The board posts the session on screen to `POST /api/clawd/context` when it changes. It posts only after Clawd was opened in this page.
- `GET /api/clawd/context` answers `{sessionId, project, name, gitBranch, transcript, updatedAt}`, with the name and branch the board shows.
- A `UserPromptSubmit` hook in the plugin (`clawd/hooks/focus.js`) reads the route before each message and adds a `Focused session:` line to it, only when the focused session changed since the last message of this chat. It keeps the last one in `<clawd folder>/focus-seen.txt` and sends it as `?seen=`; the route answers 204 when the focus is the same, before it reads any session metadata. A a `SessionStart` hook after a compact deletes that file, because the summary may drop the line. A board that does not answer adds nothing.
- The board posts from `updateUrl()`, the one place every session or project switch passes through.
- With two boards on one server, the last post wins.

## Turning it off

- `{"clawd": {"enabled": false}}` in `<config dir>/.cck/config.json` hides the button and makes the `/api/clawd*` routes answer 404. The file is read by mtime, like `boardEvents`, so no restart is needed. A page that is already open hides the button on its next config read.
- Clawd needs the embedded terminal. When the terminal is off, the button is hidden.

## Performance

- Footer button: one element, rendered with the footer. No polling.
- On demand only: the first open starts one claude process and loads one terminal frame. The frame stays loaded until the page closes.
- Session switch: one small POST, only after Clawd was opened.
- Each Clawd message: one node start and one local GET in the hook, and one context line when the focus changed.
- Watcher and scans: one string compare per project folder and per transcript event.

## Not in the POC

- No keyboard shortcut. Esc goes to the terminal.
- No hub-level assistant. The hub can frame the same route later.

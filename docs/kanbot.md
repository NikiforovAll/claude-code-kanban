# Kanbot: the board's chat assistant (experimental)

Kanbot is a Claude Code session that belongs to the board, not to a project. The user opens it from a button next to the version in the sidebar footer. It runs in a popover over the board, in the same embedded terminal the board uses for sessions.

## What the user sees

- A small clawd glyph left of `v<version>` in the sidebar footer. A click toggles the popover; the – in its header hides it. Hiding drops only the socket: the claude process keeps running, and the next open reattaches to the same screen.
- The popover sits above the footer at the bottom left, 460 × 560 px, capped to the window. It holds one terminal frame (`terminal.html`), on the same frame origin as the board terminal (`terminalFrameOrigin()`), so it gets its own renderer process and handles keys the same way. It also has a header with the name and the session id it resumed.
- The dock button (after –) docks the popover as a full-height panel on the right edge, where the session log opens. Drag its left edge to resize it (320 px minimum). The layout and the docked width are kept in `localStorage` (`cck-kanbot-layout`, `cck-kanbot-width`). Docked and expanded rule each other out.
- The expand button in the header (between dock and ×) expands the popover to a centered panel, up to 1200 px wide and the window's height less 96 px; pressed again, it restores it. The terminal refits through the frame's `ResizeObserver`.
- × in the header ends the claude process. The next open resumes the same chat.
- In the terminal manager, the Kanbot row is named Kanbot, and Open opens the popover.
- While Kanbot is attached and the popover is open, the board's close guard is on, as for the board terminal: Ctrl+W in a browser tab asks before it closes the page.
- Kanbot never shows in the session list, the live feed or the session picker.

## The agent

- The agent lives in `kanbot/` at the package root, a plugin dir with one agent, `cck-kanbot:kanbot` (`kanbot/agents/kanbot.md`). It moves into the `claude-code-kanban` plugin once it settles, and the flag becomes `--agent claude-code-kanban:kanbot`.
- cck starts it with `--plugin-dir <pkg>/kanbot --agent cck-kanbot:kanbot --append-system-prompt-file <kanbot folder>/cli-help.md --add-dir <config dir>`.
- `cli-help.md` holds the board's URL and the CLI's top-level help (`topHelp()` in `cli.js`), written on each start. Kanbot reads `claude-code-kanban help <command> <subcommand>` for the details on demand. The URL is the one the PTY gets as `$CCK_URL`, which the CLI uses.
- Kanbot is a general assistant: it answers, searches and reads code and transcripts. Work that changes a project it hands to a new session: it suggests the project folder and a prompt, and starts it with the dispatch skill when the user agrees.
- `memory: project` in the frontmatter gives Kanbot its own memory in `<kanbot folder>/.claude/agent-memory/cck-kanbot-kanbot/`. The agent prompt replaces the default system prompt, so Claude Code's auto memory is not in it; agent memory is.
- `--agent` and the plugin dir belong to the process, so `/clear` keeps Kanbot.
- `color: orange` in the agent's frontmatter colors the agent in claude's own UI. The name keeps clear of Claude Code's mascot, Clawd; the footer glyph still uses the clawd shape.

## Hidden from the board

- Kanbot runs in its own folder, `<config dir>/.cck/kanbot`. Every transcript it writes lands in one project folder, `projects/<encoded kanbot folder>`, whatever the session id, before and after `/clear`.
- The board skips that project folder: the metadata scan, `resolveSessionFolder` and the projects watcher. A transcript event there updates Kanbot's state and broadcasts nothing.
- A skipped folder has no metadata, so the terminal host drops a Kanbot PTY at restore instead of resuming it as a plain session.
- Kanbot's folder is in the allowed-folder set from startup, so the terminal service accepts it as a cwd.

## Always resume

- `POST /api/kanbot/start` (terminal token) returns the running Kanbot PTY when there is one.
- If not, it resumes the newest transcript in the Kanbot project folder (`claude --resume <id>` plus the agent flags), else it starts a new session. `/clear` writes a new transcript there, so the next start resumes the chat after the clear.
- The projects watcher keeps the current id: an `add` or `change` in the folder sets it. The start response carries it.
- When claude exits (`/exit`), the popover does not restart it. The next open resumes. A dropped socket with claude still running reconnects after 1 s.
- The terminal service takes `resume` in a new-session spec: `--resume <id>` in place of `--session-id`. The PTY keeps its own id, as it does after `/clear`.

## Model

- `{"kanbot": {"model": "sonnet"}}` in `<config dir>/.cck/config.json` starts Kanbot with `--model sonnet`. The value is one of `fable`, `opus`, `sonnet` or `haiku`, the same list the new-session dialog takes; any other value is ignored and claude uses its own default.
- The server reads it on each start, so it applies from the next start: press × and reopen. `/model` in the chat changes it for the running process only.

## Turning it off

- `{"kanbot": {"enabled": false}}` in `<config dir>/.cck/config.json` hides the button and makes the `/api/kanbot*` routes answer 404. The file is read by mtime, like `boardEvents`, so no restart is needed. A page that is already open hides the button on its next config read.
- Kanbot needs the embedded terminal. When the terminal is off, the button is hidden.

## Performance

- Footer button: one element, rendered with the footer. No polling.
- On demand only: the first open starts one claude process and loads one terminal frame. The frame stays loaded until the page closes.
- Watcher and scans: one string compare per project folder and per transcript event.

## Not in the POC

- No session on screen. Kanbot cannot see which session the board shows: the page would have to post it to a server route. The user names the session, and Kanbot finds it with `session search`.
- No keyboard shortcut. Esc goes to the terminal.
- No hub-level assistant. The hub can frame the same route later.

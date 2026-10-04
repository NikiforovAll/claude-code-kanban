# CLAUDE.md

## Project

**claude-code-kanban** — Real-time Kanban dashboard for Claude Code tasks. Express + chokidar + vanilla JS. Zero build step. Published as `claude-code-kanban` (npm).

## Commands

```bash
npm start            # port 3541
npm run dev          # start + open browser
```

Also: `npm test` (node test runner over `test/*.test.js`), `claude plugin test .` in `plugin/plugins/claude-code-kanban` (the mod's tests), `npm run validate:schemas`, and Biome for lint (`biome.json`). No build step.

Biome covers `public/app.js`, `public/project-match.js`, `public/link-url.js`, `public/style.css`, `server.js`, `cli.js`, `install.js` and `lib/`, and the pre-commit hook and CI run `biome check` over all of them. The server files are lint-only (an override), because the formatter would rewrite thousands of lines for no benefit. `package.json` sets `"type": "commonjs"` so Biome parses `.js` as script; without it Biome reads the files as modules and flags every `'use strict'` as redundant. Biome rejects a top-level `return`, so server.js runs its body through `startServer()` instead; the body is left unindented.

You have an access to gh cli to work on this project: https://github.com/NikiforovAll/claude-code-kanban

To work on pr use `gh pr checkout <pr-number>` and `gh pr view <pr-number>` to see description and files changed.

## Architecture

```
server.js           Express + chokidar watchers + SSE (`#region` blocks)
public/index.html   HTML structure
public/style.css    All CSS (`#region` blocks)
public/app.js       All JS (`#region` blocks)
public/terminal.html, public/terminal-frame.js  Embedded terminal frame: xterm + its WebSocket
lib/session-events.js  Session event doorbell: queue, long-poll handler, line format
```

**Data flow:** task JSON files → chokidar → SSE → REST fetch → Kanban render (JSON diff to skip no-ops)

**Server:** 3 chokidar watchers (tasks/teams/projects) · SSE broadcasts · REST API · session cache (10s TTL) · port fallback

**Frontend:** sidebar (sessions, filters, live feed) · kanban board · task detail panel · SSE debounced (500ms tasks, 2s metadata capped at 5s) · paused while off screen (`hub:active`, see `docs/session-scanning.md`)

**CDN deps:** marked.js, DOMPurify, highlight.js. Fonts are bundled in `public/fonts/`.

## Conventions

- **Claude Code owns task state** — the dashboard reads it. The one exception is the session event doorbell: moving a card enqueues a line for every session the task dir maps to (`resolveSessionsForTaskDir`, shared with the SSE broadcast), carrying the new status plus the card subject and description (`lib/session-events.js`), which the plugin's postman monitor prints into that session as a notification. That monitor is armed by `on-skill-invoke:claude-code-kanban:follow` (the arm matcher is exact equality against the namespaced skill id the dispatcher emits), not at session start, so the board can only speak to a session whose user asked for it; its first attach discards any backlog, because a stale move read as an instruction is worse than a missed one. The board also lets the user add a pending task (`POST /api/tasks/:sessionId`, the ADD_TASK region), which is creation rather than a state change and rings no doorbell -- the user typing it already knows. So the board never drives task *status* on its own but is a command channel to the *agent* — see the `follow` skill for how a move is read, and `kanban` for the board verbs. Review comments ride the same channel: the REVIEW region (`POST /api/sessions/:id/review`) writes the batch to `.cck/reviews/<sid>/` and rings a line pointing at it when a postman is waiting, else pastes a pointer into the session's embedded terminal without Enter (terminal token, not while it waits on the user), else the client copies the markdown. The client annotator (`mountReview`) takes any element plus a `{kind, label, path?}` source, so a new view needs no server change; comments list in a right-side panel that widens the dialog. Claude's replies in the message detail modal take comments too (`mountReplyReview`, kind `reply`, main session only): the batch carries quotes only, because the agent has the reply in context, and the first comment stops follow-latest so a new message does not replace the reply under review. An HTML preview is annotated through `reviewBridge`, a script appended to the iframe's `srcdoc` that talks `cck-review:` postMessages and cites the element and its CSS selector
- **The board can start sessions** — `dispatch start` (the `dispatch` skill) has cck start a Claude Code session in its embedded terminal, behind the terminal token (`lib/dispatch.js`). It is a thin wrapper: args after `--` go to `claude` as they are. A started session is an ordinary session, not a child: the board shows no tree, only a send icon on its card (`.cck/dispatched.json`). Its placement is fixed from the first frame by a transient group (`lib/dispatch-groups.js`, `.cck/dispatch-groups.json`) and a placeholder from `dispatch-update`, so it never jumps into a group later. cck carries no report: the sessions talk with Claude Code's `SendMessage`, as the spec says. See `docs/dispatch.md`
- **The terminal runs in its own renderer process** — the board's TERMINAL region does not hold xterm. It frames `public/terminal.html` from its other loopback name (`terminalFrameOrigin`), a different site, so Chrome gives the frame its own process and typing, output and flow-control acks never wait behind board work (`lib/terminal.js` pauses the PTY above 128 KB unacked). If the frame does not answer in 5 s, the board loads it same-origin for the rest of the page's life. The board keeps every decision (when to open, retries, prompts, focus); the frame keeps xterm and the socket. They talk `cck-term:` postMessages (`onTerminalFrameMessage` in the board, `onMessage` in the frame), each side checking source and origin. Keys the board acts on reach it as claims (`{keys, forward}`): `terminalClaims()` probes `terminalShortcut` over `TERMINAL_PROBE_KEYS`, and `forward` is `hub.forwardCombos()`, which the frame matches with the SDK's `ClaudeHub.comboOf` (`terminal.html` loads the SDK script for it). The frame hands a claimed press back, and the board replays it on `#terminal-key-proxy`, so a new terminal shortcut needs no frame change. Any state a shortcut reads must call `pushTerminalClaims()` when it changes. Chrome shows a crashed frame as a sad face and never reloads it, so the frame answers each `open` with `opening`; no answer in 5 s drops the frame and opens again. The frame tells the board when xterm takes focus (`focused`), because a click in another process fires no `focusin` in the board. Standalone, net-guard's `selfFramedPaths` lets the board's two names frame `/terminal.html`; it denies all other framing. net-guard's `isLoopbackAddress` accepts the bracketed `[::1]` Origin, and `listenLoopback` treats a port that another process holds on the other family as busy, because that process would answer the frame's name
- **Parser changes → update `docs/session-scanning.md`** — any change to `lib/parsers.js` or to the session-list hot path (`buildSessionObject`, `loadSessionMetadata`, the watchers, or any cache feeding them) must keep that doc current. It tracks the hot-path rule ("no full-JSONL reads in `buildSessionObject`"), per-function cache strategies, and watcher wiring. If you add, remove, or change a parser entry-point or its cache, update the doc in the same change.
- **State under `.cck/` must be bounded → `docs/retention.md`** — per-session state cck writes expires with the session's transcript or Claude Code's `cleanupPeriodDays`, in the hourly `runRetention()` sweep. A new store follows the same rule and is added to that doc.
- **Session state changes → update `docs/session-states.md`** — it maps the server signals (`hasRecentLog`, `hasRecentActivity`, agents, waiting) and their windows to the Active filter, the sidebar card classes (`warm`, `idle`, `stale`) and the picker dots. A change to any of them updates the doc in the same change.
- **XSS safety** — `escapeHtml()` for user data, `DOMPurify.sanitize(marked.parse(...))` for markdown. The one exception is the HTML file preview: it is rendered as authored inside an `<iframe sandbox="allow-scripts allow-popups">` (no `allow-same-origin`), so it stays on an opaque origin instead of being sanitized. `srcdoc` has no base URL, so `lib/inline-assets.js` embeds the document's local stylesheets, scripts and images server-side before it is sent (`readPreviewFile`); remote refs are left to resolve on their own
- **Optional external tools** — a linked `scratchpad.json` opens in the `scratch` CLI's viewer (`POST /api/scratchpad/open`). `scratch` is not a package dependency: `whichSync` probes PATH, `/api/config` reports `scratchAvailable`, and the row falls back to the editor when it is missing. Any future external binary should degrade the same way
- **No framework** — multi-file vanilla JS, CSS variables for dark/light theming
- **`#region` markers** — VS Code foldable `#region`/`#endregion` blocks in `public/app.js`, `public/style.css` and `server.js`

### Navigating with regions

List every region in a file: `rg "#region" server.js public/app.js public/style.css`. The markers are the map; this doc deliberately does not copy the list, because a copied list drifts.

Find one region: `rg "#region KANBAN" public/`. Read it whole: find `#region`, read until `#endregion`.

When modifying a feature, open **both** the JS region and the matching CSS region (names often match: KANBAN, MESSAGE_PANEL, etc).

**Regions are a reading order, not a partition.** Measured against feature keywords, only about half of a feature's lines sit in the region named after it — `preview` is 98% inside PREVIEW, but `pin` is spread over 11 regions. So grep for the symbol first; reach for the region list when you don't yet know the symbol, when you need to read a subsystem end to end, or when you are deciding where new code belongs. A region is the right home for new code when its name already describes the change.

## CLI

Subcommands live in a dispatch table in `cli.js` (`COMMANDS`). `server.js` delegates to `runCli(process.argv)` from `cli.js`. Help is generated from the table, one level at a time: `--help` lists the commands, `help <cmd>` its subcommands, `help <cmd> <sub>` (or `<cmd> <sub> --help`) the flags, notes and examples. There is no manual help text to maintain.

**The help is the CLI reference.** The plugin skills point at it instead of listing flags, so a command change needs no skill change. **Every new command MUST be documented in the dispatch table** with `summary`, `usage`, `flags` (if any), and 1–2 `examples` where they help. The design contract for the CLI lives in `_plans/cli-scope.md`.

The CLI finds the server through `CCK_URL`, then `PORT`, then `<config dir>/.cck/server.json`, then 3541. A `server.json` whose pid is dead is an error, not a fallback, because 3541 can be another config dir's board. The embedded terminal sets `CCK_URL` to its own board (`ptyEnv` in `lib/terminal.js`), so a session started there, and its postman monitor, reach that board even when another board on the same config dir owns `server.json`. Each board writes its terminal token to `.cck/terminal-tokens/<port>.json`, and `dispatch start` reads the file for the port it reaches.

Adding a command:

1. Add an entry to `COMMANDS` in `cli.js` with `summary`, `usage`, `flags`, optional `notes` and `examples`, and `run(args)`. Missing arguments print the leaf help and return 1; a bad value goes through `usageError`.
2. The `run` function receives `process.argv.slice(3)` (or `slice(4)` for nested verbs) and returns an exit code.
3. Add a server endpoint in `server.js` that broadcasts an SSE event (`{ type: '<noun>:<verb>', ... }`). A read-only command reuses a GET route and needs no event.
4. Handle the event in `public/app.js` SSE dispatcher.

Test locally: start the server (`npm start`), then run `node server.js <command>` from another terminal.

## KanbanBot (Agentic Workflow)

- KanbanBot is an automated repository assistant running as a GitHub Agentic Workflow
- PRs from KanbanBot have `[KanbanBot]` title prefix and `automation`/`kanbanbot` labels
- KanbanBot uses persistent repo memory on `memory/kanbanbot` branch
- To trigger on-demand: comment `/kanbanbot <instructions>` on any issue or PR
- Workflow spec: `.github/workflows/kanbanbot.md`
- Domain knowledge: `.github/agents/kanban-expert.agent.md`

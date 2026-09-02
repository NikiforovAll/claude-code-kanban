# CLAUDE.md

## Project

**claude-code-kanban** — Real-time Kanban dashboard for Claude Code tasks. Express + chokidar + vanilla JS. Zero build step. Published as `claude-code-kanban` (npm).

## Commands

```bash
npm start            # port 3541
npm run dev          # start + open browser
```

Also: `npm test` (node test runner over `test/*.test.js`), `npm run test:hooks` (`tests/test-agent-spy.sh`), `npm run validate:schemas`, and Biome for lint (`biome.json`). No build step.

You have an access to gh cli to work on this project: https://github.com/NikiforovAll/claude-code-kanban

To work on pr use `gh pr checkout <pr-number>` and `gh pr view <pr-number>` to see description and files changed.

## Architecture

```
server.js           Express + chokidar watchers + SSE
public/index.html   HTML structure
public/style.css    All CSS (`#region` blocks)
public/app.js       All JS (`#region` blocks)
lib/session-events.js  Session event doorbell: queue, long-poll handler, line format
```

**Data flow:** task JSON files → chokidar → SSE → REST fetch → Kanban render (JSON diff to skip no-ops)

**Server:** 3 chokidar watchers (tasks/teams/projects) · SSE broadcasts · REST API · session cache (10s TTL) · port fallback

**Frontend:** sidebar (sessions, filters, live feed) · kanban board · task detail panel · SSE debounced (500ms tasks, 2s metadata)

**CDN deps:** marked.js, DOMPurify, highlight.js, Google Fonts

## Conventions

- **Claude Code owns task state** — the dashboard reads it. The one exception is the session event doorbell: moving a card enqueues a line for every session the task dir maps to (`resolveSessionsForTaskDir`, shared with the SSE broadcast), carrying the new status plus the card subject and description (`lib/session-events.js`), which the plugin's postman monitor prints into that session as a notification. That monitor is armed by `on-skill-invoke:claude-code-kanban:kanban-follow` (the arm matcher is exact equality against the namespaced skill id the dispatcher emits), not at session start, so the board can only speak to a session whose user asked for it; its first attach discards any backlog, because a stale move read as an instruction is worse than a missed one. The board also lets the user add a pending task (`POST /api/tasks/:sessionId`, the ADD_TASK region), which is creation rather than a state change and rings no doorbell -- the user typing it already knows. So the board never drives task *status* on its own but is a command channel to the *agent* — see the `kanban-follow` skill for how a move is read, and `kanban` for the board verbs
- **Parser changes → update `docs/session-scanning.md`** — any change to `lib/parsers.js` or to the session-list hot path (`buildSessionObject`, `loadSessionMetadata`, the watchers, or any cache feeding them) must keep that doc current. It tracks the hot-path rule ("no full-JSONL reads in `buildSessionObject`"), per-function cache strategies, and watcher wiring. If you add, remove, or change a parser entry-point or its cache, update the doc in the same change.
- **XSS safety** — `escapeHtml()` for user data, `DOMPurify.sanitize(marked.parse(...))` for markdown. The one exception is the HTML file preview: it is rendered as authored inside an `<iframe sandbox="allow-scripts allow-popups">` (no `allow-same-origin`), so it stays on an opaque origin instead of being sanitized. `srcdoc` has no base URL, so `lib/inline-assets.js` embeds the document's local stylesheets, scripts and images server-side before it is sent (`readPreviewFile`); remote refs are left to resolve on their own
- **Optional external tools** — a linked `scratchpad.json` opens in the `scratch` CLI's viewer (`POST /api/scratchpad/open`). `scratch` is not a package dependency: `whichSync` probes PATH, `/api/config` reports `scratchAvailable`, and the row falls back to the editor when it is missing. Any future external binary should degrade the same way
- **No framework** — multi-file vanilla JS, CSS variables for dark/light theming
- **`#region` markers** — VS Code foldable `#region`/`#endregion` blocks in `app.js` and `style.css`

### Navigating with regions

Find a region: `rg "#region KANBAN" public/`. Read a full region: find `#region`, read until `#endregion`.

When modifying a feature, open **both** the JS region and the matching CSS region (names often match: KANBAN, MESSAGE_PANEL, etc).

List every region in a file: `rg "#region" public/app.js public/style.css`. The markers are the map; this doc deliberately does not copy the list, because a copied list drifts.

## CLI

Subcommands live in a dispatch table in `cli.js` (`COMMANDS`). `server.js` delegates to `runCli(process.argv)` from `cli.js`. Help (`--help`, `-h`, `help <cmd>`) is generated from the table — there is no manual help text to maintain.

**Every new command MUST be documented in the dispatch table** with `summary`, `usage`, and (if applicable) `flags`. The design contract for the CLI lives in `_plans/cli-scope.md`.

Adding a command:

1. Add an entry to `COMMANDS` in `cli.js` with `summary`, `usage`, optional `flags`, and `run(args)`.
2. The `run` function receives `process.argv.slice(3)` (or `slice(4)` for nested verbs) and returns an exit code.
3. Add a server endpoint in `server.js` that broadcasts an SSE event (`{ type: '<noun>:<verb>', ... }`).
4. Handle the event in `public/app.js` SSE dispatcher.

Test locally: start the server (`npm start`), then run `node server.js <command>` from another terminal.

## KanbanBot (Agentic Workflow)

- KanbanBot is an automated repository assistant running as a GitHub Agentic Workflow
- PRs from KanbanBot have `[KanbanBot]` title prefix and `automation`/`kanbanbot` labels
- KanbanBot uses persistent repo memory on `memory/kanbanbot` branch
- To trigger on-demand: comment `/kanbanbot <instructions>` on any issue or PR
- Workflow spec: `.github/workflows/kanbanbot.md`
- Domain knowledge: `.github/agents/kanban-expert.agent.md`

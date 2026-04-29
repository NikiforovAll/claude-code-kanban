# CLAUDE.md

## Project

**claude-code-kanban** — Real-time Kanban dashboard for Claude Code tasks. Express + chokidar + vanilla JS. Zero build step. Published as `claude-code-kanban` (npm).

## Commands

```bash
npm start            # port 3456
npm run dev          # start + open browser
```

No build/lint/test commands.

You have an access to gh cli to work on this project: https://github.com/NikiforovAll/claude-code-kanban

To work on pr use `gh pr checkout <pr-number>` and `gh pr view <pr-number>` to see description and files changed.

## Architecture

```
server.js           Express + chokidar watchers + SSE
public/index.html   HTML structure (~570 lines)
public/style.css    All CSS (~2510 lines)
public/app.js       All JS (~3520 lines)
```

**Data flow:** task JSON files → chokidar → SSE → REST fetch → Kanban render (JSON diff to skip no-ops)

**Server:** 3 chokidar watchers (tasks/teams/projects) · SSE broadcasts · REST API · session cache (10s TTL) · port fallback

**Frontend:** sidebar (sessions, filters, live feed) · kanban board · task detail panel · SSE debounced (500ms tasks, 2s metadata)

**CDN deps:** marked.js, DOMPurify, highlight.js, Google Fonts

## Conventions

- **Read-only observer** — Claude Code owns task state, dashboard only reads
- **XSS safety** — `escapeHtml()` for user data, `DOMPurify.sanitize(marked.parse(...))` for markdown
- **No framework** — multi-file vanilla JS, CSS variables for dark/light theming
- **`#region` markers** — VS Code foldable `#region`/`#endregion` blocks in `app.js` and `style.css`

### Navigating with regions

Find a region: `rg "#region KANBAN" public/`. Read a full region: find `#region`, read until `#endregion`.

When modifying a feature, open **both** the JS region and the matching CSS region (names often match: KANBAN, MESSAGE_PANEL, etc).

**app.js regions:**

| Region | What lives here |
|--------|----------------|
| STATE | Global variables, URL state, reset logic |
| DOM | Cached DOM element references |
| DATA_FETCHING | `fetchSessions()`, `fetchTasks()`, `fetchAgents()`, `fetchMessages()` |
| BULK_DELETE | Session-wide task deletion, topological sort |
| LIVE_UPDATES | Active task ticker in sidebar |
| MESSAGE_PANEL | Message log panel: toggle, render, latest message |
| PINNING | Message/session/agent pin/unpin logic, localStorage |
| MODALS | Message detail modal, fullscreen toggle |
| TOAST | Toast notification display |
| TOOL_RENDERING | Tool call params/result HTML rendering |
| AGENTS | Agent footer, agent modal, dismiss/copy |
| RENDERING | `showAllTasks()`, `renderAllTasks()`, `renderSessions()`, `renderSession()`, `renderTaskCard()` |
| KANBAN | `renderKanban()` — column layout, counts, empty states |
| DRAG_DROP | Card drag start/end, column drop to change task status |
| KEYBOARD_NAV | Arrow key navigation: task selection, session list, focus zones |
| TASK_DETAIL | `showTaskDetail()`, inline editing (title, description), notes, blocked-by |
| DELETE_TASK | Single task delete with confirmation modal |
| HELP | Help modal with keyboard shortcut reference |
| SCRATCHPAD | Scratchpad modal: toggle, save, auto-save, per-session localStorage |
| KEYBOARD_SHORTCUTS | `matchKey()`, global `keydown` handler, all hotkeys |
| SSE | `setupEventSource()`, reconnect, debounced refresh |
| CONTEXT_WINDOW | Model thresholds, token bar, cost color, context detail panel |
| UTILS | `formatDate()`, `stripAnsi()`, `escapeHtml()`, `renderMarkdown()`, `getOwnerColor()` |
| FILTERS | Session filter (active/all), session limit, project filter dropdown |
| EVENT_DELEGATION | Click handlers for project group collapse/expand |
| THEME | Dark/light toggle, hljs theme sync, `localStorage` persistence |
| SIDEBAR_LAYOUT | Collapse/expand sidebar, drag-resize sidebar and panels |
| PREFERENCES | Load saved filter/limit/project from `localStorage` |
| SESSION_INFO | Session info modal: metadata grid, team config, plan |
| PLAN | Plan viewer modal, refresh, open-in-editor |
| OWNER_FILTER | Per-owner task filter in kanban header |
| LAYOUT_SYNC | ResizeObserver to sync sidebar/view header heights |
| PWA | Service worker registration |
| INIT | Boot sequence: load theme → load state → setup SSE → first fetch |

**style.css regions:**

| Region | What it styles |
|--------|---------------|
| VARIABLES | CSS custom properties (colors, fonts) |
| RESET · SCROLLBAR · LAYOUT | Box model reset, scrollbar, flex app shell |
| SIDEBAR · SIDEBAR_SECTIONS | Sidebar chrome, collapse, filter dropdowns |
| LIVE_UPDATES | Active task ticker styles |
| SESSIONS | Session cards, progress bars, status badges |
| FOOTER | Sidebar footer |
| MAIN · EMPTY_STATE · SESSION_VIEW | Main content area, placeholder, session wrapper |
| HEADER | View header bar, icon buttons |
| KANBAN | Column grid, column headers, empty column state |
| TASK_CARD | Card layout, status border, badges, description preview |
| DETAIL_PANEL | Side panel: fields, markdown, dependency chips |
| NOTE_FORM | Add-note textarea and submit button |
| TEAM_BADGE · OWNER_BADGE · TEAM_MODAL | Team/owner indicators, team member cards |
| OWNER_FILTER | Kanban overlay filter bar |
| MESSAGE_PANEL | Message log: bubbles, roles, tool blocks |
| AGENT_FOOTER | Agent status bar, expand/collapse |
| PERMISSION_PENDING | Pulsing permission badge |
| LIGHT_THEME | Light-mode variable overrides |
| INTERACTIVE | Delete hover, column header buttons |
| SEARCH | Search input, clear button |
| MODAL | Overlay, dialog, buttons, toast |
| SCRATCHPAD | Scratchpad modal textarea and footer styles |
| A11Y | Skip-link, visually-hidden |
| MEDIA_QUERIES | `prefers-color-scheme` auto-detection |
| ANIMATIONS | Card fade-in, connection breathing, progress shimmer |
| PROJECT_GROUPS | Collapsible project headers in session list |

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

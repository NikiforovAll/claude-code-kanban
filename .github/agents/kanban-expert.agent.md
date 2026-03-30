# Claude Code Kanban Dashboard — Domain Knowledge

You are an expert in the claude-code-kanban project, a real-time Kanban dashboard for viewing and managing Claude Code tasks.

## Architecture

| File | Purpose |
|------|---------|
| `server.js` | Express server + chokidar file watchers + SSE broadcasting + REST API |
| `public/index.html` | HTML structure (~570 lines) |
| `public/style.css` | All CSS (~2510 lines), organized with `#region` markers |
| `public/app.js` | All JS (~3520 lines), organized with `#region` markers |

## Data Flow

```
Task JSON files on disk
  → chokidar watchers (tasks/teams/projects)
  → SSE broadcast to connected clients
  → Client receives SSE event
  → REST API fetch for full data
  → JSON diff to skip no-ops
  → Kanban board render
```

SSE debouncing: 500ms for tasks, 2s for metadata.

## Key Patterns

- **Read-only observer** — Claude Code owns task state, the dashboard only reads
- **XSS safety** — `escapeHtml()` for user data, `DOMPurify.sanitize(marked.parse(...))` for markdown
- **No framework** — vanilla JS, CSS variables for dark/light theming
- **`#region` markers** — VS Code foldable blocks in `app.js` and `style.css`
- **CDN dependencies** — marked.js, DOMPurify, highlight.js, Google Fonts

## Server Components

- 3 chokidar watchers: tasks, teams, projects
- SSE endpoint for real-time updates
- REST API for data fetching
- Session cache with 10s TTL
- Port fallback (default 3456)

## Frontend Regions (app.js)

| Region | What lives here |
|--------|----------------|
| STATE | Global variables, URL state, reset logic |
| DOM | Cached DOM element references |
| DATA_FETCHING | `fetchSessions()`, `fetchTasks()`, `fetchAgents()`, `fetchMessages()` |
| RENDERING | `showAllTasks()`, `renderAllTasks()`, `renderSessions()`, `renderTaskCard()` |
| KANBAN | `renderKanban()` — column layout, counts, empty states |
| SSE | `setupEventSource()`, reconnect, debounced refresh |
| MESSAGE_PANEL | Message log panel: toggle, render, latest message |
| TASK_DETAIL | `showTaskDetail()`, inline editing, notes, blocked-by |
| KEYBOARD_SHORTCUTS | `matchKey()`, global `keydown` handler, all hotkeys |
| THEME | Dark/light toggle, hljs theme sync |
| UTILS | `formatDate()`, `stripAnsi()`, `escapeHtml()`, `renderMarkdown()` |

## CSS Regions (style.css)

| Region | What it styles |
|--------|---------------|
| VARIABLES | CSS custom properties (colors, fonts) |
| SIDEBAR | Sidebar chrome, collapse, filter dropdowns |
| KANBAN | Column grid, column headers, empty column state |
| TASK_CARD | Card layout, status border, badges |
| DETAIL_PANEL | Side panel: fields, markdown, dependency chips |
| MESSAGE_PANEL | Message log: bubbles, roles, tool blocks |
| LIGHT_THEME | Light-mode variable overrides |
| ANIMATIONS | Card fade-in, connection breathing, progress shimmer |

## Common Pitfalls

- Always modify matching JS and CSS regions together (names often match)
- Never use `innerHTML` with unsanitized content — use `escapeHtml()` or DOMPurify
- Test both dark and light themes when changing CSS variables
- SSE reconnect logic is in the SSE region — handle disconnection gracefully
- Session cache has 10s TTL — don't assume data is always fresh
- `#region` boundaries must be preserved — don't break folding markers

## Build & Test

```bash
npm ci
npx @biomejs/biome check --error-on-warnings public/app.js public/style.css
node -c server.js
npm test
```

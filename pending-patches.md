# Pending Patches - KanbanBot

These patches were prepared but could not be pushed as PRs due to safeoutputs MCP server failure.

## Patch 1: eng-pin-biome-devdep-20260426 (Attempt 7)

Title: [KanbanBot] eng: pin @biomejs/biome as devDependency, add npm run lint script
Closes: #34
Tests: 79/79 pass, lint clean
Branch: kanbanbot/eng-pin-biome-devdep-20260426

Changes to package.json:
- Add `"@biomejs/biome": "^2.4.13"` to devDependencies
- Add `"lint": "npx @biomejs/biome check --error-on-warnings public/app.js public/style.css"` script
- package-lock.json updated accordingly

## Patch 2: improve-missing-css-vars-20260425 (Attempt 1)

Title: [KanbanBot] fix: define missing --info and --danger CSS custom properties
Tests: 79/79 pass, lint clean
Branch: kanbanbot/improve-missing-css-vars-20260425

Changes to public/style.css:
- Add `--info: #60a5fa` and `--danger: #ef4444` to :root (dark theme)
- Add `--info: #2563eb` and `--danger: #dc2626` to body.light (light theme)
- Remove `#e55` fallback from `var(--danger, #e55)` on `.pinned-item-unpin:hover`

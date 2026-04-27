# Pending Patches - KanbanBot

These patches were prepared but could not be pushed as PRs due to safeoutputs MCP server failure.

## Patch 1: eng-pin-biome-devdep-20260427 (Attempt 8)

Title: [KanbanBot] eng: pin @biomejs/biome as devDependency, add npm run lint script
Closes: #34
Tests: 79/79 pass, lint clean
Branch: kanbanbot/eng-pin-biome-devdep-20260427 (LOCAL ONLY - not pushed to remote)

Changes to package.json:
- Add `"@biomejs/biome": "^2.4.13"` to devDependencies
- Add `"lint": "npx @biomejs/biome check --error-on-warnings public/app.js public/style.css"` script
- package-lock.json updated accordingly

Note: Previous attempts on branches kanbanbot/eng-pin-biome-devdep-20260407-c63b102d9635ea37 (remote)
and kanbanbot/eng-pin-biome-devdep-20260426 (local-only) were also blocked by same issue.

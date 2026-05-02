# Pending Patches - KanbanBot

These patches were prepared but could not be pushed as PRs due to safeoutputs MCP server failure.

## Patch 1: eng-lint-smoke-20260502 (Attempt 1)

Title: [KanbanBot] eng: add npm run lint script, extend syntax check, fix fragile smoke test
Tests: 79/79 pass, lint clean
Branch: kanbanbot/eng-lint-smoke-20260502 (LOCAL ONLY - not pushed to remote)

Changes:
- Add `"lint": "biome check --error-on-warnings public/app.js public/style.css"` to package.json scripts
- Update CI lint step to use `npm run lint` 
- Extend CI syntax check: `node -c server.js && node -c cli.js && node -c install.js && node -c lib/parsers.js`
- Fix smoke test: replace `sleep 2` with 15-iteration retry loop (1s each), capture SERVER_PID explicitly

## Patch 2: improve-danger-css-var-20260502 (Attempt 1)

Title: [KanbanBot] css: add --danger CSS variable, replace hardcoded #ef4444 values
Tests: 79/79 pass, lint clean
Branch: kanbanbot/improve-danger-css-var-20260502 (LOCAL ONLY - not pushed to remote)

Changes:
- Add `--danger: #ef4444` and `--danger-dim: rgba(239, 68, 68, 0.15)` to VARIABLES region
- Replace all 6 hardcoded `#ef4444` occurrences with `var(--danger)` or `var(--danger-dim)`
- Closes gap where app.js line 1601 already referenced `var(--danger)` but it was undefined in CSS

## Infrastructure Note

safeoutputs MCP server has been unavailable since 2026-04-10. All branches are local-only.
Maintainer should enable safeoutputs in kanbanbot workflow config.

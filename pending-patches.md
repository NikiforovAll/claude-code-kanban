# Pending Patches - KanbanBot

These patches were prepared but could not be pushed as PRs due to safeoutputs MCP server failure.

## Patch 1: eng-pin-biome-devdep-20260501 (Attempt 10)

Title: [KanbanBot] eng: pin @biomejs/biome as devDependency, add npm run lint script, and update CI
Closes: #34
Tests: 79/79 pass, lint clean
Branch: kanbanbot/eng-pin-biome-devdep-20260501 (LOCAL ONLY - not pushed to remote)

Changes:
- Add `"@biomejs/biome": "^2.4.13"` to devDependencies in package.json
- Add `"lint": "biome check --error-on-warnings public/app.js public/style.css"` script
- Update CI lint step to use `npm run lint`
- Update CI syntax check to also check `cli.js`
- Update package-lock.json accordingly

Previous attempts on branches:
- kanbanbot/eng-pin-biome-devdep-20260407-c63b102d9635ea37 (remote, stale/old)
- kanbanbot/eng-pin-biome-devdep-20260426 (local-only, attempt 8)
- kanbanbot/eng-pin-biome-devdep-20260428 (local-only, attempt 9)
- kanbanbot/eng-pin-biome-devdep-20260501 (local-only, attempt 10 - current)

## Patch 2: eng-ci-smoke-robustness-20260501 (Attempt 1)

Title: [KanbanBot] ci: replace fragile sleep 2 in smoke test with poll/retry loop
Tests: 79/79 pass, lint clean
Branch: kanbanbot/eng-ci-smoke-robustness-20260501 (LOCAL ONLY - not pushed to remote)

Changes:
- Replace `sleep 2` in CI smoke test with a retry loop (15 iterations, 1s apart)
- Capture server PID explicitly for clean termination

## PR Health Status (2026-05-01)

6 open KanbanBot PRs (#31, #32, #33, #35, #36, #37) - no new conflicts expected.
Issue #38 exists with "agentic-workflows" label - content unknown, could not investigate.

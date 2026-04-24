# Pending Patches - KanbanBot

These patches were prepared but could not be pushed as PRs due to safeoutputs MCP server failure.

## Patch 1: perf-css-contain-20260424 (Attempt 5)

Title: perf: CSS containment on task cards + ResizeObserver entry sizes
Tests: 79/79 pass, lint clean
Branch: kanbanbot/perf-css-contain-20260424

```diff
diff --git a/public/app.js b/public/app.js
--- a/public/app.js
+++ b/public/app.js
@@ -5195,8 +5195,9 @@ function filterByOwner(value) {
 //#region LAYOUT_SYNC
 const sidebarHeader = document.querySelector('.sidebar-header');
 const viewHeader = document.querySelector('.view-header');
-new ResizeObserver(() => {
-  sidebarHeader.style.height = `${viewHeader.offsetHeight}px`;
+new ResizeObserver((entries) => {
+  const size = entries[0].borderBoxSize?.[0]?.blockSize ?? entries[0].contentRect.height;
+  sidebarHeader.style.height = `${size}px`;
 }).observe(viewHeader);
diff --git a/public/style.css b/public/style.css
--- a/public/style.css
+++ b/public/style.css
@@ -1037,6 +1037,7 @@ body::before {
   border-left: 2px solid var(--text-muted);
   border-radius: 8px;
   cursor: pointer;
+  contain: layout style;
   transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
 }
```

## Patch 2: fix-issue-34-biome-devdep-20260424 (Attempt 5)

Title: eng: pin @biomejs/biome@^2.0.0 as devDependency, add npm run lint script
Tests: 79/79 pass, lint clean
Closes: #34
Branch: kanbanbot/fix-issue-34-biome-devdep-20260424

Changes to package.json:
- Add `"@biomejs/biome": "^2.0.0"` to devDependencies
- Add `"lint": "biome check --error-on-warnings public/app.js public/style.css"` script
- Run `npm install --save-dev @biomejs/biome@^2.0.0` to update package-lock.json

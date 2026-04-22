# Pending Patches - KanbanBot

These patches were prepared but could not be pushed as PRs due to safeoutputs MCP server failure.
To apply: git apply <patch-file-content>

## Patch 1: perf-css-contain-20260422

Title: perf: CSS containment on task cards + ResizeObserver entry sizes
Tests: 81/81 pass, lint clean

```diff
diff --git a/public/app.js b/public/app.js
index 2274757..4b2923e 100644
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
 
 //#endregion
diff --git a/public/style.css b/public/style.css
index ea9861b..ff8ba17 100644
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

## Patch 2: test-agent-progress-enrichment-20260422

Title: test: add missing coverage for buildAgentProgressMap name/description enrichment
Tests: 81/81 pass (2 new), lint clean

```diff
diff --git a/test/contracts.test.js b/test/contracts.test.js
index bb8ec95..8998e2e 100644
--- a/test/contracts.test.js
+++ b/test/contracts.test.js
@@ -540,6 +540,46 @@ describe('Parser: buildAgentProgressMap', () => {
     const map = buildAgentProgressMap('/nonexistent/path.jsonl');
     assert.deepEqual(map, {});
   });
+
+  it('enriches map entry with name from Agent tool_use input', () => {
+    // tu_team_agent_01 has input.name = "reviewer" in the fixture
+    const map = buildAgentProgressMap(jsonlPath);
+    assert.equal(map['tu_team_agent_01'].name, 'reviewer');
+  });
+
+  it('enriches map entry with description from Agent tool_use input', () => {
+    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
+    const file = path.join(tmpDir, 'test.jsonl');
+    writeFileSync(file, [
+      JSON.stringify({
+        type: 'assistant',
+        message: {
+          content: [
+            {
+              type: 'tool_use',
+              id: 'tu_named_01',
+              name: 'Agent',
+              input: { name: 'my-worker', description: 'Processes files', prompt: 'Do work' },
+            },
+          ],
+        },
+      }),
+      JSON.stringify({
+        type: 'user',
+        toolUseResult: { agentId: 'agent-named-001', prompt: 'Do work' },
+        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_named_01' }] },
+      }),
+    ].join('\n'));
+
+    try {
+      const map = buildAgentProgressMap(file);
+      assert.equal(map['tu_named_01']?.agentId, 'agent-named-001');
+      assert.equal(map['tu_named_01']?.name, 'my-worker');
+      assert.equal(map['tu_named_01']?.description, 'Processes files');
+    } finally {
+      rmSync(tmpDir, { recursive: true, force: true });
+    }
+  });
 });
 
 describe('Parser: readSessionInfoFromJsonl', () => {
```


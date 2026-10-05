const { describe, it } = require('node:test');
const assert = require('node:assert');
const { wantsTree, highlightTree } = require('../public/tree-highlight');

const CALL_TREE = `BackgroundTaskQueueService        Channel.CreateUnbounded<IBackgroundTaskEvent>()
        │  (DocEvent, SecurityEvent, SearchEvent all go in here)
        ▼
BackgroundQueuedHostedService     the only AddHostedService; while (DequeueAsync) … await ProcessAsync
        └─ BackgroundProcessorFactory   switch on the event type
             ├─ DocEventBackgroundTaskEvent      → DocEventBackgroundTaskProcessor       (metrics: ES + DB, counters)
             ├─ SecurityEventBackgroundTaskEvent → SecurityEventBackgroundTaskProcessor  (ES stream ∥ EPAM SIEM)
             └─ SearchEventBackgroundTaskEvent   → SearchEventBackgroundTaskProcessor    (query history)`;

const DIFF_TREE = `  Startup
   ├─ AddQueue
-  └─ AddLegacyWorker        src/Legacy/Worker.cs
+  └─ AddHostedService       src/Queue/HostedService.cs`;

const PSEUDO = `handle(request)
  ├─ if !authorized → stop
  ├─ if cached → return cache
  └─ fetch → store → return`;

const BOX_TABLE = `┌──────┬───────┐
│ name │ value │
├──────┼───────┤
│ a    │ 1     │
└──────┴───────┘`;

const ASCII_ART = `  /\\_/\\
 ( o.o )
  > ^ <`;

const INDENT_CALLS = `submitForm
  createSession
    persistPrompt
    launchAgent
  navigateToSession`;

const INDENT_CALLS_DIFF = ` submitForm
   createSession
     persistPrompt
+    expandSkillMention
     launchAgent
-  navigateToSession
+  navigateToSession
+    subscribeToEvents`;

const INDENT_PSEUDO = `on(save)
  if content is unchanged
    return cached result
  write new content`;

const INDENT_PROSE = `Steps:
  Install the package first.
  Then run the server.`;

const CODE_DIFF = ` function save() {
-  write(content)
+  if (same) return cache
 }`;

function textOf(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('wantsTree', () => {
  it('takes glyph call trees, diff trees and pseudocode', () => {
    assert.equal(wantsTree('text', CALL_TREE), true);
    assert.equal(wantsTree('text', DIFF_TREE), true);
    assert.equal(wantsTree('text', PSEUDO), true);
  });

  it('leaves box tables, ASCII art, prose and a single tree line alone', () => {
    assert.equal(wantsTree('text', BOX_TABLE), false);
    assert.equal(wantsTree('text', ASCII_ART), false);
    assert.equal(wantsTree('text', 'Just a sentence.\nAnd another one.'), false);
    assert.equal(wantsTree('text', 'root\n└─ child'), false);
  });

  it('always takes the tree tags', () => {
    assert.equal(wantsTree('tree', 'a -> b'), true);
    assert.equal(wantsTree('callstack', 'x'), true);
    assert.equal(wantsTree('Flow', 'x'), true);
  });

  it('takes plain and diff blocks only when they look like a tree', () => {
    assert.equal(wantsTree('text', CALL_TREE), true);
    assert.equal(wantsTree('', CALL_TREE), true);
    assert.equal(wantsTree(undefined, PSEUDO), true);
    assert.equal(wantsTree('diff', DIFF_TREE), true);
    assert.equal(wantsTree('text', BOX_TABLE), false);
    assert.equal(wantsTree('diff', '-old\n+new'), false);
  });

  it('takes indentation-only call trees, plain or as a diff', () => {
    assert.equal(wantsTree('text', INDENT_CALLS), true);
    assert.equal(wantsTree('diff', INDENT_CALLS_DIFF), true);
    assert.equal(wantsTree('', 'loadConfig()\n  readFile(path)  # sync on purpose\n  parse()'), true);
  });

  it('leaves indented pseudocode, prose, code diffs and flat lists alone', () => {
    assert.equal(wantsTree('text', INDENT_PSEUDO), false);
    assert.equal(wantsTree('text', INDENT_PROSE), false);
    assert.equal(wantsTree('diff', CODE_DIFF), false);
    assert.equal(wantsTree('text', 'alpha\nbeta\ngamma'), false);
    assert.equal(wantsTree('text', 'root\n  child'), false);
  });

  it('leaves real languages to hljs', () => {
    assert.equal(wantsTree('js', CALL_TREE), false);
  });
});

describe('highlightTree', () => {
  it('keeps the text byte-identical', () => {
    for (const block of [CALL_TREE, DIFF_TREE, PSEUDO, INDENT_CALLS_DIFF, BOX_TABLE, ASCII_ART, '', '\n\n']) {
      assert.equal(textOf(highlightTree(block)), block);
    }
  });

  it('escapes HTML in the input', () => {
    const html = highlightTree('├─ <img src=x onerror=alert(1)>\n└─ node a&b "q" \'s\'');
    assert.equal(html.includes('<img'), false);
    assert.match(html, /&lt;img/);
    assert.match(html, / a&amp;b &quot;q&quot; &#39;s&#39;$/);
  });

  it('dims the glyphs and emphasizes the node after them', () => {
    const html = highlightTree('        └─ BackgroundProcessorFactory   switch on the event type');
    assert.equal(
      html,
      '<span class="hljs-punctuation">        └─ </span><span class="hljs-title">BackgroundProcessorFactory</span>   switch on the event type',
    );
  });

  it('emphasizes a root node and leaves a parenthetical alone', () => {
    const [root, note] = highlightTree(CALL_TREE).split('\n');
    assert.match(root, /^<span class="hljs-title">BackgroundTaskQueueService<\/span> /);
    assert.equal(note.includes('hljs-title'), false);
  });

  it('marks diff lines', () => {
    const lines = highlightTree(DIFF_TREE).split('\n');
    assert.match(lines[2], /^<span class="hljs-deletion">-<span class="hljs-punctuation">/);
    assert.match(lines[3], /^<span class="hljs-addition">\+<span class="hljs-punctuation">/);
    assert.equal(lines[0].includes('hljs-addition'), false);
    assert.match(lines[0], /<span class="hljs-title">Startup<\/span>$/);
  });
});

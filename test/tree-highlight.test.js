const { describe, it } = require('node:test');
const assert = require('node:assert');
const { wantsTree, highlightTree, renderTree } = require('../public/tree-highlight');

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

const STACK = ` handleCheckout                  src/routes/checkout.ts:24
   validateCart                  throws on an empty cart
   placeOrder *                  src/orders/place.ts:40
     chargeCard                  src/payments/charge.ts:31
       ~ 2 SDK frames
         PaymentsClient.charge   node_modules/pay-sdk/client.js:112
         HttpClient.request      node_modules/pay-sdk/http.js:58
+    sendReceipt                 src/email/receipt.ts:9
-    logOrder                    src/orders/log.ts:5
 onPaymentWebhook                src/routes/webhooks.ts:58
   markOrderPaid                 src/orders/status.ts:22`;

function rowsOf(html) {
  return html.replace(/^<pre><code[^>]*>|<\/code><\/pre>$/g, '').split('<span class="ct-nl">\n</span>');
}

function rowFor(html, name) {
  return rowsOf(html).find((r) => textOf(r).includes(name));
}

describe('renderTree', () => {
  it('draws the notation as a call stack, and falls back to the line highlight for the rest', () => {
    const stacks = [STACK, INDENT_CALLS, INDENT_CALLS_DIFF, 'a\n  b\n\nc\n  d', 'a  note\n  b(x)  note', '~ 3 frames\n  a\n  b', ''];
    const others = [CALL_TREE, DIFF_TREE, 'doc preview plan.md\n  run it'];
    for (const [blocks, cls] of [
      [stacks, 'hljs ct'],
      [others, 'hljs language-tree'],
    ]) {
      for (const block of blocks) {
        const html = renderTree(block);
        assert.match(html, new RegExp(`^<pre><code class="${cls}">`));
        assert.equal(textOf(html), block);
      }
    }
  });

  it('takes an untagged block in the notation as a tree', () => {
    assert.equal(wantsTree('text', 'a\n  ~ 2 SDK frames\n    b *'), true);
  });

  it('draws tree lines over the indent spaces', () => {
    const html = renderTree(STACK);
    assert.match(rowFor(html, 'validateCart'), /<span class="ct-m"> <\/span><span class="ct-g ct-t"> <\/span><span class="ct-g ct-h"> <\/span>/);
    assert.match(rowFor(html, 'placeOrder'), /<span class="ct-g ct-l"> <\/span><span class="ct-g ct-h"> <\/span>/);
    assert.match(rowFor(html, 'sendReceipt'), /<span class="ct-m">\+<\/span>  <span class="ct-g ct-t">/);
    assert.match(rowFor(html, 'chargeCard'), /<span class="ct-g ct-t">/);
  });

  it('marks the focus frame, the change rows and the notes', () => {
    const html = renderTree(STACK);
    assert.match(rowFor(html, 'placeOrder'), /class="ct-row ct-focus ct-has"/);
    assert.match(rowFor(html, 'placeOrder'), /<span class="ct-star"> \*<\/span>/);
    assert.match(rowFor(html, 'sendReceipt'), /class="ct-row ct-add"/);
    assert.match(rowFor(html, 'logOrder'), /class="ct-row ct-del"/);
    assert.match(rowFor(html, 'validateCart'), /<span class="ct-note">throws on an empty cart<\/span>/);
    assert.match(rowFor(html, 'handleCheckout'), /<span class="ct-loc">src\/routes\/checkout.ts:24<\/span>/);
  });

  it('folds the frames under a ~ line', () => {
    const html = renderTree(STACK);
    const fold = rowFor(html, '2 SDK frames');
    assert.match(fold, /class="ct-row ct-fold ct-has"/);
    assert.match(fold, /data-ct="4"/);
    assert.match(fold, /role="button"/);
    assert.match(fold, /aria-expanded="false"/);
    const inner = rowFor(html, 'PaymentsClient.charge');
    assert.match(inner, /class="ct-row ct-hidden ct-lib"/);
    assert.match(inner, /data-ct-in="4 3 2 0"/);
  });

  it('folds any frame with callees, open at the start', () => {
    const html = renderTree(STACK);
    const charge = rowFor(html, 'chargeCard');
    assert.match(charge, /class="ct-row ct-has"/);
    assert.match(charge, /data-ct="3"/);
    assert.match(charge, /aria-expanded="true"/);
    assert.match(charge, /data-ct-in="2 0"/);
    assert.doesNotMatch(rowFor(html, 'sendReceipt'), /data-ct=/);
    assert.doesNotMatch(rowFor(html, 'chargeCard'), /ct-lib/);
  });

  it('leaves a ~ line with nothing under it as a note', () => {
    const fold = rowFor(renderTree('a\n  ~ 3 middleware frames\n  b'), 'middleware');
    assert.match(fold, /^<span class="ct-row ct-fold" data-ct-in="0">/);
  });

  it('opens a fold that holds the focus frame or a change', () => {
    const focus = renderTree('a\n  ~ 2 SDK frames\n    b *\n    c');
    assert.match(rowFor(focus, '2 SDK'), /aria-expanded="true"/);
    assert.equal(focus.includes('ct-hidden'), false);
    const change = renderTree(' a\n   ~ 2 SDK frames\n-    b\n+    c');
    assert.match(rowFor(change, '2 SDK'), /aria-expanded="true"/);
    const top = renderTree('~ 2 Express frames\n  next\n    handle *');
    assert.match(rowFor(top, 'Express'), /aria-expanded="true"/);
  });

  it('nests folds, each with its own state', () => {
    const html = renderTree('a\n  ~ 1 SDK frame\n    b\n      ~ 1 runtime frame\n        c');
    const runtime = rowFor(html, 'runtime');
    assert.match(runtime, /data-ct="3"/);
    assert.match(runtime, /data-ct-in="2 1 0"/);
    assert.match(runtime, /aria-expanded="false"/);
    assert.match(rowsOf(html)[4], /data-ct-in="3 2 1 0"/);
  });

  it('escapes HTML in names and notes', () => {
    const html = renderTree('a  <img src=x>\n  b  "q"');
    assert.equal(html.includes('<img'), false);
    assert.match(html, /&lt;img src=x&gt;/);
  });
});

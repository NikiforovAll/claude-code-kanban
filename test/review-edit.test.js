const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function appFunctions(names, globals = {}) {
  const context = vm.createContext(globals);
  for (const name of names) {
    const src = new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(app)[0];
    vm.runInContext(src, context);
  }
  return context;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function panel(items, editing = null) {
  const panelEl = { hidden: false, innerHTML: '', replaceChildren() { this.innerHTML = ''; } };
  const ctx = appFunctions(
    ['renderReviewPanel', 'endReviewEdit', 'saveReviewEdit', 'reviewEditorText', 'onReviewEditorKey'],
    {
      escapeHtml,
      DETAIL_EDIT_SVG: '<svg></svg>',
      syncReviewSendClaims: () => {},
      reviewItems: () => items,
      activeReview: { panelEl, hostEl: null, hot: null, editing },
    },
  );
  return { ctx, panelEl };
}

function ctrlEnter(value) {
  const target = { value, focused: false, focus() { this.focused = true; } };
  return { key: 'Enter', ctrlKey: true, target, stopPropagation() {} };
}

describe('review comment edit', () => {
  it('shows an edit button on each card and a textarea with the draft on the one in edit', () => {
    const a = { quote: 'first', comment: 'keep <b>' };
    const b = { quote: 'second', comment: 'old' };
    const { ctx, panelEl } = panel([a, b], { c: b, draft: 'new <i>' });
    ctx.renderReviewPanel();
    assert.equal((panelEl.innerHTML.match(/class="review-edit"/g) || []).length, 2);
    assert.match(panelEl.innerHTML, /<div class="review-card-comment"[^>]*>keep &lt;b&gt;<\/div>/);
    assert.match(panelEl.innerHTML, /<textarea class="review-card-edit"[^>]*>new &lt;i&gt;<\/textarea>/);
    assert.match(panelEl.innerHTML, /review-card-quote">second</);
    assert.doesNotMatch(panelEl.innerHTML, />old</);
  });

  it('saves a trimmed comment on Ctrl+Enter, keeps the quote, and refuses an empty one', () => {
    const c = { quote: 'q', comment: 'old', range: {}, pos: 3 };
    const { ctx, panelEl } = panel([c], { c, draft: 'old' });
    const empty = ctrlEnter('   ');
    ctx.onReviewEditorKey(empty, ctx.saveReviewEdit, ctx.endReviewEdit);
    assert.equal(c.comment, 'old');
    assert.equal(empty.target.focused, true);
    ctx.onReviewEditorKey(ctrlEnter('  new text \n'), ctx.saveReviewEdit, ctx.endReviewEdit);
    assert.deepEqual([c.comment, c.quote, c.pos], ['new text', 'q', 3]);
    assert.match(panelEl.innerHTML, /<div class="review-card-comment"[^>]*>new text<\/div>/);
    assert.doesNotMatch(panelEl.innerHTML, /review-card-edit/);
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];
const decl = (name) => new RegExp(`^(let|const) ${name} = .*;$`, 'm').exec(src)[0].replace(/^(let|const) /, 'var ');

function makePage(stored = []) {
  const ctx = {
    saved: null,
    revealed: [],
    store: { writeJson: (_k, v) => (ctx.saved = v) },
    readStoredList: () => stored,
    terminalPaneFocused: () => false,
    isShowCardFocused: () => false,
    termState: {},
    revealSession: async (id) => {
      ctx.revealed.push(id);
      ctx.currentSessionId = id;
      ctx.pushSwapHistory(id);
    },
  };
  vm.runInNewContext(
    [
      'var currentSessionId = null;',
      decl('SWAP_KEY'),
      decl('SWAP_HISTORY_MAX'),
      decl('swapHistory'),
      ...['setSwapHistory', 'pushSwapHistory', 'forgetSwapHistory', 'swapToPreviousSession'].map(fn),
      'this.history = () => swapHistory;',
    ].join('\n'),
    ctx,
  );
  const open = (id) => {
    ctx.currentSessionId = id;
    ctx.pushSwapHistory(id);
  };
  return { ctx, open };
}

describe('swap history (Ctrl+Alt+S)', () => {
  it('toggles between the last two sessions', async () => {
    const { ctx, open } = makePage();
    open('A');
    open('B');
    await ctx.swapToPreviousSession();
    await ctx.swapToPreviousSession();
    assert.deepEqual(ctx.revealed, ['A', 'B']);
  });

  it('falls back to N-2 when a session is forgotten', async () => {
    const { ctx, open } = makePage();
    open('A');
    open('B');
    open('C');
    ctx.forgetSwapHistory('B');
    await ctx.swapToPreviousSession();
    assert.equal(ctx.currentSessionId, 'A');
    await ctx.swapToPreviousSession();
    assert.equal(ctx.currentSessionId, 'C');
  });

  it('keeps going back while the open session is forgotten', async () => {
    const { ctx, open } = makePage();
    open('A');
    open('B');
    open('C');
    ctx.forgetSwapHistory('C');
    await ctx.swapToPreviousSession();
    assert.equal(ctx.currentSessionId, 'B');
    ctx.forgetSwapHistory('B');
    await ctx.swapToPreviousSession();
    assert.equal(ctx.currentSessionId, 'A');
  });

  it('does nothing with no other session', async () => {
    const { ctx, open } = makePage();
    open('A');
    await ctx.swapToPreviousSession();
    assert.deepEqual(ctx.revealed, []);
  });

  it('dedupes, caps and persists the list', () => {
    const { ctx, open } = makePage();
    for (let i = 0; i < 30; i++) open(`s${i % 25}`);
    assert.equal(ctx.history().length, 20);
    assert.equal(new Set(ctx.history()).size, 20);
    assert.equal(ctx.history()[0], 's4');
    assert.deepEqual(ctx.saved, ctx.history());
  });

  it('reads the old stored pair with nulls', () => {
    const { ctx } = makePage(['A', null]);
    assert.deepEqual(ctx.history(), ['A']);
  });
});

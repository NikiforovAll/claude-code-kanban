const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const src = /^function reviewQuoteAt\([^)]*\) \{[\s\S]*?^\}/m.exec(app)[0];
const context = vm.createContext({});
vm.runInContext(src, context);
const { reviewQuoteAt } = context;

const anchor = (exact, pos, prefix = '', suffix = '') => ({ exact, pos, prefix, suffix });

describe('reviewQuoteAt', () => {
  it('finds the quote after text before it changed', () => {
    const text = 'A new intro line. The first paragraph has some text.';
    assert.equal(reviewQuoteAt(text, anchor('some text', 26, 'paragraph has ', '.')), text.indexOf('some text'));
  });

  it('picks the match whose prefix and suffix fit', () => {
    const text = 'see the plan here; see the plan there';
    assert.equal(reviewQuoteAt(text, anchor('the plan', 0, '; see ', ' there')), text.lastIndexOf('the plan'));
  });

  it('breaks a tie by the old offset', () => {
    const text = 'x ab x ab x ab';
    assert.equal(reviewQuoteAt(text, anchor('ab', 12, 'x ', '')), 12);
    assert.equal(reviewQuoteAt(text, anchor('ab', 6, 'x ', '')), 7);
  });

  it('returns -1 when the quote is gone or empty', () => {
    assert.equal(reviewQuoteAt('nothing here', anchor('some text', 0)), -1);
    assert.equal(reviewQuoteAt('nothing here', anchor('', 0)), -1);
  });
});

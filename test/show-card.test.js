const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function appFunction(name, globals = {}) {
  const src = new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(app)[0];
  const context = vm.createContext(globals);
  vm.runInContext(src, context);
  return context[name];
}

function appConst(name) {
  const m = new RegExp(`^const ${name} =\\s*([\\s\\S]*?);$`, 'm').exec(app);
  return vm.runInNewContext(`(${m[1]})`);
}

const SHOW_INSET = appConst('SHOW_INSET');

describe('showFitSize', () => {
  const fit = appFunction('showFitSize', { SHOW_INSET });

  it('takes 40% of the terminal width between 360 and 640', () => {
    assert.equal(fit(1200, 800).w, 480);
    assert.equal(fit(2000, 800).w, 640);
    assert.equal(fit(700, 800).w, 360);
  });

  it('never passes the terminal width less the insets', () => {
    assert.equal(fit(300, 800).w, 300 - 2 * SHOW_INSET);
  });

  it('caps the height at 60% of the terminal', () => {
    assert.equal(fit(1200, 500).h, 300);
  });
});

describe('showClampSize', () => {
  const clamp = appFunction('showClampSize', {
    SHOW_INSET,
    SHOW_MIN_W: appConst('SHOW_MIN_W'),
    SHOW_MIN_H: appConst('SHOW_MIN_H'),
  });

  it('keeps at least 280 x 120', () => {
    assert.deepEqual({ ...clamp({ w: 100, h: 50 }, 1000, 800) }, { w: 280, h: 120 });
  });

  it('keeps the card inside the terminal', () => {
    assert.deepEqual({ ...clamp({ w: 5000, h: 5000 }, 1000, 800) }, { w: 1000 - 2 * SHOW_INSET, h: 800 - 2 * SHOW_INSET });
  });
});

describe('showSrcdoc', () => {
  const csp = appConst('SHOW_CSP');
  const srcdoc = appFunction('showSrcdoc', {
    SHOW_CSP: csp,
    SHOW_FRAME_BASE: 'body{base}',
    REVIEW_BRIDGE_TAG: '<script>review</script>',
    showTokens: () => ({ '--color-bg': '#111' }),
    showBridge: function showBridge() {},
  });
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;

  it('wraps a fragment with the CSP, the tokens and the base styles', () => {
    const doc = srcdoc('<p>hi</p>', 0);
    assert.ok(doc.startsWith('<!doctype html><html><head><meta charset="utf-8">'));
    assert.ok(doc.indexOf(cspMeta) < doc.indexOf(':root{--color-bg:#111}'));
    assert.ok(doc.includes('<style>body{base}</style>'));
    assert.match(doc, /<body><p>hi<\/p><script>\(function showBridge\(\) \{\}\)\(0\);<\/script><script>review<\/script><\/body>/);
  });

  it('puts the CSP first in the head of a whole document and adds no base styles', () => {
    const doc = srcdoc('<!DOCTYPE html><html lang="en"><head><script>x()</script></head><body>b</body></html>', 0);
    assert.ok(doc.startsWith(`<!DOCTYPE html><html lang="en"><head>${cspMeta}`));
    assert.ok(doc.indexOf(cspMeta) < doc.indexOf('<script>x()'));
    assert.ok(!doc.includes('body{base}'));
    assert.ok(doc.endsWith('<script>review</script>'));
  });

  it('adds a head to a document that has none', () => {
    const doc = srcdoc('<html><body>b</body></html>', 0);
    assert.ok(doc.startsWith(`<html><head>${cspMeta}`));
  });

  it('passes the scroll to restore', () => {
    assert.ok(srcdoc('<p>x</p>', 97.4).includes('(97);'));
  });

  it('blocks script channels and remote sub-resources', () => {
    for (const d of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", 'img-src data:']) {
      assert.ok(csp.includes(d), d);
    }
  });
});

describe('showBridge', () => {
  it('runs as source text in the card, so it closes over nothing', () => {
    const src = appFunction('showBridge').toString();
    for (const name of ['showState', 'SHOW_MSG', 'escapeHtml', 'store']) assert.doesNotMatch(src, new RegExp(`\\b${name}\\b`), name);
  });
});

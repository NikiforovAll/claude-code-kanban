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
    modalZoom: 1.2,
  });
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;

  it('wraps a fragment with the CSP, the tokens and the base styles', () => {
    const doc = srcdoc('<p>hi</p>', 0);
    assert.ok(doc.startsWith('<!doctype html><html><head><meta charset="utf-8">'));
    assert.ok(doc.indexOf(cspMeta) < doc.indexOf(':root{--color-bg:#111}'));
    assert.ok(doc.includes(':root{--color-bg:#111}body{base}</style>'));
    assert.match(doc, /<body><p>hi<\/p><script>\(function showBridge\(\) \{\}\)\(0, 1\.2\);<\/script><script>review<\/script><\/body>/);
  });

  it('puts the CSP and base styles first in the head of a whole document, before its own', () => {
    const doc = srcdoc('<!DOCTYPE html><html lang="en"><head><style>body{own}</style></head><body>b</body></html>', 0);
    assert.ok(doc.startsWith(`<!DOCTYPE html><html lang="en"><head>${cspMeta}`));
    assert.ok(doc.indexOf('body{base}') < doc.indexOf('body{own}'));
    assert.ok(doc.endsWith('<script>review</script>'));
  });

  it('adds a head to a document that has none', () => {
    const doc = srcdoc('<html><body>b</body></html>', 0);
    assert.ok(doc.startsWith(`<html><head>${cspMeta}`));
  });

  it('passes the scroll to restore and the text zoom', () => {
    assert.ok(srcdoc('<p>x</p>', 97.4).includes('(97, 1.2);'));
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

const press = (key, mods = {}) => ({ key, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe('showCardKey', () => {
  const { comboOf } = require('./vendor/claude-hub-sdk.js');
  function setup(state = {}) {
    const log = [];
    const showState = { idx: 0, posts: [{ id: 'p1', title: 'T' }], expanded: false, ...state };
    const key = appFunction('showCardKey', {
      ClaudeHub: { comboOf },
      showState,
      SHOW_KEY_COMMANDS: appConst('SHOW_KEY_COMMANDS'),
      matchKey: appFunction('matchKey'),
      focusShowBody: () => log.push('focus body'),
      showCommand: (cmd) => log.push(cmd),
      focusTerminalPane: () => log.push('focus terminal'),
      confirmModal: () => new Promise(() => {}),
    });
    return { key, log };
  }

  it('toggles expand on Alt+Enter and keeps focus on the body', () => {
    const { key, log } = setup();
    assert.equal(key(press('Enter', { altKey: true })), true);
    assert.deepEqual(log, ['expand', 'focus body']);
  });

  it('goes back from expand on Esc, else collapses and focuses the terminal', () => {
    const expanded = setup({ expanded: true });
    expanded.key(press('Escape'));
    assert.deepEqual(expanded.log, ['expand', 'focus body']);
    const card = setup();
    card.key(press('Escape'));
    assert.deepEqual(card.log, ['collapse', 'focus terminal']);
  });

  it('closes on Alt+W and focuses the terminal', () => {
    const { key, log } = setup();
    assert.equal(key(press('w', { altKey: true, code: 'KeyW' })), true);
    assert.deepEqual(log, ['close', 'focus terminal']);
  });

  it('leaves Enter, Ctrl+Enter and plain letters alone', () => {
    const { key, log } = setup();
    for (const e of [press('Enter'), press('Enter', { ctrlKey: true }), press('f')]) assert.equal(key(e), false);
    assert.deepEqual(log, []);
  });
});

describe('Ctrl+Alt+` focuses the show card', () => {
  const toggleShowFocus = () => {};
  const toggleTerminalFocus = () => {};
  const shortcut = appFunction('terminalShortcut', {
    toggleShowFocus,
    toggleTerminalFocus,
    hubModDown: appFunction('hubModDown'),
    zoomDelta: () => undefined,
    matchKey: () => false,
  });
  const tick = (mods) => press('`', { code: 'Backquote', getModifierState: () => false, ...mods });

  it('maps Ctrl+Alt+` to the card and leaves Alt+` on the terminal toggle', () => {
    assert.equal(shortcut(tick({ ctrlKey: true, altKey: true })), toggleShowFocus);
    assert.equal(shortcut(tick({ altKey: true })), toggleTerminalFocus);
  });

  it('leaves AltGr+` to the terminal', () => {
    assert.equal(shortcut(tick({ ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' })), null);
  });
});

describe('SHOW_CLAIMS', () => {
  it('claims Alt+Enter and Esc from the card frame, not Ctrl+Enter', () => {
    const claims = appConst('SHOW_CLAIMS');
    assert.ok(claims.some((c) => c.altKey && c.key === 'Enter' && !c.ctrlKey));
    assert.ok(claims.some((c) => c.key === 'Escape' && !c.altKey && !c.ctrlKey));
    assert.ok(!claims.some((c) => c.ctrlKey && c.key === 'Enter'));
  });
});

// The gates of the dataviz skill's validate_palette.js, run against every cck theme's surface.
describe('show chart palette', () => {
  const palette = appConst('SHOW_PALETTE');
  const series = { light: palette.light.series, dark: palette.dark.series };
  const ramp = { light: palette.light.ramp, dark: palette.dark.ramp };
  const themes = JSON.parse(readFileSync(path.join(__dirname, '..', 'website', 'src', 'kit', 'themes.json'), 'utf8'));
  const surfaces = {
    light: themes.map((t) => [t.id, t.light.surface]),
    dark: themes.map((t) => [t.id, t.dark.surface]),
  };

  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const rgb = (h) => [1, 3, 5].map((i) => lin(Number.parseInt(h.slice(i, i + 2), 16) / 255));
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const contrast = (a, b) => {
    const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const oklab = ([r, g, b]) => {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  // Machado, Oliveira and Fernandes (2009) at severity 1.0, the model the dataviz thresholds assume.
  const CVD = [
    [
      [0.152286, 1.052583, -0.204868],
      [0.114503, 0.786281, 0.099216],
      [-0.003882, -0.048116, 1.051998],
    ],
    [
      [0.367322, 0.860646, -0.227968],
      [0.280085, 0.672501, 0.047413],
      [-0.01182, 0.04294, 0.968881],
    ],
  ];
  const simulate = (c, m) => m.map((row) => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2])));
  const deltaE = (a, b) => 100 * Math.hypot(...a.map((v, i) => v - b[i]));
  const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] };

  it('reads the color themes', () => {
    assert.ok(themes.length > 0);
  });

  for (const mode of ['light', 'dark']) {
    it(`${mode}: 8 series colors clear 3:1 on every theme surface`, () => {
      assert.equal(series[mode].length, 8);
      for (const c of series[mode]) {
        for (const [theme, s] of surfaces[mode]) assert.ok(contrast(c, s) >= 3, `${c} on ${theme}: ${contrast(c, s).toFixed(2)}`);
      }
    });

    it(`${mode}: series sit in the lightness band and read as color`, () => {
      for (const c of series[mode]) {
        const [L, a, b] = oklab(rgb(c));
        assert.ok(L >= BAND[mode][0] && L <= BAND[mode][1], `${c} L ${L.toFixed(3)}`);
        assert.ok(Math.hypot(a, b) >= 0.1, `${c} chroma`);
      }
    });

    it(`${mode}: neighbors stay apart, with and without color blindness`, () => {
      for (let i = 0; i < series[mode].length - 1; i++) {
        const p = rgb(series[mode][i]);
        const q = rgb(series[mode][i + 1]);
        assert.ok(deltaE(oklab(p), oklab(q)) >= 15, `slots ${i + 1}-${i + 2}`);
        const cvd = Math.min(...CVD.map((m) => deltaE(oklab(simulate(p, m)), oklab(simulate(q, m)))));
        assert.ok(cvd >= 8, `slots ${i + 1}-${i + 2} CVD ${cvd.toFixed(1)}`);
      }
    });

    it(`${mode}: the ramp steps away from the surface and its first step clears 2:1`, () => {
      const L = ramp[mode].map((c) => oklab(rgb(c))[0]);
      const sign = mode === 'light' ? -1 : 1;
      for (let i = 0; i < L.length - 1; i++) assert.ok(sign * (L[i + 1] - L[i]) >= 0.06, `steps ${i + 1}-${i + 2}`);
      for (const [theme, s] of surfaces[mode]) assert.ok(contrast(ramp[mode][0], s) >= 2, theme);
    });
  }
});

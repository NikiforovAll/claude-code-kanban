const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...p) => readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('public', 'app.js');

function appConst(name) {
  const m = new RegExp(`^const ${name} =\\s*([\\s\\S]*?);$`, 'm').exec(app);
  return vm.runInNewContext(`(${m[1]})`);
}

const MERMAID_VARS = appConst('MERMAID_VARS');
const MERMAID_MODE_VARS = appConst('MERMAID_MODE_VARS');
const SHOW_PALETTE = appConst('SHOW_PALETTE');

function mermaidConfig(vars, light) {
  const src = /^function mermaidConfig\(\) \{[\s\S]*?^\}/m.exec(app)[0];
  const context = vm.createContext({
    MERMAID_VARS,
    MERMAID_MODE_VARS,
    SHOW_PALETTE,
    isLightTheme: () => light,
    document: { body: {} },
    getComputedStyle: () => ({ getPropertyValue: (name) => ` ${vars[name] ?? ''}` }),
  });
  vm.runInContext(src, context);
  return context.mermaidConfig();
}

describe('mermaidConfig', () => {
  const names = [MERMAID_VARS, MERMAID_MODE_VARS.dark, MERMAID_MODE_VARS.light].flatMap(Object.values);
  const vars = Object.fromEntries(names.map((name) => [name, `v(${name})`]));

  it('feeds the base theme from the board vars', () => {
    const { theme, look, startOnLoad, themeVariables, themeCSS } = mermaidConfig(vars, false);
    assert.equal(theme, 'base');
    assert.equal(look, 'classic');
    assert.equal(startOnLoad, false);
    assert.equal(themeVariables.darkMode, true);
    assert.equal(themeVariables.primaryBorderColor, 'v(--accent)');
    assert.equal(themeVariables.fontFamily, 'v(--mono)');
    assert.match(themeCSS, /marker circle \{ fill: v\(--bg-surface\); \}/);
  });

  it('lifts nodes off the page in dark mode', () => {
    assert.equal(mermaidConfig(vars, false).themeVariables.primaryColor, 'v(--bg-hover)');
    assert.equal(mermaidConfig(vars, true).themeVariables.primaryColor, 'v(--bg-elevated)');
  });

  it('takes pie and cScale colors from the chart palette of the mode', () => {
    for (const light of [true, false]) {
      const { themeVariables } = mermaidConfig(vars, light);
      const series = SHOW_PALETTE[light ? 'light' : 'dark'].series;
      assert.equal(themeVariables.darkMode, !light);
      series.forEach((c, i) => {
        assert.equal(themeVariables[`pie${i + 1}`], c);
        assert.equal(themeVariables[`cScale${i}`], c);
      });
    }
  });
});

describe('initMermaidBlocks', () => {
  it('keeps each source for a theme redraw, since DOMPurify drops an attribute that holds -->', () => {
    const block = (text, original) => {
      const attrs = original == null ? {} : { 'data-original': original };
      return {
        textContent: text,
        hasAttribute: (n) => n in attrs,
        setAttribute: (n, v) => {
          attrs[n] = v;
        },
        attrs,
      };
    };
    const fresh = block('flowchart LR\n  A --> B');
    const kept = block('<svg/>', 'pie\n  "a": 1');
    let ran;
    const src = /^function initMermaidBlocks\(container\) \{[\s\S]*?^\}/m.exec(app)[0];
    const context = vm.createContext({
      document: { querySelector: () => fresh, querySelectorAll: () => [fresh, kept] },
      mermaid: { run: ({ nodes }) => (ran = nodes) },
      queueMermaid: (work) => work(),
    });
    vm.runInContext(src, context);
    context.initMermaidBlocks();
    assert.equal(fresh.attrs['data-original'], 'flowchart LR\n  A --> B');
    assert.equal(kept.attrs['data-original'], 'pie\n  "a": 1');
    assert.ok(ran.length === 2 && ran[0] === fresh && ran[1] === kept);
  });
});

// Mermaid parses theme colors itself, so a theme's value must be a plain color, not var() or color-mix().
describe('theme colors that mermaid reads', () => {
  const all = [MERMAID_VARS, MERMAID_MODE_VARS.dark, MERMAID_MODE_VARS.light].flatMap(Object.values);
  const colorVars = [...new Set(all)].filter((name) => name !== '--mono');
  const blocks = [...read('public', 'themes.css').matchAll(/([^{}]+)\{([^{}]*--bg-surface:[^{}]*)\}/g)];

  it('finds a light and a dark block for every theme', () => {
    const themes = JSON.parse(read('website', 'src', 'kit', 'themes.json'));
    assert.ok(blocks.length >= themes.length * 2, `${blocks.length} blocks`);
  });

  it('gives each one a hex or rgb value', () => {
    for (const [, selector, body] of blocks) {
      for (const name of colorVars) {
        const value = new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1].trim();
        assert.match(value ?? '', /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i, `${selector.trim()} ${name}`);
      }
    }
  });
});

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

const fnSrc = (name) => new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(app)[0];

const MERMAID_VARS = appConst('MERMAID_VARS');
const MERMAID_MODE_VARS = appConst('MERMAID_MODE_VARS');
const SHOW_PALETTE = appConst('SHOW_PALETTE');

function mermaidConfig(vars, light, mermaidColor = (v) => v) {
  const src = fnSrc('mermaidConfig');
  const context = vm.createContext({
    MERMAID_VARS,
    MERMAID_MODE_VARS,
    SHOW_PALETTE,
    mermaidColor,
    isLightTheme: () => light,
    document: { body: {} },
    getComputedStyle: () => ({ getPropertyValue: (name) => ` ${vars[name] ?? ''}` }),
  });
  vm.runInContext(src, context);
  return context.mermaidConfig();
}

describe('mermaidConfig', () => {
  const names = [MERMAID_VARS, MERMAID_MODE_VARS.dark, MERMAID_MODE_VARS.light].flatMap(Object.values);
  const vars = Object.fromEntries([...names, '--mono'].map((name) => [name, `v(${name})`]));

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

  it('converts every theme color but not the font', () => {
    const { themeVariables } = mermaidConfig(vars, false, (v) => `rgb:${v}`);
    assert.equal(themeVariables.background, 'rgb:v(--bg-surface)');
    assert.equal(themeVariables.primaryColor, 'rgb:v(--bg-hover)');
    assert.equal(themeVariables.fontFamily, 'v(--mono)');
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

describe('mermaidColor', () => {
  const context = vm.createContext({ document: {} });
  vm.runInContext(`let colorProbe = null;\nconst probedColors = new Map();\n${fnSrc('mermaidColor')}`, context);

  it('keeps a hex or empty value as it is', () => {
    for (const v of ['', '#1e2025', '#fff']) assert.equal(context.mermaidColor(v), v);
  });

  it('reads any other color back from a canvas pixel as rgb()', () => {
    const probe = { data: [0, 0, 0, 0], fills: [] };
    context.document.createElement = () => ({
      getContext: () => ({
        clearRect() {},
        set fillStyle(v) {
          probe.fills.push(v);
        },
        fillRect() {},
        getImageData: () => ({ data: probe.data }),
      }),
    });
    probe.data = [228, 234, 243, 255];
    assert.equal(context.mermaidColor('oklch(0.935 0.014 256)'), 'rgb(228, 234, 243)');
    assert.equal(probe.fills.at(-1), 'oklch(0.935 0.014 256)');
    const fills = probe.fills.length;
    assert.equal(context.mermaidColor('oklch(0.935 0.014 256)'), 'rgb(228, 234, 243)');
    assert.equal(probe.fills.length, fills);
    probe.data = [10, 20, 30, 128];
    assert.equal(context.mermaidColor('rgb(from red r g b / 50%)'), 'rgba(10, 20, 30, 0.502)');
  });
});

describe('initMermaidBlocks', () => {
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

  function runBlocks(blocks, run) {
    const ran = [];
    let done;
    const context = vm.createContext({
      MERMAID_PENDING: appConst('MERMAID_PENDING'),
      document: { querySelector: () => blocks[0], querySelectorAll: () => blocks },
      mermaid: {
        run: async ({ nodes }) => {
          await run?.(nodes);
          ran.push(...nodes);
        },
      },
      queueMermaid: (work) => {
        done = work();
      },
    });
    vm.runInContext(`${fnSrc('initMermaidBlocks')}\n${fnSrc('showMermaidError')}`, context);
    context.initMermaidBlocks();
    return done.then(() => ran);
  }

  it('keeps each source for a theme redraw, since DOMPurify drops an attribute that holds -->', async () => {
    const fresh = block('flowchart LR\n  A --> B');
    const kept = block('<svg/>', 'pie\n  "a": 1');
    const ran = await runBlocks([fresh, kept]);
    assert.equal(fresh.attrs['data-original'], 'flowchart LR\n  A --> B');
    assert.equal(kept.attrs['data-original'], 'pie\n  "a": 1');
    assert.deepEqual(ran, [fresh, kept]);
  });

  it('shows the error in place of a bad diagram and still renders the next one', async () => {
    const bad = block('flowchart LR\n  A -->');
    const good = block('pie\n  "a": 1');
    const ran = await runBlocks([bad, good], (nodes) => {
      if (nodes[0] === bad) throw new Error('Parse error on line 2');
    });
    assert.equal(bad.textContent, 'Parse error on line 2');
    assert.ok('data-mermaid-error' in bad.attrs && 'data-processed' in bad.attrs);
    assert.equal(bad.attrs['data-original'], 'flowchart LR\n  A -->');
    assert.deepEqual(ran, [good]);
  });
});

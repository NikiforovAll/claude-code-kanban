const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

// Hub mods depend on each name in mod-surface.json. A rename that skips the file breaks every mod
// that uses the name, and no other test in this repo would notice.
const root = path.join(__dirname, '..');
const surface = JSON.parse(readFileSync(path.join(root, 'mod-surface.json'), 'utf8'));
const app = readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const region = app.slice(app.indexOf('// #region MOD_SURFACE'), app.indexOf('// #endregion MOD_SURFACE'));

describe('mod surface', () => {
  it('has a version and a text for each name', () => {
    assert.equal(surface.surface, 1);
    for (const group of ['functions', 'events', 'parts']) {
      for (const [name, text] of Object.entries(surface[group])) assert.ok(typeof text === 'string' && text, `${group}.${name}`);
    }
  });

  it('names top-level function declarations, which a mod can wrap through window', () => {
    for (const name of Object.keys(surface.functions)) {
      assert.match(app, new RegExp(`^function ${name}\\(`, 'm'), name);
    }
  });

  it('emits each event in the MOD_SURFACE region and nothing else', () => {
    assert.ok(region.length > 0, 'the MOD_SURFACE region is missing');
    const emitted = [...region.matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(emitted, Object.keys(surface.events).sort());
  });

  it('lists states only for listed parts, each a class the board sets', () => {
    for (const [part, states] of Object.entries(surface.states)) {
      assert.ok(surface.parts[part], `states.${part} is not a part`);
      for (const [state, text] of Object.entries(states)) {
        assert.ok(typeof text === 'string' && text, `states.${part}.${state}`);
        // A task card's class is its status with _ as -, so in-progress is written in_progress.
        assert.match(app, new RegExp(`['" ](${state}|${state.replaceAll('-', '_')})['" ]`), `${part}: class ${state}`);
      }
    }
  });

  it('marks each part with data-hub-part', () => {
    const marked = new Set([...`${html}\n${app}`.matchAll(/data-hub-part="([a-z-]+)"/g)].map((m) => m[1]));
    assert.deepEqual([...marked].sort(), Object.keys(surface.parts).sort());
  });
});

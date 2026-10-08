const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];
const tabs = /^const SHORTCUT_TABS = [\s\S]*?^\];/m.exec(src)[0];
const MAC_KEYS = /^const MAC_KEYS = .*;$/m.exec(src)[0];

// The hub's labels, as hub.keyLabel gives them after welcome. Empty: the hub has not answered.
let hubLabels = {};
// The page's own helpers, with the platform passed in the way the page's IS_MAC default does.
const page = vm.runInNewContext(
  `${MAC_KEYS}\n${fn('hubModDown')}\n${fn('helpKeys')}\n${fn('buildHelpShortcuts')}\n${tabs}\n({ hubModDown, helpKeys, buildHelpShortcuts, SHORTCUT_TABS })`,
  { IS_MAC: false, escapeHtml: String, hub: { keyLabel: (a) => hubLabels[[a].flat().join()] ?? null } },
);
const { hubModDown, SHORTCUT_TABS } = page;
// Arrays from the vm context have another prototype, so copy them for deepEqual.
const helpKeys = (r, mac) => [...page.helpKeys(r, mac)];

const NONE = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
const rows = SHORTCUT_TABS.flatMap((t) => t.groups).flatMap((g) => g.rows);
const row = (label) => rows.find((r) => r.label === label);
const WIN = false;
const MAC = true;

describe('session keys (new, resume, swap)', () => {
  it('are Ctrl+Alt, with no other modifier', () => {
    assert.equal(hubModDown({ ...NONE, ctrlKey: true, altKey: true }), true);
    assert.equal(hubModDown({ ...NONE, altKey: true, metaKey: true }), false);
    assert.equal(hubModDown({ ...NONE, ctrlKey: true, altKey: true, shiftKey: true }), false);
    assert.equal(hubModDown({ ...NONE, ctrlKey: true, altKey: true, metaKey: true }), false);
    assert.equal(hubModDown({ ...NONE, altKey: true }), false);
  });

  it('are not an AltGr press, which types a character', () => {
    const altGr = { ...NONE, ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' };
    assert.equal(hubModDown(altGr), false);
  });
});

describe('help dialog keys', () => {
  it('Windows and Linux: Ctrl, Alt, Shift by name', () => {
    assert.deepEqual(helpKeys(row('Project picker'), WIN), ['Ctrl', 'Alt', 'P']);
    assert.deepEqual(helpKeys(row('Config dir picker'), WIN), ['Ctrl', 'Alt', 'W']);
    assert.deepEqual(helpKeys(row('Jump to hub app by number'), WIN), ['Alt', '1…9']);
    assert.deepEqual(helpKeys(row('New session'), WIN), ['Ctrl', 'Alt', 'N']);
    assert.deepEqual(helpKeys(row('Jump to memory'), WIN), ['Ctrl', 'M']);
  });

  it('macOS: the hub keys are Control+Option', () => {
    assert.deepEqual(helpKeys(row('Project picker'), MAC), ['⌃', '⌥', 'P']);
    assert.deepEqual(helpKeys(row('Config dir picker'), MAC), ['⌃', '⌥', 'W']);
    assert.deepEqual(helpKeys(row('Previous / next hub app'), MAC), ['⌃', '⌥', '←/→']);
    assert.deepEqual(helpKeys(row('Jump to hub app by number'), MAC), ['⌃', '⌥', '1…9']);
    assert.deepEqual(helpKeys(row('New session'), MAC), ['⌃', '⌥', 'N']);
    assert.deepEqual(helpKeys(row('Swap to previous session'), MAC), ['⌃', '⌥', 'S']);
  });

  it('macOS: Kanban\'s own keys, with symbols', () => {
    assert.deepEqual(helpKeys(row('Jump to memory'), MAC), ['⌃', 'M']);
    assert.deepEqual(helpKeys(row('Show / hide terminal'), MAC), ['⌃', '`']);
    assert.deepEqual(helpKeys(row('End terminal'), MAC), ['⌥', '⇧', '`']);
  });

  it('every hub row is flagged, and none of the others', () => {
    const hub = SHORTCUT_TABS.filter((t) => t.hub).flatMap((t) => t.groups);
    assert.ok(hub.length > 0);
    for (const r of hub.flatMap((g) => g.rows).filter((r) => r.keys.includes('Alt'))) assert.equal(r.hubMod, true, r.label);
    assert.equal(row('Show / hide terminal').hubMod, undefined);
    assert.equal(row('Jump to memory').hubMod, undefined);
  });

  it('every hub row with a hub key names its hub actions, and the session keys none', () => {
    const HUB_ACTIONS = ['hub.projectPicker', 'hub.configDirPicker', 'hub.appLauncher', 'hub.prevApp', 'hub.nextApp', 'hub.appByNumber'];
    const hub = SHORTCUT_TABS.filter((t) => t.hub).flatMap((t) => t.groups).flatMap((g) => g.rows);
    for (const r of hub.filter((r) => r.hubMod)) assert.ok([r.action].flat().every((a) => HUB_ACTIONS.includes(a)), r.label);
    for (const label of ['New session', 'Resume session (claude -r)', 'Swap to previous session']) assert.equal(row(label).action, undefined);
  });

  it('a hub row shows the keys the hub reports, and hides when no key runs it', () => {
    hubLabels = {
      'hub.projectPicker': ['Ctrl', 'Alt', 'O'],
      'hub.prevApp,hub.nextApp': ['Ctrl', 'Alt', 'J/K'],
      'hub.configDirPicker': [],
    };
    try {
      assert.deepEqual(helpKeys(row('Project picker'), MAC), ['Ctrl', 'Alt', 'O']);
      assert.deepEqual(helpKeys(row('Previous / next hub app'), WIN), ['Ctrl', 'Alt', 'J/K']);
      assert.deepEqual(helpKeys(row('App launcher'), WIN), ['Ctrl', 'Alt', 'A'], 'not reported: the default');
      const html = page.buildHelpShortcuts(SHORTCUT_TABS.find((t) => t.hub).groups);
      assert.match(html, /<kbd>O<\/kbd><\/dt><dd class="sc-l">Project picker/);
      assert.doesNotMatch(html, /Config dir picker/);
      assert.match(html, /App launcher/);
    } finally {
      hubLabels = {};
    }
  });
});

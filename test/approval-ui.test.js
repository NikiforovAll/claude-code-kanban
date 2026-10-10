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

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

describe('send and terminal key hints', () => {
  it('read Ctrl and Alt on Windows and Linux, Cmd and Option on macOS', () => {
    assert.match(appFunction('sendKbd', { IS_MAC: false })(), /<kbd>Ctrl<\/kbd>\+<kbd>Enter<\/kbd>/);
    assert.match(appFunction('sendKbd', { IS_MAC: true })(), /<kbd>⌘<\/kbd>\+<kbd>Enter<\/kbd>/);
    assert.match(appFunction('termKbd', { IS_MAC: false })(), /<kbd>Alt<\/kbd>/);
    assert.match(appFunction('termKbd', { IS_MAC: true })(), /<kbd>⌥<\/kbd>/);
  });
});

describe('renderPermissionSummary', () => {
  function render(params, waiting = {}, ago = 5000) {
    const now = Date.parse('2026-01-01T00:10:00Z');
    const render = appFunction('renderPermissionSummary', {
      escapeHtml,
      formatDuration: appFunction('formatDuration'),
      renderPermissionDiff: appFunction('renderPermissionDiff', { escapeHtml }),
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      currentWaiting: { timestamp: new Date(now - ago).toISOString(), ...waiting },
    });
    return render('Bash', params);
  }

  it('shows the whole command, escaped', () => {
    const html = render({ command: 'echo "<b>" && rm -rf x', description: 'Clean <up>' });
    assert.match(html, /echo &quot;&lt;b&gt;&quot; &amp;&amp; rm -rf x/);
    assert.match(html, /Clean &lt;up&gt;/);
    assert.doesNotMatch(html, /<b>/);
  });

  it('shows an edit as a diff', () => {
    const html = render({ file_path: 'a.js', old_string: 'one', new_string: 'two\nthree' });
    assert.equal((html.match(/perm-diff-row del/g) || []).length, 1);
    assert.equal((html.match(/perm-diff-row add/g) || []).length, 2);
  });

  it('computes the wait at render time, in seconds then minutes', () => {
    assert.match(render({ command: 'ls' }, {}, 5000), /waiting 5s/);
    assert.match(render({ command: 'ls' }, {}, 125000), /waiting 2m 5s/);
  });

  it('names the working directory', () => {
    assert.match(render({ command: 'ls' }, { cwd: 'C:\\repo' }), /in C:\\repo/);
  });
});

describe('question prompt keys', () => {
  function setup(questions, tab = 0) {
    const calls = [];
    const ctx = {
      waitingQuestions: questions,
      waitingTab: tab,
      showWaitingDetail: () => calls.push('render'),
      waitingAnswerDraft: {},
      waitingCustomDraft: {},
      calls,
    };
    vm.createContext(ctx);
    for (const name of ['setWaitingTab', 'waitingOptionLabel', 'pickWaitingOptionByNumber', 'selectWaitingAnswer']) {
      vm.runInContext(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(app)[0], ctx);
    }
    return ctx;
  }
  const q = (question, ...labels) => ({ question, options: labels.map((label) => ({ label })) });

  it('clamps the tab to the questions plus the Review tab', () => {
    const ctx = setup([q('A', 'x'), q('B', 'y')]);
    ctx.setWaitingTab(9);
    assert.equal(ctx.waitingTab, 2);
    ctx.setWaitingTab(-3);
    assert.equal(ctx.waitingTab, 0);
  });

  it('has no Review tab for a single question', () => {
    const ctx = setup([q('A', 'x')]);
    ctx.setWaitingTab(4);
    assert.equal(ctx.waitingTab, 0);
  });

  it('picks the option for a number key and moves to the next tab', () => {
    const ctx = setup([q('A', 'x', 'y'), q('B', 'z')]);
    ctx.pickWaitingOptionByNumber(1);
    assert.deepEqual([...ctx.waitingAnswerDraft.A], ['y']);
    assert.equal(ctx.waitingTab, 1);
  });

  it('ignores a number with no option', () => {
    const ctx = setup([q('A', 'x')]);
    ctx.pickWaitingOptionByNumber(5);
    assert.deepEqual(Object.keys(ctx.waitingAnswerDraft), []);
    assert.deepEqual([...ctx.calls], []);
  });
});

describe('confirm modal markup', () => {
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  it('has the fields confirmModal fills', () => {
    for (const id of ['confirm-modal-title', 'confirm-modal-message', 'confirm-modal-chip', 'confirm-modal-list', 'confirm-modal-warn']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
  });

  it('accepts a list, steps and a warning', () => {
    assert.match(app, /function confirmModal\(\{ title, message, okLabel, chip, items, steps, warn \}\)/);
  });
});

describe('end all terminals', () => {
  it('asks before ending when a terminal is not idle', () => {
    const src = /^async function endAllTerminals\(\) \{[\s\S]*?^\}/m.exec(app)[0];
    assert.match(src, /confirmModal\(/);
    assert.match(src, /notIdle/);
  });
});

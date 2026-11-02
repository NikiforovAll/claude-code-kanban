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

const DICTATION = ['fieldInserter', 'toggleDictation', 'toggleHubDictation', 'cancelDictation', 'cancelDictationIn'];

function dictationFns(globals) {
  return appFunctions(DICTATION, {
    dictation: null,
    HUB_DICTATE: 'voice.dictate',
    Event,
    navigator: { language: 'en' },
    SpeechRecognitionApi: FakeRecognition,
    hub: hubStub(),
    ...globals,
  });
}

function field(value, start, end = start) {
  return {
    value,
    selectionStart: start,
    selectionEnd: end,
    focused: false,
    isConnected: true,
    inputs: [],
    focus() {
      this.focused = true;
    },
    setSelectionRange(a, b) {
      this.selectionStart = a;
      this.selectionEnd = b;
    },
    dispatchEvent(e) {
      this.inputs.push([e.type, e.bubbles, this.value]);
    },
  };
}

function button() {
  return {
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
  };
}

class FakeRecognition {
  constructor() {
    FakeRecognition.last = this;
    this.started = false;
    this.aborted = false;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.onend();
  }
  abort() {
    this.aborted = true;
    this.onend();
  }
}

function hubStub(can = false, invoke = async () => ({ ok: true })) {
  return { can: () => can, invoke };
}

const noError = () => {};

describe('dictation', () => {
  it('rewrites interim results in place at the caret and fires input for each', () => {
    const ctx = dictationFns();
    const f = field('fix this', 3, 8);
    const insert = ctx.fieldInserter(f);
    insert('the');
    insert('the bug');
    assert.equal(f.value, 'fix the bug');
    assert.equal(f.selectionStart, 'fix the bug'.length);
    assert.deepEqual(f.inputs, [
      ['input', true, 'fix the'],
      ['input', true, 'fix the bug'],
    ]);
  });

  it('adds no space after whitespace or into an empty field', () => {
    const ctx = dictationFns();
    const empty = field('', 0);
    ctx.fieldInserter(empty)('hello');
    assert.equal(empty.value, 'hello');
    const spaced = field('a ', 2);
    ctx.fieldInserter(spaced)('b');
    assert.equal(spaced.value, 'a b');
  });

  it('dictates into the field the mic belongs to and stops on a second click', () => {
    const ctx = dictationFns();
    const f = field('', 0);
    const btn = button();
    ctx.toggleDictation(f, btn, noError);
    const rec = FakeRecognition.last;
    assert.equal(rec.started, true);
    assert.equal(btn.attrs['aria-pressed'], 'true');
    assert.equal(f.focused, true);
    rec.onresult({ results: [[{ transcript: 'looks good' }]] });
    assert.equal(f.value, 'looks good');
    ctx.toggleDictation(f, btn, noError);
    assert.equal(btn.attrs['aria-pressed'], 'false');
    assert.equal(ctx.dictation, null);
  });

  it('cancels the running dictation when another mic starts, and only inside the given root', () => {
    const ctx = dictationFns();
    const a = button();
    const b = button();
    ctx.toggleDictation(field('', 0), a, noError);
    const first = FakeRecognition.last;
    ctx.cancelDictationIn({ contains: (el) => el === b });
    assert.equal(first.aborted, false);
    ctx.toggleDictation(field('', 0), b, noError);
    assert.equal(first.aborted, true);
    assert.equal(a.attrs['aria-pressed'], 'false');
    assert.equal(ctx.dictation.btn, b);
    assert.equal(ctx.dictation.rec, FakeRecognition.last);
    ctx.cancelDictationIn({ contains: (el) => el === b });
    assert.equal(FakeRecognition.last.aborted, true);
    assert.equal(ctx.dictation, null);
  });

  it('reports a blocked microphone through the caller', () => {
    const ctx = dictationFns();
    const errors = [];
    ctx.toggleDictation(field('', 0), button(), (m) => errors.push(m));
    FakeRecognition.last.onerror({ error: 'not-allowed' });
    FakeRecognition.last.onerror({ error: 'no-speech' });
    assert.deepEqual(errors, ['Microphone access is blocked for this page.']);
  });

  it('under the hub, inserts the text on stop and sends cancel when the field closes', async () => {
    const calls = [];
    const invoke = async (_, a) => {
      calls.push(a.op);
      return a.op === 'stop' ? { ok: true, text: 'ship it' } : { ok: true };
    };
    const ctx = dictationFns({ hub: hubStub(true, invoke) });
    const f = field('', 0);
    const btn = button();
    await ctx.toggleDictation(f, btn, noError);
    await ctx.toggleDictation(f, btn, noError);
    assert.equal(f.value, 'ship it');
    await ctx.toggleDictation(f, btn, noError);
    ctx.cancelDictationIn({ contains: () => true });
    assert.deepEqual(calls, ['start', 'stop', 'start', 'cancel']);
    assert.equal(btn.attrs['aria-pressed'], 'false');
    assert.equal(ctx.dictation, null);
  });
});

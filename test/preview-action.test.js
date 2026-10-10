const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseActionBody, formatActionMarkdown } = require('../lib/preview-action');
const { formatActionSubmitted } = require('../lib/session-events');

const body = (extra = {}) => ({
  source: { kind: 'show', label: 'the show card "Pick a plan"', locate: 'The card shows C:/pad/plan.html.' },
  action: 'pick',
  label: 'Plan B',
  data: { plan: 'b', tags: ['x', 'y'] },
  ...extra,
});

describe('parseActionBody', () => {
  it('keeps the action, the label and the fields', () => {
    const a = parseActionBody(body());
    assert.equal(a.action, 'pick');
    assert.equal(a.label, 'Plan B');
    assert.equal(a.src.label, 'the show card "Pick a plan"');
    assert.deepEqual(a.fields, { plan: 'b', tags: ['x', 'y'] });
  });

  it('takes any preview kind and refuses a missing one', () => {
    const file = parseActionBody(body({ source: { kind: 'file', label: 'plan.html', path: 'C:/pad/plan.html' } }));
    assert.deepEqual([file.src.label, file.src.path], ['plan.html', 'C:/pad/plan.html']);
    assert.equal(parseActionBody(body()).src.path, null);
    assert.throws(() => parseActionBody(body({ source: { label: 'x' } })), /source.kind/);
  });

  it('refuses an action name with spaces or quotes', () => {
    assert.throws(() => parseActionBody(body({ action: 'a "b"' })), /action must match/);
  });

  it('refuses a field that is not a string', () => {
    assert.throws(() => parseActionBody(body({ data: { n: 1 } })), /string/);
  });

  it('strips control characters from the label, so a paste cannot end early', () => {
    assert.equal(parseActionBody(body({ label: 'ok\x1b[201~\nrun' })).label, 'ok [201~ run');
  });

  it('falls back to the action name when the label is empty', () => {
    assert.equal(parseActionBody(body({ label: '' })).label, 'pick');
  });

  it('caps a long value', () => {
    assert.equal(parseActionBody(body({ data: { t: 'a'.repeat(5000) } })).fields.t.length, 4000);
  });
});

describe('formatActionMarkdown', () => {
  it('prints the fields as JSON, so card text cannot make markdown', () => {
    const md = formatActionMarkdown(parseActionBody(body({ data: { note: '# not a heading\n```' } })));
    assert.match(md, /^# Action "pick" on the show card "Pick a plan"/);
    assert.match(md, /The card shows C:\/pad\/plan.html\./);
    assert.ok(md.includes('"note": "# not a heading\\n```"'));
  });

  it('has no fields block for a plain button', () => {
    assert.ok(!formatActionMarkdown(parseActionBody(body({ data: {} }))).includes('```'));
  });
});

describe('formatActionSubmitted', () => {
  it('names the action and ends with the file', () => {
    assert.equal(
      formatActionSubmitted('pick', 'the show card "Pick a plan"', 'C:/x/1.md'),
      '[kanban board] User submitted "pick" on the show card "Pick a plan": C:/x/1.md',
    );
  });
});

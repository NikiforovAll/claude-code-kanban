const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseReport, createProgramStatus, createQueryScanner } = require('../lib/program-status');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

describe('parseReport', () => {
  it('reads the spec example', () => {
    assert.deepEqual(parseReport(`state=blocked:kind=auth:app=brew:msg=${b64('Password required to install updates')}`), {
      state: 'blocked', id: '', kind: 'auth', app: 'brew', msg: 'Password required to install updates',
    });
  });

  it('drops a report with no state or an unknown one', () => {
    assert.equal(parseReport('app=brew'), null);
    assert.equal(parseReport('state=paused'), null);
  });

  it('skips a malformed pair and keeps the rest', () => {
    assert.deepEqual(parseReport('state=working:junk:Bad=1:x=a;b'), { state: 'working', id: '' });
  });

  it('takes the last value of a repeated key and strips whitespace', () => {
    assert.equal(parseReport(' state = idle : state=done ').state, 'done');
  });

  it('drops a report whose id breaks the grammar instead of using the root', () => {
    assert.equal(parseReport('state=idle:id=a//b'), null);
    assert.equal(parseReport(`state=idle:id=${'a'.repeat(33)}`), null);
    assert.equal(parseReport(`state=idle:id=${Array(9).fill('a').join('/')}`), null);
    assert.equal(parseReport('state=idle:id=build/test').id, 'build/test');
  });

  it('drops a report whose text has a control character or bad base64', () => {
    assert.equal(parseReport(`state=done:msg=${b64('two\nlines')}`), null);
    assert.equal(parseReport(`state=done:msg=${b64('\u009b31m')}`), null);
    assert.equal(parseReport('state=done:msg=abcde'), null);
    assert.equal(parseReport(`state=done:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`), null);
    assert.equal(parseReport(`state=done:title=${b64('x'.repeat(193))}`), null);
  });

  it('keeps kind only with blocked and progress only with working or blocked', () => {
    assert.equal(parseReport('state=working:kind=permission').kind, undefined);
    assert.equal(parseReport('state=blocked:kind=nope').kind, undefined);
    assert.equal(parseReport('state=working:progress=40').progress, 40);
    assert.equal(parseReport('state=working:progress=101').progress, undefined);
    assert.equal(parseReport('state=working:progress=07').progress, undefined);
    assert.equal(parseReport('state=done:progress=40').progress, undefined);
  });

  it('treats a bad app as absent', () => {
    assert.equal(parseReport(`state=idle:app=${'a'.repeat(33)}`).app, undefined);
  });

  it('drops a sequence over 4096 bytes', () => {
    assert.equal(parseReport(`state=idle:pad=${'a'.repeat(4096)}`), null);
  });
});

describe('createProgramStatus', () => {
  it('answers the feature query', () => {
    assert.equal(createProgramStatus().handle('?'), 'query');
  });

  it('shows the record that needs the most attention, with the app of its nearest ancestor', () => {
    const ps = createProgramStatus();
    assert.equal(ps.handle('state=working:app=claude-code'), true);
    assert.equal(ps.handle('state=blocked:kind=permission:id=agent/1'), true);
    assert.deepEqual(ps.summary(), { state: 'blocked', kind: 'permission', app: 'claude-code', msg: null });
    assert.equal(ps.handle('state=clear:id=agent'), true);
    assert.deepEqual(ps.summary(), { state: 'working', kind: null, app: 'claude-code', msg: null });
  });

  it('says no change when the summary stays the same', () => {
    const ps = createProgramStatus();
    ps.handle('state=working:app=claude-code:progress=10');
    assert.equal(ps.handle('state=working:app=claude-code:progress=90'), false);
    assert.equal(ps.handle('state=working:app=claude-code:msg=VGVzdHM='), true);
    assert.equal(ps.handle('state=nope'), false);
  });

  it('shows a short msg with bidi and invisible format characters removed', () => {
    const ps = createProgramStatus();
    ps.handle(`state=blocked:kind=question:msg=${b64('‮Which ​database?⁦')}`);
    assert.equal(ps.summary().msg, 'Which database?');
    ps.handle(`state=blocked:msg=${b64('x'.repeat(500))}`);
    assert.equal(ps.summary().msg.length, 160);
    assert.ok(ps.summary().msg.endsWith('…'));
  });

  it('replaces a record whole, so a key left out is gone', () => {
    const ps = createProgramStatus();
    ps.handle('state=working:app=brew');
    ps.handle('state=done');
    assert.deepEqual(ps.summary(), { state: 'done', kind: null, app: null, msg: null });
  });

  it('drops working and blocked on a prompt or exit, and keeps done and error', () => {
    const ps = createProgramStatus();
    ps.handle('state=working');
    ps.handle('state=error:id=job');
    assert.equal(ps.dropTransient(), true);
    assert.equal(ps.summary().state, 'error');
  });

  it('clears every record on a clear with no id or a reset', () => {
    const ps = createProgramStatus();
    ps.handle('state=idle');
    ps.handle('state=done:id=a/b');
    ps.handle('state=clear');
    assert.equal(ps.summary(), null);
    ps.handle('state=idle');
    assert.equal(ps.reset(), true);
    assert.equal(ps.summary(), null);
  });

  it('marks a done seen until the next done, and says no change while nothing is finished', () => {
    const ps = createProgramStatus();
    ps.handle('state=working');
    assert.equal(ps.markSeen(), false);
    assert.equal(ps.summary().seen, undefined);
    ps.handle('state=done');
    assert.equal(ps.summary().seen, undefined);
    assert.equal(ps.markSeen(), true);
    assert.equal(ps.summary().seen, true);
    assert.equal(ps.markSeen(), false);
    ps.handle('state=working');
    assert.equal(ps.summary().seen, undefined);
    assert.equal(ps.handle('state=done'), true);
    assert.equal(ps.summary().seen, undefined);
  });

  it('forgets seen on a reset', () => {
    const ps = createProgramStatus();
    ps.handle('state=error');
    ps.markSeen();
    ps.reset();
    ps.handle('state=error');
    assert.equal(ps.summary().seen, undefined);
  });

  it('removes the least recently updated record past 256', () => {
    const ps = createProgramStatus();
    ps.handle('state=blocked:id=first');
    for (let i = 0; i < 256; i++) ps.handle(`state=idle:id=r${i}`);
    assert.equal(ps.summary().state, 'idle');
  });
});

describe('createQueryScanner', () => {
  it('counts each query once, with either terminator and across chunks', () => {
    const scan = createQueryScanner();
    assert.equal(scan('a\x1b]7501;?\x07b\x1b]7501;?\x1b\\'), 2);
    assert.equal(scan('\x1b]75'), 0);
    assert.equal(scan('01;?\x07'), 1);
    assert.equal(scan('plain output'), 0);
    assert.equal(scan('\x1b]7501;state=idle\x07'), 0);
  });
});

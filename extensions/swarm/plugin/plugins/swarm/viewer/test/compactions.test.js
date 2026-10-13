'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { configDir } = require('./helpers');
const { compactionCounter } = require('../lib/compactions');

const BOUNDARY = `${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`;
const LINE = `${JSON.stringify({ type: 'user', message: 'hi' })}\n`;

function transcript(config, sessionId) {
  const dir = path.join(config, 'projects', 'C--work');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '');
  return file;
}

describe('compactionCounter', () => {
  const workers = [{ name: 'calm', sessionId: 's1' }, { name: 'late', sessionId: 's2' }, { name: 'nameless' }];

  it('counts the boundaries of each worker, reading only what was added', () => {
    const config = configDir();
    let t = 0;
    const counter = compactionCounter(config, { checkMs: 10, now: () => t });
    const file = transcript(config, 's1');
    fs.appendFileSync(file, LINE + BOUNDARY + LINE);
    assert.deepEqual([...counter(workers)], [['calm', 1], ['late', null]]);

    fs.appendFileSync(file, BOUNDARY + BOUNDARY.slice(0, 12));
    t = 10;
    assert.equal(counter(workers).get('calm'), 2);

    fs.appendFileSync(file, BOUNDARY.slice(12));
    transcript(config, 's2');
    t = 20;
    assert.deepEqual([...counter(workers)], [['calm', 3], ['late', null]], 'a missing transcript is searched for less often');
    t = 30;
    assert.deepEqual([...counter(workers)], [['calm', 3], ['late', 0]]);
  });

  it('reads a transcript larger than one chunk and skips a line longer than one', () => {
    const config = configDir();
    const file = transcript(config, 's1');
    fs.appendFileSync(file, `${JSON.stringify({ text: 'x'.repeat(1.5 * 2 ** 20) })}\n${BOUNDARY}${LINE.repeat(30_000)}${BOUNDARY}`);
    assert.equal(compactionCounter(config)(workers).get('calm'), 2);
  });

  it('checks a transcript at most once per interval', () => {
    const config = configDir();
    let t = 0;
    const counter = compactionCounter(config, { checkMs: 30_000, now: () => t });
    assert.equal(counter(workers).get('calm'), null);
    const file = transcript(config, 's1');
    fs.appendFileSync(file, BOUNDARY);
    t = 29_999;
    assert.equal(counter(workers).get('calm'), null);
    t = 30_000;
    assert.equal(counter(workers).get('calm'), 1);
    fs.appendFileSync(file, BOUNDARY);
    t = 59_999;
    assert.equal(counter(workers).get('calm'), 1);
    t = 60_000;
    assert.equal(counter(workers).get('calm'), 2);
  });
});

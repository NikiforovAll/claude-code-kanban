const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PARSERS = require.resolve('../lib/parsers');
const freshParsers = () => {
  delete require.cache[PARSERS];
  return require(PARSERS);
};

describe('transcriptActivityMs', () => {
  let dir;
  let file;
  const hourAgo = new Date(Date.now() - 3600e3);
  const activity = (p) => p.transcriptActivityMs(file, fs.statSync(file));

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-activity-'));
    file = path.join(dir, 's.jsonl');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function seed() {
    fs.writeFileSync(file, '{"type":"user"}\n');
    fs.utimesSync(file, hourAgo, hourAgo);
  }

  it('keeps the last activity when only the mtime changes', () => {
    const p = freshParsers();
    seed();
    const first = activity(p);
    fs.utimesSync(file, new Date(), new Date());
    assert.equal(activity(p), first);
  });

  it('moves when the transcript grows', () => {
    const p = freshParsers();
    seed();
    activity(p);
    fs.appendFileSync(file, '{"type":"assistant"}\n');
    assert.equal(activity(p), fs.statSync(file).mtimeMs);
  });

  it('moves when the transcript is replaced', () => {
    const p = freshParsers();
    seed();
    const first = activity(p);
    const tmp = path.join(dir, 'next.jsonl');
    fs.writeFileSync(tmp, '{"type":"user"}\n');
    fs.renameSync(tmp, file);
    assert.notEqual(activity(p), first);
  });

  it('survives a restart through the session cache', () => {
    let p = freshParsers();
    seed();
    const first = activity(p);
    const snapshot = JSON.parse(JSON.stringify(p.exportSessionCaches()));
    fs.utimesSync(file, new Date(), new Date());

    p = freshParsers();
    p.importSessionCaches(snapshot);
    assert.equal(activity(p), first);
  });

  it('drops malformed cache entries', () => {
    seed();
    const p = freshParsers();
    const { ino, size } = fs.statSync(file);
    p.importSessionCaches({ activity: [[file, { ino, size, mtimeMs: '1' }], [file], 'junk', null] });
    assert.equal(activity(p), fs.statSync(file).mtimeMs);
  });
});

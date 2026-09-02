const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fileUrlToPath } = require('../lib/file-url');

const IS_WIN = process.platform === 'win32';

describe('fileUrlToPath', () => {
  it('passes a plain path through untouched', () => {
    const p = IS_WIN ? 'C:\\Users\\a\\notes.md' : '/home/a/notes.md';
    assert.equal(fileUrlToPath(p), p);
  });

  it('passes a relative path through untouched', () => {
    assert.equal(fileUrlToPath('docs/notes.md'), 'docs/notes.md');
  });

  it('leaves other schemes alone', () => {
    assert.equal(fileUrlToPath('https://example.com/a.md'), 'https://example.com/a.md');
  });

  it('returns a non-string unchanged', () => {
    assert.equal(fileUrlToPath(null), null);
    assert.equal(fileUrlToPath(undefined), undefined);
  });

  it('decodes percent escapes', () => {
    const out = fileUrlToPath(IS_WIN ? 'file:///C:/a%20b/n%231.md' : 'file:///home/a%20b/n%231.md');
    assert.match(out, /a b/);
    assert.match(out, /n#1\.md/);
  });

  it('accepts an uppercase scheme', () => {
    const out = fileUrlToPath(IS_WIN ? 'FILE:///C:/a/n.md' : 'FILE:///home/a/n.md');
    assert.ok(!out.startsWith('FILE:'));
  });

  it('returns an unparseable file: URL unchanged', () => {
    assert.equal(fileUrlToPath('file:'), 'file:');
  });
});

describe('fileUrlToPath on Windows spellings', { skip: !IS_WIN }, () => {
  it('converts the standard form', () => {
    assert.equal(fileUrlToPath('file:///C:/Users/a/notes.md'), 'C:\\Users\\a\\notes.md');
  });

  it('converts the backslash form emitted by some Windows apps', () => {
    assert.equal(fileUrlToPath('file:\\\\\\C:\\Users\\a\\notes.md'), 'C:\\Users\\a\\notes.md');
  });

  it('converts a drive letter parked in the authority position', () => {
    assert.equal(fileUrlToPath('file://C:/Users/a/notes.md'), 'C:\\Users\\a\\notes.md');
  });

  it('converts a UNC share to a UNC path', () => {
    assert.equal(fileUrlToPath('file://server/share/notes.md'), '\\\\server\\share\\notes.md');
  });
});

describe('fileUrlToPath on POSIX', { skip: IS_WIN }, () => {
  it('converts the standard form', () => {
    assert.equal(fileUrlToPath('file:///home/a/notes.md'), '/home/a/notes.md');
  });
});

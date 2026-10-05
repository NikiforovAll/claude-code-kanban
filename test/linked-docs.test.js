const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLinkedDocStore, linkUrl, MAX_LINKED_DOCS } = require('../lib/linked-docs');

function fileStore() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cck-links-')), 'linked-docs.json');
  const open = () =>
    createLinkedDocStore({
      load: () => {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
      },
      save: (data) => fs.writeFileSync(file, JSON.stringify(data)),
    });
  return { file, open };
}

describe('linked docs store', () => {
  it('reads a link back at once, keeps it on disk, and unlinks it', () => {
    const { open } = fileStore();
    const docs = open();
    docs.link('s1', '/repo/a.md');
    assert.deepEqual(docs.get('s1'), ['/repo/a.md']);
    assert.deepEqual(open().get('s1'), ['/repo/a.md']);
    assert.equal(docs.unlink('s1', '/repo/a.md'), true);
    assert.deepEqual(docs.get('s1'), []);
    assert.deepEqual(open().all(), {});
  });

  it('puts the newest first and does not list one file twice', () => {
    const docs = fileStore().open();
    docs.link('s1', 'C:\\repo\\a.md');
    docs.link('s1', '/repo/b.md');
    docs.link('s1', 'c:/repo/a.md');
    assert.deepEqual(docs.get('s1'), ['c:/repo/a.md', '/repo/b.md']);
  });

  it('caps each session like the browser list', () => {
    const docs = fileStore().open();
    for (let i = 0; i <= MAX_LINKED_DOCS; i++) docs.link('s1', `/repo/${i}.md`);
    assert.equal(docs.get('s1').length, MAX_LINKED_DOCS);
    assert.equal(docs.get('s1')[0], `/repo/${MAX_LINKED_DOCS}.md`);
    assert.equal(docs.get('s1').at(-1), '/repo/1.md');
  });

  it('clears a session when no path is given, and reports a no-op', () => {
    const docs = fileStore().open();
    docs.link('s1', '/repo/a.md');
    docs.link('s1', '/repo/b.md');
    docs.link('s2', '/repo/c.md');
    assert.equal(docs.unlink('s1'), true);
    assert.equal(docs.unlink('s1', '/repo/a.md'), false);
    assert.equal(docs.unlink('nobody', '/x'), false);
    assert.deepEqual(docs.all(), { s2: ['/repo/c.md'] });
  });

  it('ignores a malformed file', () => {
    const docs = createLinkedDocStore({ load: () => ({ sessions: { s1: 'nope', s2: [1, '/ok.md'] } }), save: () => {} });
    assert.deepEqual(docs.all(), { s2: ['/ok.md'] });
  });

  it('keeps URLs next to paths, with case and fragment intact', () => {
    const docs = fileStore().open();
    docs.link('s1', '/repo/a.md');
    docs.link('s1', 'https://github.com/Org/Repo/pull/12#discussion');
    docs.link('s1', 'https://github.com/Org/Repo/pull/12#discussion');
    assert.deepEqual(docs.get('s1'), ['https://github.com/Org/Repo/pull/12#discussion', '/repo/a.md']);
    assert.equal(docs.unlink('s1', 'https://github.com/Org/Repo/pull/12#discussion'), true);
    assert.deepEqual(docs.get('s1'), ['/repo/a.md']);
  });
});

describe('linkUrl', () => {
  it('normalizes http(s) URLs', () => {
    assert.equal(linkUrl('https://GitHub.com'), 'https://github.com/');
    assert.equal(linkUrl('  http://x.test/a?b=1#c '), 'http://x.test/a?b=1#c');
  });

  it('rejects other schemes and non-URLs', () => {
    for (const v of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/a.md', 'ftp://x.test/', '/repo/a.md', 'C:\\a.md', 'https://', 42, null]) {
      assert.equal(linkUrl(v), null, String(v));
    }
  });
});

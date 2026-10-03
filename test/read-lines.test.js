const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLines } = require('../lib/parsers');

async function withFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-lines-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, content);
  try {
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function linesOf(content) {
  return withFile(content, async (file) => {
    const out = [];
    for await (const line of readLines(file)) out.push(line);
    return out;
  });
}

describe('readLines', () => {
  const cases = {
    empty: '',
    'trailing newline': 'a\nb\n',
    'no trailing newline': 'a\nb',
    'blank lines': '\n\na\n\n',
    crlf: 'a\r\nb\r\n',
    'line longer than a chunk': `${'x'.repeat(3 << 20)}\nshort\n${'y'.repeat((1 << 20) + 7)}`,
    'multi-byte chars across chunk edges': `${'é'.repeat(1 << 20)}\n${'日本'.repeat(400000)}\n`,
    'newline on a chunk edge': `${'a'.repeat((1 << 20) - 1)}\n${'b'.repeat(1 << 20)}\n`,
  };
  for (const [name, content] of Object.entries(cases)) {
    it(`yields what split('\\n') gives: ${name}`, async () => {
      assert.deepEqual(await linesOf(content), content.split('\n'));
    });
  }

  it('rejects for a missing file', async () => {
    await assert.rejects(async () => {
      for await (const _ of readLines(path.join(os.tmpdir(), 'cck-no-such-file.jsonl'))) {}
    });
  });

  it('stops reading when the caller breaks early', async () => {
    const first = await withFile('first\nsecond\n'.repeat(1 << 18), async (file) => {
      for await (const line of readLines(file)) return line;
    });
    assert.equal(first, 'first');
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSessionInfoFromJsonl, exportSessionCaches, importSessionCaches } = require('../lib/parsers');

const env = (dir) => JSON.stringify({ type: 'attachment', attachment: { type: 'environment', snapshot: { scratchpadDirectory: dir } } });
const user = (i, pad) => JSON.stringify({ type: 'user', cwd: 'C:\\repo', timestamp: `2026-11-03T00:00:${String(i % 60).padStart(2, '0')}Z`, message: { content: 'x'.repeat(pad) } });
const reply = (i) => JSON.stringify({ type: 'assistant', message: { model: 'claude', usage: { output_tokens: i }, content: [] } });

function filler(bytes, pad = 900) {
  const lines = [];
  let n = 0;
  for (let i = 0; n < bytes; i++) {
    const line = i % 2 ? reply(i) : user(i, pad);
    lines.push(line);
    n += line.length + 1;
  }
  return lines.join('\n');
}

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cck-last-scratch-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SLUG = 'C:\\tmp\\slug\\s\\scratchpad';
const HASH = 'C:\\tmp\\hash\\s\\scratchpad';

describe('scratchpadDir on a cold scan', () => {
  it('finds the last record in the unread middle of a large transcript', () => {
    withDir((dir) => {
      for (const pad of [700, 1300, 4100, 70_000]) {
        const file = path.join(dir, `${pad}.jsonl`);
        fs.writeFileSync(file, `${[env(SLUG), filler(1_200_000, pad), env(HASH), filler(1_700_000, pad)].join('\n')}\n`);
        assert.equal(readSessionInfoFromJsonl(file).scratchpadDir, HASH, `pad ${pad}`);
      }
    });
  });

  it("keeps the head's record when the middle holds none", () => {
    withDir((dir) => {
      const file = path.join(dir, 's.jsonl');
      fs.writeFileSync(file, `${[env(HASH), filler(3_000_000)].join('\n')}\n`);
      assert.equal(readSessionInfoFromJsonl(file).scratchpadDir, HASH);
    });
  });

  it('does not read a half-written last line', () => {
    withDir((dir) => {
      const file = path.join(dir, 's.jsonl');
      fs.writeFileSync(file, `${[env(SLUG), filler(1_200_000), env(HASH), filler(1_700_000)].join('\n')}\n${env('C:\\new').slice(0, 40)}`);
      assert.equal(readSessionInfoFromJsonl(file).scratchpadDir, HASH);
    });
  });

  it('scans again a saved entry from an older cck that dropped the middle record', () => {
    withDir((dir) => {
      const file = path.join(dir, 's.jsonl');
      fs.writeFileSync(file, `${[env(SLUG), filler(1_200_000), env(HASH), filler(1_700_000)].join('\n')}\n`);
      readSessionInfoFromJsonl(file);
      const [entry] = exportSessionCaches().info.filter(([p]) => p === file);
      const { scratchpadMiddleRead, ...old } = entry[1];
      assert.equal(scratchpadMiddleRead, true);

      const saved = (name, e) => {
        const copy = path.join(dir, name);
        fs.copyFileSync(file, copy);
        const st = fs.statSync(copy);
        importSessionCaches({ info: [[copy, { ...e, scratchpadDir: null, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }]] });
        return copy;
      };
      assert.equal(readSessionInfoFromJsonl(saved('new.jsonl', entry[1])).scratchpadDir, null, 'an entry from this cck is trusted');
      assert.equal(readSessionInfoFromJsonl(saved('old.jsonl', old)).scratchpadDir, HASH);
    });
  });
});

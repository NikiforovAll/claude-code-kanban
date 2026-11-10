'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistory } = require('../lib/history');

test('remove forgets a pad and keeps the rest on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pads-'));
  const file = path.join(dir, 'history.json');
  const h = createHistory(file);
  h.add({ dir: path.join(dir, 'a') });
  h.add({ dir: path.join(dir, 'b') });

  assert.strictEqual(h.remove(path.join(dir, 'a')), true);
  assert.strictEqual(h.remove(path.join(dir, 'a')), false);
  assert.deepStrictEqual(
    createHistory(file)
      .all()
      .map((p) => path.basename(p.dir)),
    ['b'],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

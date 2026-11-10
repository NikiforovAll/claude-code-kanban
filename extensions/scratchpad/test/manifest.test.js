'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createManifests } = require('../lib/manifest');

test('read summarizes a pad and rereads it only when it changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-'));
  const file = path.join(dir, 'scratchpad.json');
  const write = (m, mtime) => {
    fs.writeFileSync(file, JSON.stringify(m));
    fs.utimesSync(file, mtime, mtime);
  };
  write(
    {
      updated: '2026-11-10T10:00:00Z',
      files: [
        { path: 'a.md', type: 'note', group: 'Notes', description: 'First' },
        { path: 'b.md', type: 'reference', group: 'Notes', tags: ['internal-only'] },
        { path: 'tldr.md', type: 'note', group: 'Start here', description: 'The gist' },
      ],
    },
    1000,
  );
  const m = createManifests();
  assert.deepStrictEqual(m.read(dir), {
    files: 3,
    groups: 2,
    types: { note: 2, reference: 1 },
    updated: Date.parse('2026-11-10T10:00:00Z'),
    description: 'The gist',
    internal: true,
  });

  fs.writeFileSync(file, '{ not json');
  fs.utimesSync(file, 1000, 1000);
  assert.strictEqual(m.read(dir).files, 3);

  fs.utimesSync(file, 2000, 2000);
  assert.deepStrictEqual(m.read(dir), { broken: true });

  fs.rmSync(file);
  assert.deepStrictEqual(m.read(dir), { missing: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

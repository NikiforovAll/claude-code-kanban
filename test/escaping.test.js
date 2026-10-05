const { it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const { scan, HINT } = require('./escaping-scan');

// Synced from the hub. escaping-baseline.json is this package's own: lower it when a
// site is fixed, never raise it.
const baseline = JSON.parse(readFileSync(path.join(__dirname, 'escaping-baseline.json'), 'utf8'));

for (const [file, limit] of Object.entries(baseline)) {
  it(`${file} adds no unescaped attribute interpolations`, () => {
    const found = scan(readFileSync(path.join(__dirname, '..', file), 'utf8'));
    const sites = found.map((o) => `  ${file}:${o.line}  ${o.attr}="\${${o.expr}}"`).join('\n');
    assert.ok(found.length <= limit, `${found.length} unescaped, baseline ${limit}. ${HINT}\n${sites}`);
  });
}

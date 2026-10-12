'use strict';

// Stands in for the claude-code-kanban CLI (CCK_CLI). It logs each call to CCK_STUB_LOG, and
// `dispatch list` names the sessions in CCK_STUB_LIVE (comma separated) as running.
const fs = require('node:fs');

const args = process.argv.slice(2);
if (process.env.CCK_STUB_LOG) fs.appendFileSync(process.env.CCK_STUB_LOG, `${args.join(' ')}\n`);
if (args[0] === 'dispatch' && args[1] === 'list') {
  const live = (process.env.CCK_STUB_LIVE ?? '').split(',').filter(Boolean);
  process.stdout.write(JSON.stringify(live.map((session) => ({ session }))));
} else if (args[0] === 'group' && args[1] === 'list') {
  process.stdout.write('{"groups":[]}');
} else {
  process.stdout.write('{}');
}

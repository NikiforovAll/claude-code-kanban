const path = require('node:path');
const { mkdirSync, writeFileSync, renameSync, rmSync } = require('node:fs');

function writeJsonAtomic(file, obj, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

module.exports = { writeJsonAtomic };

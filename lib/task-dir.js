const fs = require('node:fs').promises;
const path = require('node:path');

async function readTaskDir(dir) {
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const entries = await Promise.all(
    files.map(async (file) => {
      try {
        const task = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
        return task && typeof task === 'object' ? { file, task } : null;
      } catch (e) {
        console.error(`Error parsing ${path.join(dir, file)}:`, e.message);
        return null;
      }
    }),
  );
  return entries.filter(Boolean);
}

module.exports = { readTaskDir };

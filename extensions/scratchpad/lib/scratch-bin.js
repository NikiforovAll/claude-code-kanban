'use strict';

const fs = require('node:fs');
const path = require('node:path');

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// .cmd/.bat cannot be spawned without a shell since the CVE-2024-27980 fix, and scratch ships a real
// .exe next to its shim, so the shim resolves to that.
function scratchBin(env = process.env, platform = process.platform) {
  const win = platform === 'win32';
  const exts = win ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, `scratch${ext}`);
      if (!isFile(file)) continue;
      if (!/^\.(cmd|bat)$/i.test(ext)) return file;
      const exe = [path.join(dir, 'scratch.exe'), path.join(path.dirname(dir), 'scratch.exe')].find(isFile);
      if (exe) return exe;
    }
  }
  return null;
}

module.exports = { scratchBin };

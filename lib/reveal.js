const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The command that shows an already-validated absolute path in the OS file manager:
 * a folder opens, a file is selected in its folder where the file manager can do that.
 * @param {string} target
 * @param {boolean} isDir
 * @param {NodeJS.Platform} [platform]
 */
function revealCommand(target, isDir, platform = process.platform) {
  if (platform === 'win32') {
    // explorer.exe reads `/select,` and its path as one argument and takes quotes only
    // around the path, so Node's own quoting of the whole argument opens Documents instead.
    const arg = isDir ? `"${target}"` : `/select,"${target}"`;
    return { cmd: 'explorer.exe', args: [arg], opts: { windowsVerbatimArguments: true } };
  }
  if (platform === 'darwin') return { cmd: 'open', args: isDir ? [target] : ['-R', target], opts: {} };
  return { cmd: 'xdg-open', args: [isDir ? target : path.dirname(target)], opts: {} };
}

function revealInFileManager(target) {
  const { cmd, args, opts } = revealCommand(target, fs.statSync(target).isDirectory());
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts });
  child.on('error', (e) => console.error('File manager failed to start:', e.message));
  child.unref();
}

module.exports = { revealCommand, revealInFileManager };

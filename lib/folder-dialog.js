'use strict';

// Opens the OS folder picker on the machine running cck. The page cannot do this: a
// browser's directory input hands over file contents, never the folder's path.

const { spawn } = require('node:child_process');

// The owner form keeps the dialog above the browser; without it the dialog opens behind.
const WIN_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = "Choose a folder for the new session"',
  '$d.ShowNewFolderButton = $true',
  'if ($d.ShowDialog($owner) -eq "OK") { [Console]::Out.Write($d.SelectedPath) }',
].join('; ');

function candidates(platform) {
  if (platform === 'win32') return [['powershell.exe', ['-NoProfile', '-STA', '-Command', WIN_SCRIPT]]];
  if (platform === 'darwin') return [['osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder for the new session")']]];
  return [
    ['zenity', ['--file-selection', '--directory', '--title=Choose a folder for the new session']],
    ['kdialog', ['--getexistingdirectory', '.', '--title', 'Choose a folder for the new session']],
  ];
}

/**
 * @param {(cmd: string) => string|null} which
 * @returns {Promise<string|null>} the chosen folder, or null when the user cancels
 * @throws when this machine has no folder dialog
 */
function pickFolder(which, platform = process.platform, env = process.env) {
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return Promise.reject(new Error('no display for a folder dialog'));
  }
  const found = candidates(platform).find(([cmd]) => which(cmd));
  if (!found) return Promise.reject(new Error('no folder dialog on this machine (install zenity or kdialog)'));
  const [cmd, args] = found;
  return new Promise((resolve, reject) => {
    const child = spawn(which(cmd), args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    // Every picker exits non-zero on cancel and prints nothing.
    child.on('close', () => {
      const dir = out.trim();
      resolve(dir ? dir.replace(/(.)[/\\]$/, '$1') : null);
    });
  });
}

module.exports = { pickFolder };

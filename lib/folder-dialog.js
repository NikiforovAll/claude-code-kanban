'use strict';

// Opens the OS folder picker on the machine running cck. The page cannot do this: a
// browser's directory input hands over file contents, never the folder's path.

const { spawn } = require('node:child_process');
const { statSync } = require('node:fs');
const path = require('node:path');

// The owner form keeps the dialog above the browser; without it the dialog opens behind.
// The start folder arrives in an env var, never spliced into the script.
const WIN_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = "Choose a folder for the new session"',
  '$d.ShowNewFolderButton = $true',
  'if ($env:CCK_PICK_START) { $d.SelectedPath = $env:CCK_PICK_START }',
  'if ($d.ShowDialog($owner) -eq "OK") { [Console]::Out.Write($d.SelectedPath) }',
].join('; ');

// argv, not string interpolation, so a quote in the path cannot end the AppleScript literal.
const MAC_SCRIPT = [
  'on run argv',
  'if (count of argv) > 0 then',
  'return POSIX path of (choose folder with prompt "Choose a folder for the new session" default location (POSIX file (item 1 of argv)))',
  'end if',
  'return POSIX path of (choose folder with prompt "Choose a folder for the new session")',
  'end run',
];

function candidates(platform, start) {
  // No `.exe`: whichSync appends PATHEXT itself, so `powershell.exe` is never found.
  // pwsh first: on .NET Core the same FolderBrowserDialog is the Explorer-style picker, while
  // Windows PowerShell (.NET Framework) shows the old tree view.
  if (platform === 'win32') {
    const args = ['-NoProfile', '-STA', '-Command', WIN_SCRIPT];
    return [['pwsh', args], ['powershell', args]];
  }
  if (platform === 'darwin') return [['osascript', [...MAC_SCRIPT.flatMap((l) => ['-e', l]), ...(start ? [start] : [])]]];
  return [
    ['zenity', ['--file-selection', '--directory', '--title=Choose a folder for the new session', ...(start ? [`--filename=${start}${path.sep}`] : [])]],
    ['kdialog', ['--getexistingdirectory', start || '.', '--title', 'Choose a folder for the new session']],
  ];
}

// The page sends any text the user typed; only an existing absolute folder is worth opening at.
function startFolder(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * @param {(cmd: string) => string|null} which
 * @param {{ start?: string }} [opts] folder the dialog opens at, ignored unless it exists
 * @returns {Promise<string|null>} the chosen folder, or null when the user cancels
 * @throws when this machine has no folder dialog
 */
function pickFolder(which, opts = {}, platform = process.platform, env = process.env) {
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return Promise.reject(new Error('no display for a folder dialog'));
  }
  const start = startFolder(opts.start);
  const found = candidates(platform, start).find(([cmd]) => which(cmd));
  if (!found) return Promise.reject(new Error('no folder dialog on this machine (install zenity or kdialog)'));
  const [cmd, args] = found;
  return new Promise((resolve, reject) => {
    const child = spawn(which(cmd), args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: start ? { ...env, CCK_PICK_START: start } : env,
    });
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

module.exports = { pickFolder, candidates, startFolder };

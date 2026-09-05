'use strict';

// Some tools hand out a `file://` URL where a path is expected — Explorer's
// "copy as path" on a network share, a PDF viewer's location bar, a chat client
// that linkifies attachments. Windows apps also emit the non-standard backslash
// spelling `file:\\\C:\dir\a.md`. Both are normalized to a plain OS path so the
// user does not have to hand-edit what their clipboard produced.

const { fileURLToPath } = require('url');

// Matches any number of leading slashes before a drive letter, so it re-spells both
// the well-formed `file:///C:/dir` and `file://C:/dir`, where the parser reads C: as
// a host and rejects the URL outright. Anything else — POSIX paths, UNC shares — is
// left for the parser.
const DRIVE_URL = /^file:\/*([a-zA-Z]:.*)$/;

/**
 * Convert a `file://` URL to an OS path. Any other string is returned unchanged,
 * as is a URL too malformed to parse — the caller reports "not found" on the
 * literal text, which is more useful than a parser error.
 * @param {string} value
 */
function fileUrlToPath(value) {
  if (typeof value !== 'string' || !/^file:/i.test(value)) return value;
  // Backslashes are not legal in a URL, so this cannot corrupt a well-formed one.
  let url = value.replace(/\\/g, '/');
  // A scheme with no path body: POSIX Node resolves it to "/" rather than throwing.
  if (/^file:\/*$/i.test(url)) return value;
  const drive = DRIVE_URL.exec(url);
  if (drive) url = `file:///${drive[1]}`;
  try {
    return fileURLToPath(url);
  } catch {
    return value;
  }
}

module.exports = { fileUrlToPath };

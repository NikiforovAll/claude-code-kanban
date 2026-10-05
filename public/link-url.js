// Loaded by the page as a plain script and by lib/linked-docs.js through require, so the
// sidebar, the API and the CLI accept the same URLs and keep the same number of docs.
const MAX_LINKED_DOCS = 200;

// Only http(s): linked docs render as links, so a `javascript:` or `data:` value sent
// through the API must not become one.
function linkUrl(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return null;
  try {
    return new URL(v).href;
  } catch {
    return null;
  }
}

if (typeof module === 'object' && module.exports) module.exports = { linkUrl, MAX_LINKED_DOCS };

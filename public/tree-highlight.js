// Loaded by the page as a plain script and by the tests through require.
// Highlights plain-text call trees and flows in message code blocks. The output only wraps the
// input in spans, so a copy of the block stays byte-identical to what Claude wrote.
const treeHighlight = (() => {
  const TREE_TAGS = new Set(['tree', 'callstack', 'flow']);
  const PLAIN_TAGS = new Set(['', 'text', 'txt', 'plaintext', 'diff']);
  const TREE_LINE = /^[+-]?[ \t]*[│├└▼]/;
  const BOX_CORNERS = /[┌┐┬┼┴┘╔╗╚╝╠╣╦╩╬]/;
  const NAME = String.raw`[\p{L}_$@][\p{L}\p{N}_$@.:<>\-/\\]*`;
  const LINE = new RegExp(
    String.raw`^([+-](?=[ \t│├└▼]|$))?([ \t]*(?:[│├└─▼↓→ \t]*[│├└─▼↓→][ \t]*)?)(${NAME})?(.*)$`,
    'su',
  );
  const INDENT_NODE_LINE = new RegExp(String.raw`^([ \t]*)${NAME}(\([^()]*\))?( {2,}\S.*)?$`, 'u');

  function escapeText(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function span(cls, s) {
    return s ? `<span class="${cls}">${escapeText(s)}</span>` : '';
  }

  // Two tree lines at least, and no table corners: box tables and ASCII art draw with those.
  function looksLikeTree(text) {
    if (BOX_CORNERS.test(text)) return false;
    let hits = 0;
    for (const line of text.split('\n')) {
      if (TREE_LINE.test(line) && ++hits >= 2) return true;
    }
    return false;
  }

  // A call tree drawn with indentation only: every line is one name or call, with an optional
  // note after two spaces. Prose and pseudocode have single-spaced words, so they never match.
  function looksLikeIndentTree(text, diff) {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length < 3) return false;
    const indents = new Set();
    for (const raw of lines) {
      if (diff && !/^[ +-]/.test(raw)) return false;
      const m = (diff ? raw.slice(1) : raw).match(INDENT_NODE_LINE);
      if (!m) return false;
      indents.add(m[1].length);
    }
    return indents.size >= 2;
  }

  function wantsTree(lang, text) {
    const tag = (lang || '').trim().toLowerCase();
    if (TREE_TAGS.has(tag)) return true;
    return PLAIN_TAGS.has(tag) && (looksLikeTree(text) || looksLikeIndentTree(text, tag === 'diff'));
  }

  function highlightLine(line) {
    const [, marker = '', glyphs, node = '', rest] = line.match(LINE);
    const body = span('hljs-punctuation', glyphs) + span('hljs-title', node) + escapeText(rest);
    if (!marker) return body;
    return `<span class="${marker === '+' ? 'hljs-addition' : 'hljs-deletion'}">${marker}${body}</span>`;
  }

  function highlightTree(text) {
    return text.split('\n').map(highlightLine).join('\n');
  }

  return { wantsTree, highlightTree };
})();

if (typeof module === 'object' && module.exports) module.exports = treeHighlight;

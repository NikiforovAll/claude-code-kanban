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
  const FRAME = new RegExp(String.raw`^( *)(~.*?|${NAME}(?:\([^()]*\))?)( \*)?(?:( {2,})(\S(?:.*\S)?))?( *)$`, 'u');
  const LOC = /^[^\s:]+:\d+(?::\d+)?$/;

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

  // The notation of skills/show/references/explain.md: frames indented by spaces, one name or
  // call each, an optional ` *` focus mark, a note after 2+ spaces, `~` folds, and `+`/`-` in
  // column 1 for a change. Prose and pseudocode have single-spaced words, so they never parse.
  function parseStack(text) {
    const lines = text.split('\n');
    const diff = lines.some((l) => /^[+-]/.test(l));
    const rows = [];
    let roots = [];
    let stack = [];
    for (const line of lines) {
      if (!line.trim()) {
        rows.push({ blank: true, text: line });
        roots = [];
        stack = [];
        continue;
      }
      const marker = diff ? line[0] : '';
      if (diff && !/[ +-]/.test(marker)) return null;
      const m = line.slice(marker.length).match(FRAME);
      if (!m) return null;
      const [, ind, label, star = '', gap = '', note = '', tail] = m;
      while (stack.length && stack[stack.length - 1].indent >= ind.length) stack.pop();
      const parent = stack[stack.length - 1] || null;
      const sibs = parent ? parent.kids : roots;
      const row = {
        id: rows.length,
        marker,
        indent: ind.length,
        parent,
        sibs,
        label,
        fold: label.startsWith('~'),
        star,
        gap,
        note,
        tail,
        kids: [],
      };
      sibs.push(row);
      stack.push(row);
      rows.push(row);
    }
    return rows;
  }

  // An untagged call tree: 3 frames at least, on 2 indent levels at least.
  function looksLikeIndentTree(text) {
    const frames = parseStack(text)?.filter((r) => !r.blank) || [];
    return frames.length >= 3 && new Set(frames.map((r) => r.indent)).size >= 2;
  }

  function wantsTree(lang, text) {
    const tag = (lang || '').trim().toLowerCase();
    if (TREE_TAGS.has(tag)) return true;
    return PLAIN_TAGS.has(tag) && (looksLikeTree(text) || looksLikeIndentTree(text));
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

  const isLast = (row) => row.sibs[row.sibs.length - 1] === row;

  function guideCells(row) {
    const g = Array(row.indent).fill('');
    if (row.parent) {
      for (let a = row.parent; a.parent; a = a.parent) if (!isLast(a)) g[a.parent.indent] = 'v';
      g[row.parent.indent] = isLast(row) ? 'l' : 't';
      if (row.parent.indent + 1 < row.indent) g[row.parent.indent + 1] = 'h';
    }
    return g.map((c) => (c ? `<span class="ct-g ct-${c}"> </span>` : ' ')).join('');
  }

  function renderRow(row) {
    if (row.blank) return `<span class="ct-row">${row.text}</span>`;
    const cls = ['ct-row'];
    if (row.star) cls.push('ct-focus');
    if (row.marker === '+') cls.push('ct-add');
    if (row.marker === '-') cls.push('ct-del');
    const above = [];
    for (let a = row.parent; a; a = a.parent) above.push(a);
    if (above.some((a) => !a.open)) cls.push('ct-hidden');
    if (above.some((a) => a.fold)) cls.push('ct-lib');
    let attrs = above.length ? ` data-ct-in="${above.map((a) => a.id).join(' ')}"` : '';
    let label;
    if (row.fold) {
      cls.push('ct-fold');
      label = `<span class="ct-tilde">~</span>${escapeText(row.label.slice(1))}`;
    } else {
      label = span('ct-name', row.label);
    }
    if (row.kids.length) {
      cls.push('ct-has');
      attrs += ` data-ct="${row.id}" role="button" tabindex="0" aria-expanded="${row.open}"`;
    }
    return (
      `<span class="${cls.join(' ')}"${attrs}>` +
      span('ct-m', row.marker) +
      guideCells(row) +
      label +
      span('ct-star', row.star) +
      row.gap +
      span(LOC.test(row.note) ? 'ct-loc' : 'ct-note', row.note) +
      row.tail +
      '</span>'
    );
  }

  // Rows are blocks, so the newlines between them sit in hidden spans: the text stays
  // byte-identical and the rows draw no blank lines.
  function renderTree(text) {
    const rows = parseStack(text);
    if (!rows) return `<pre><code class="hljs language-tree">${highlightTree(text)}</code></pre>`;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.parent && (r.star || r.marker === '+' || r.marker === '-' || r.holdsPoint)) r.parent.holdsPoint = true;
    }
    for (const r of rows) r.open = !r.fold || !!r.holdsPoint;
    return `<pre><code class="hljs ct">${rows.map(renderRow).join('<span class="ct-nl">\n</span>')}</code></pre>`;
  }

  function toggleFold(fold) {
    fold.setAttribute('aria-expanded', String(fold.getAttribute('aria-expanded') !== 'true'));
    const code = fold.closest('code');
    const closed = new Set();
    for (const f of code.querySelectorAll('.ct-has[aria-expanded="false"]')) closed.add(f.dataset.ct);
    for (const r of code.querySelectorAll('[data-ct-in]')) {
      r.classList.toggle(
        'ct-hidden',
        r.dataset.ctIn.split(' ').some((id) => closed.has(id)),
      );
    }
  }

  // Lights the callers of `row` up to the root; null clears the block that had them.
  let pathCode = null;
  function markPath(row) {
    for (const r of pathCode?.querySelectorAll('.ct-path') || []) r.classList.remove('ct-path');
    pathCode = row?.closest('code') || null;
    for (const id of row?.dataset.ctIn?.split(' ') || []) {
      pathCode.querySelector(`[data-ct="${id}"]`)?.classList.add('ct-path');
    }
  }

  return { wantsTree, highlightTree, renderTree, toggleFold, markPath };
})();

if (typeof module === 'object' && module.exports) module.exports = treeHighlight;

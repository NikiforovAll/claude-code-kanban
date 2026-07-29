// Inlines an HTML file's local assets so it renders standalone inside the preview's
// `srcdoc` iframe. An `about:srcdoc` document has no URL of its own, so every relative
// href resolves against the app origin and 404s — the only way a sibling stylesheet,
// script or image can reach the frame is embedded in the document text.
//
// Remote refs (https:, //cdn, data:) are left untouched: they already resolve.

const path = require('path');
const fs = require('fs').promises;

// Individually large assets are the ones that blow up as base64 (+33%), and the total
// guards the modal: the whole document is handed to the client in one JSON response.
// Both count bytes on disk, charged once per unique file — the delivered document is
// larger than the total whenever an asset is base64'd or referenced twice.
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
// @import chains are followed, so a cycle needs both a depth stop and a seen-set.
const MAX_IMPORT_DEPTH = 5;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'text/javascript'
};

function isRemoteRef(ref) {
  return !ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#');
}

function mimeFor(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Reads an attribute out of a tag, quoted or bare. Returns undefined when absent.
function attrOf(tag, name) {
  const q = new RegExp(`${name.replace(':', '\\:')}\\s*=\\s*(['"])(.*?)\\1`, 'i');
  return tag.match(q)?.[2] ?? tag.match(new RegExp(`${name.replace(':', '\\:')}\\s*=\\s*([^\\s>]+)`, 'i'))?.[1];
}

// Rewrites every match of `re` in one pass: `fn` receives the match array and returns
// the replacement, or null to leave that match alone. Replacements are resolved
// concurrently (each reads its own asset) and spliced by offset, so the string is
// rebuilt once instead of once per match.
async function replaceMatches(text, re, fn) {
  const matches = [...text.matchAll(re)];
  if (!matches.length) return text;
  const replacements = await Promise.all(matches.map(m => fn(m)));
  const out = [];
  let cursor = 0;
  matches.forEach((m, i) => {
    if (replacements[i] == null) return;
    out.push(text.slice(cursor, m.index), replacements[i]);
    cursor = m.index + m[0].length;
  });
  out.push(text.slice(cursor));
  return out.join('');
}

// One context threads through a whole document: the cache means an asset referenced by
// twenty rules is read, size-checked and charged exactly once, and nested @import/url()
// chains can't each spend the full allowance.
async function loadAsset(absPath, ctx) {
  if (!ctx.cache.has(absPath)) {
    ctx.cache.set(
      absPath,
      (async () => {
        const stat = await fs.stat(absPath);
        if (!stat.isFile()) throw new Error('not a file');
        if (stat.size > MAX_ASSET_BYTES || ctx.spent + stat.size > MAX_TOTAL_BYTES) {
          ctx.skipped.push({ path: absPath, size: stat.size, reason: 'too large' });
          return null;
        }
        ctx.spent += stat.size;
        return fs.readFile(absPath);
      })()
    );
  }
  return ctx.cache.get(absPath);
}

async function loadText(absPath, ctx) {
  return (await loadAsset(absPath, ctx))?.toString('utf8') ?? null;
}

async function toDataUri(absPath, ctx) {
  const buf = await loadAsset(absPath, ctx);
  return buf === null ? null : `data:${mimeFor(absPath)};base64,${buf.toString('base64')}`;
}

// Resolves a ref against `baseDir` and hands the loaded asset to `use`. Remote refs and
// unreadable files yield null, which every caller treats as "leave the markup as
// authored" so the frame degrades to the pre-inlining behaviour.
async function withAsset(ref, baseDir, use) {
  if (isRemoteRef(ref)) return null;
  try {
    return await use(path.resolve(baseDir, ref));
  } catch {
    return null;
  }
}

const CSS_IMPORT = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/gi;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

// Rewrites url(...) targets and follows @import into the imported sheet's own directory —
// a nested sheet's relative refs are relative to *it*, not to the document.
async function inlineCss(css, baseDir, ctx, depth = 0, seen = new Set()) {
  let out = css;

  if (depth < MAX_IMPORT_DEPTH) {
    out = await replaceMatches(out, CSS_IMPORT, ([, , ref, media]) =>
      withAsset(ref, baseDir, async abs => {
        if (seen.has(abs)) return null;
        const text = await loadText(abs, ctx);
        if (text === null) return null;
        const nested = await inlineCss(text, path.dirname(abs), ctx, depth + 1, new Set([...seen, abs]));
        // A media query on the @import has to survive as a wrapper or the rules leak.
        return media.trim() ? `@media ${media.trim()}{\n${nested}\n}` : nested;
      })
    );
  }

  return replaceMatches(out, CSS_URL, ([, , ref]) =>
    withAsset(ref, baseDir, async abs => {
      const uri = await toDataUri(abs, ctx);
      return uri && `url("${uri}")`;
    })
  );
}

// `</script>` anywhere in inlined JS (a string, a regex, a template) would close the tag
// early and dump the rest as markup.
function escapeScript(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

function inlineStylesheets(html, baseDir, ctx) {
  return replaceMatches(html, /<link\b[^>]*>/gi, async ([tag]) => {
    if (!/rel\s*=\s*(['"]?)[^'">]*\bstylesheet\b/i.test(tag)) return null;
    return withAsset(attrOf(tag, 'href'), baseDir, async abs => {
      const css = await loadText(abs, ctx);
      if (css === null) return null;
      const inlined = await inlineCss(css, path.dirname(abs), ctx, 0, new Set([abs]));
      const media = attrOf(tag, 'media');
      return `<style${media ? ` media="${media}"` : ''}>\n${inlined}\n</style>`;
    });
  });
}

function inlineStyleElements(html, baseDir, ctx) {
  return replaceMatches(html, /<style\b[^>]*>([\s\S]*?)<\/style>/gi, async ([tag, css]) => {
    if (!/url\(|@import/i.test(css)) return null;
    const inlined = await inlineCss(css, baseDir, ctx);
    return inlined === css ? null : tag.replace(css, inlined);
  });
}

function inlineScripts(html, baseDir, ctx) {
  return replaceMatches(html, /<script\b[^>]*\bsrc\s*=[^>]*>\s*<\/script>/gi, ([tag]) =>
    withAsset(attrOf(tag, 'src'), baseDir, async abs => {
      const js = await loadText(abs, ctx);
      if (js === null) return null;
      // Keep type= (module vs classic changes semantics); drop src/defer/async, which
      // mean nothing once the body is inline.
      const type = attrOf(tag, 'type');
      return `<script${type ? ` type="${type}"` : ''}>\n${escapeScript(js)}\n</script>`;
    })
  );
}

// src/poster/href on media and image tags. `<use href>` covers sprite sheets, which are
// the one SVG case that silently renders nothing when unresolved.
const SRC_ATTR_TAGS = /<(img|source|video|audio|use)\b[^>]*>/gi;
const SRC_ATTR = /\b(src|poster|href|xlink:href)\s*=\s*(['"])(.*?)\2/gi;

function inlineElementSrcs(html, baseDir, ctx) {
  return replaceMatches(html, SRC_ATTR_TAGS, async ([tag]) => {
    let out = await replaceMatches(tag, SRC_ATTR, ([, name, , ref]) =>
      withAsset(ref, baseDir, async abs => {
        const uri = await toDataUri(abs, ctx);
        return uri && `${name}="${uri}"`;
      })
    );
    // srcset is a comma-separated candidate list, each entry `url [descriptor]`.
    const srcset = out.match(/srcset\s*=\s*(['"])(.*?)\1/i);
    if (srcset) {
      const parts = await Promise.all(
        srcset[2].split(',').map(async entry => {
          const [ref, ...rest] = entry.trim().split(/\s+/);
          const uri = await withAsset(ref, baseDir, abs => toDataUri(abs, ctx));
          return uri ? [uri, ...rest].join(' ') : entry.trim();
        })
      );
      out = out.replace(srcset[0], `srcset="${parts.join(', ')}"`);
    }
    return out === tag ? null : out;
  });
}

/**
 * Embeds every resolvable local asset an HTML document references.
 *
 * @returns {Promise<{ html: string, bytes: number, skipped: Array<{path:string,size:number,reason:string}> }>}
 */
async function inlineHtmlAssets(html, absHtmlPath) {
  const baseDir = path.dirname(absHtmlPath);
  const ctx = { spent: 0, skipped: [], cache: new Map() };
  // Author-written <style> blocks first: after inlineStylesheets a <link> has become a
  // <style> whose refs are already resolved, and re-walking megabytes of data URIs to
  // find nothing is the one pass worth ordering around.
  let out = await inlineStyleElements(html, baseDir, ctx);
  out = await inlineStylesheets(out, baseDir, ctx);
  out = await inlineScripts(out, baseDir, ctx);
  out = await inlineElementSrcs(out, baseDir, ctx);
  return { html: out, bytes: ctx.spent, skipped: ctx.skipped };
}

module.exports = { inlineHtmlAssets, MAX_ASSET_BYTES };

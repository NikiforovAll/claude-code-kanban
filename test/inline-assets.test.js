const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, mkdirSync, mkdtempSync, rmSync } = require('fs');
const path = require('path');
const os = require('os');

const { inlineHtmlAssets, MAX_ASSET_BYTES } = require('../lib/inline-assets');

let dir;
const w = (rel, content) => {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
};
const run = async (html, rel = 'page.html') => (await inlineHtmlAssets(html, w(rel, html))).html;

describe('inlineHtmlAssets', () => {
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'inline-assets-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('inlines a sibling stylesheet and drops the link', async () => {
    w('lf.css', 'body{color:red}');
    const out = await run('<link rel="stylesheet" href="lf.css">');
    assert.match(out, /<style>\s*body\{color:red\}\s*<\/style>/);
    assert.doesNotMatch(out, /<link/);
  });

  it('leaves remote stylesheets, scripts and images untouched', async () => {
    const html = [
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
      '<link rel="preconnect" href="https://fonts.gstatic.com">',
      '<script src="//cdn.example.com/x.js"></script>',
      '<img src="data:image/png;base64,AAAA">'
    ].join('');
    assert.equal(await run(html, 'remote.html'), html);
  });

  it('preserves a media attribute on the inlined sheet', async () => {
    w('print.css', 'p{margin:0}');
    const out = await run('<link rel="stylesheet" media="print" href="print.css">', 'media.html');
    assert.match(out, /<style media="print">/);
  });

  it('follows @import relative to the imported sheet and wraps its media query', async () => {
    w('css/base.css', 'h1{font-size:2rem}');
    w('css/main.css', '@import url("base.css") screen;\nh2{font-size:1rem}');
    const out = await run('<link rel="stylesheet" href="css/main.css">', 'imports.html');
    assert.match(out, /@media screen\{\s*h1\{font-size:2rem\}\s*\}/);
    assert.match(out, /h2\{font-size:1rem\}/);
    assert.doesNotMatch(out, /@import/);
  });

  it('rewrites url() inside a stylesheet relative to that stylesheet', async () => {
    w('assets/dot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    w('assets/theme.css', '.a{background:url(dot.png)}');
    const out = await run('<link rel="stylesheet" href="assets/theme.css">', 'urls.html');
    assert.match(out, /url\("data:image\/png;base64,iVBORw==?"\)/);
  });

  it('rewrites url() in an inline <style> block relative to the document', async () => {
    w('logo.svg', '<svg/>');
    const out = await run('<style>.b{background:url("logo.svg")}</style>', 'inline-style.html');
    assert.match(out, /url\("data:image\/svg\+xml;base64,/);
  });

  it('survives an @import cycle', async () => {
    w('a.css', '@import "b.css";\n.a{}');
    w('b.css', '@import "a.css";\n.b{}');
    const out = await run('<link rel="stylesheet" href="a.css">', 'cycle.html');
    assert.match(out, /\.a\{\}/);
    assert.match(out, /\.b\{\}/);
  });

  it('inlines a local script, keeps type, and escapes a nested closing tag', async () => {
    w('app.js', 'const s = "</script>";');
    const out = await run('<script type="module" src="app.js"></script>', 'script.html');
    assert.match(out, /<script type="module">/);
    assert.match(out, /<\\\/script>/);
    // Only the real closing tag remains unescaped.
    assert.equal(out.match(/<\/script>/g).length, 1);
  });

  it('inlines img src, poster and srcset candidates', async () => {
    w('a.png', Buffer.from([1]));
    w('b.png', Buffer.from([2]));
    const out = await run(
      '<img src="a.png" srcset="a.png 1x, b.png 2x, https://x.test/c.png 3x">' +
        '<video poster="b.png"></video>',
      'media-tags.html'
    );
    assert.match(out, /src="data:image\/png;base64,AQ=="/);
    assert.match(out, /poster="data:image\/png;base64,Ag=="/);
    assert.match(out, /srcset="data:[^"]+ 1x, data:[^"]+ 2x, https:\/\/x\.test\/c\.png 3x"/);
  });

  it('leaves a missing asset as authored', async () => {
    const html = '<link rel="stylesheet" href="nope.css"><img src="gone.png">';
    assert.equal(await run(html, 'missing.html'), html);
  });

  it('skips an asset over the per-asset cap and reports it', async () => {
    const big = path.join(dir, 'big.css');
    writeFileSync(big, 'a'.repeat(MAX_ASSET_BYTES + 1));
    const html = '<link rel="stylesheet" href="big.css">';
    const res = await inlineHtmlAssets(html, w('big.html', html));
    assert.equal(res.html, html);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].reason, 'too large');
  });

  it('is idempotent — a second pass changes nothing', async () => {
    w('lf.css', 'body{color:red}');
    const html = '<link rel="stylesheet" href="lf.css"><img src="a.png">';
    const abs = w('idem.html', html);
    const once = (await inlineHtmlAssets(html, abs)).html;
    assert.equal((await inlineHtmlAssets(once, abs)).html, once);
  });

  it('charges a repeated asset once, and embeds it at every reference', async () => {
    w('dup.css', '.a{background:url(px.png)}.b{background:url(px.png)}');
    w('px.png', Buffer.from([9]));
    const html = '<link rel="stylesheet" href="dup.css"><img src="px.png">';
    const res = await inlineHtmlAssets(html, w('dup.html', html));
    assert.equal((res.html.match(/data:image\/png;base64,CQ==/g) || []).length, 3);
    // 52-byte sheet + a 1-byte png read once, not once per reference.
    assert.equal(res.bytes, 53);
  });

  it('reports the byte total it embedded', async () => {
    w('size.css', 'x'.repeat(100));
    const html = '<link rel="stylesheet" href="size.css">';
    const res = await inlineHtmlAssets(html, w('size.html', html));
    assert.equal(res.bytes, 100);
  });
});

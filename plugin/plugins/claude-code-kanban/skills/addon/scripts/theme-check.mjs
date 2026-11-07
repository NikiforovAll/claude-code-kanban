// Static theme check for an add-on page: node theme-check.mjs <page.html>. Exits 1 on an error.
// The token list mirrors the HTML contract in skills/show/SKILL.md.
import { readFileSync } from 'node:fs';

const CONTRACT = new Set([
  '--color-bg', '--color-bg-subtle', '--color-text', '--color-text-muted', '--color-border', '--color-accent',
  '--color-info', '--color-success', '--color-warning', '--color-danger', '--font-sans', '--font-mono', '--color-scheme',
  ...Array.from({ length: 8 }, (_, i) => `--color-series-${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `--color-ramp-${i + 1}`),
]);
const NAMED = 'white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|navy|teal|maroon|olive|lime|aqua|fuchsia|gold|crimson|tomato|coral|salmon|indigo|violet|brown|beige|ivory|khaki|lavender|tan|cyan|magenta|whitesmoke|gainsboro|lightgray|lightgrey|darkgray|darkgrey|dimgray|dimgrey';
const RAW_FN = '#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\(';
const RAW = new RegExp(`${RAW_FN}|\\b(?:${NAMED})\\b`, 'i');
// In JS a named color is too likely an ordinary word, so only hex and color functions count.
const RAW_JS = new RegExp(RAW_FN, 'i');
const COLOR_PROPS = /^(?:color|background(?:-color|-image)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?|stop-color|flood-color|lighting-color|--[\w-]+)$/i;

const file = process.argv[2];
const src = readFileSync(file, 'utf8');
const lineOf = (i) => src.slice(0, i).split('\n').length;
const findings = [];
const report = (level, i, rule, text) =>
  findings.push({ level, line: i == null ? 0 : lineOf(i), rule, text: text.trim().slice(0, 110) });

const usedVars = new Set();
const definedVars = new Set();
const fallbackVars = new Set();
const collectVars = (s) => {
  for (const v of s.matchAll(/var\(\s*(--[\w-]+)/g)) usedVars.add(v[1]);
};
const stripVars = (s) => s.replace(/var\([^)]*\)/g, '');

// CSS: every declaration inside <style> blocks and style="" attributes.
function checkCss(css, base, inline) {
  const bodies = inline
    ? [{ sel: '[style]', body: css, at: 0 }]
    : [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2], at: m.index + m[1].length + 1 }));
  for (const { sel, body, at } of bodies) {
    const isRoot = /(^|,)\s*(:where\(\s*:root\s*\)|:root|html)\s*$/.test(sel);
    for (const d of body.matchAll(/([-\w]+)\s*:\s*([^;]+)/g)) {
      const [, prop, value] = d;
      const i = base + at + d.index;
      collectVars(value);
      if (prop.startsWith('--')) {
        definedVars.add(prop);
        if (isRoot && CONTRACT.has(prop)) fallbackVars.add(prop);
      }
      if (/^font(-family)?$/.test(prop) && !/var\(--font-/.test(value) && !/^(inherit|initial|unset)$/.test(value.trim()))
        report('warn', i, 'font-literal', `${prop}: ${value}`);
      if (!COLOR_PROPS.test(prop) || !RAW.test(stripVars(value))) continue;
      if (isRoot && CONTRACT.has(prop)) continue; // fallback value for a board token
      if (/^(?:transparent|currentcolor|inherit|none)$/i.test(value.trim())) continue;
      report('error', i, prop.startsWith('--') ? 'raw-color-in-custom-prop' : 'raw-color', `${sel ? `${sel.split('\n').pop().trim()} { ` : ''}${prop}: ${value}`);
    }
  }
}

for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) checkCss(m[1], m.index + m[0].indexOf(m[1]), false);
for (const m of src.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) checkCss(m[1], m.index, true);
for (const m of src.matchAll(/\s(fill|stroke|color|bgcolor|stop-color)\s*=\s*"([^"]*)"/gi)) {
  collectVars(m[2]);
  if (RAW.test(stripVars(m[2]))) report('error', m.index, 'raw-color-attr', `${m[1]}="${m[2]}"`);
}

// JS: string literals and template parts that carry a color.
let hasListener = false;
for (const m of src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
  const js = m[1];
  const base = m.index + m[0].indexOf(js);
  if (/cck-show:tokens/.test(js)) hasListener = true;
  for (const s of js.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const str = s[2];
    collectVars(str);
    const selectorArg = /(?:querySelector(?:All)?|closest|matches|getElementById)\(\s*$/.test(js.slice(Math.max(0, s.index - 30), s.index));
    if (!selectorArg && RAW_JS.test(stripVars(str)))
      report('error', base + s.index, 'raw-color-js', s[0]);
  }
}

if (!/color-scheme\s*:\s*var\(\s*--color-scheme/.test(src))
  report('warn', null, 'no-color-scheme', 'color-scheme does not follow var(--color-scheme): scrollbars and native controls follow the OS');
if (!hasListener) report('error', null, 'no-token-listener', "no 'cck-show:tokens' message listener");
for (const v of usedVars) {
  if (!CONTRACT.has(v) && !definedVars.has(v)) report('warn', null, 'unknown-var', `${v} is not a board token and is not defined`);
  if (CONTRACT.has(v) && v !== '--color-scheme' && !fallbackVars.has(v)) report('warn', null, 'no-fallback', `${v} has no fallback in :where(:root)`);
}
const unused = [...CONTRACT].filter((t) => !usedVars.has(t) && !t.startsWith('--color-series') && !t.startsWith('--color-ramp') && t !== '--color-scheme');
if (unused.length) report('info', null, 'unused-tokens', unused.join(', '));

findings.sort((a, b) => a.line - b.line);
for (const f of findings) console.log(`${f.level.padEnd(5)} ${String(f.line || '-').padStart(4)}  ${f.rule.padEnd(24)} ${f.text}`);
const errors = findings.filter((f) => f.level === 'error').length;
console.log(`\n${errors} error(s), ${findings.filter((f) => f.level === 'warn').length} warning(s)`);
process.exit(errors ? 1 : 0);

const fs = require('node:fs');
const path = require('node:path');
const { SKILL, loadEvals, chromium, findRuns } = require('./lib.cjs');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node grade.cjs <iteration dir>');
  process.exit(1);
}

const firstStyle = (html) => /<style[^>]*>([\s\S]*?)<\/style>/i.exec(html)?.[1] ?? null;
const templateCss = firstStyle(fs.readFileSync(path.join(SKILL, 'template.html'), 'utf8'));
const EVALS = new Map(loadEvals().map((e) => [e.name, e]));

// A host (cck pane, hub) injects its tokens first in <head>; a page that follows the theme lets them win.
const HOST = '<style>:root{--color-bg:#123456;--color-text:#fedcba}</style>';
const withHostTokens = (html) => {
  const at = /<head[^>]*>/i.exec(html);
  return at ? html.slice(0, at.index + at[0].length) + HOST + html.slice(at.index + at[0].length) : HOST + html;
};

function evalOf(runDir) {
  for (let d = runDir; d !== path.dirname(d); d = path.dirname(d)) {
    const m = path.join(d, 'eval_metadata.json');
    if (fs.existsSync(m)) return EVALS.get(JSON.parse(fs.readFileSync(m, 'utf8')).eval_name) || {};
  }
  return {};
}

async function render(browser, html, opts) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: 'light', ...opts });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

async function grade(browser, runDir) {
  const html = fs.readFileSync(path.join(runDir, 'outputs', 'page.html'), 'utf8');
  const e = evalOf(runDir);
  const ex = [];
  const check = (text, passed, evidence) => ex.push({ text, passed: !!passed, evidence });

  const scripts = (html.match(/<script\b/gi) || []).length;
  if (e.exhibit === 'interactive') check('Interactive: the page has a script', scripts > 0, `${scripts} script tags`);
  if (e.exhibit === 'static') check('Static: the page has no <script>', scripts === 0, `${scripts} script tags`);

  const css = firstStyle(html);
  check(
    'Template <style> block kept byte for byte',
    css === templateCss,
    css === templateCss ? 'identical' : 'differs or missing',
  );

  const rest = html.replace(/<style[^>]*>[\s\S]*?<\/style>/i, '');
  const colors = rest.match(/#[0-9a-fA-F]{3,8}\b(?![\w-])|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || [];
  const real = colors.filter((c) => !/^#\d+$/.test(c) || c.length > 4);
  check(
    'No hard-coded colors outside the template CSS',
    real.length === 0,
    real.length ? `found ${real.slice(0, 5).join(', ')}` : 'none',
  );

  const light = await render(browser, html);
  const dark = await render(browser, html, { colorScheme: 'dark' });
  const bg = (p) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [lbg, dbg] = [await bg(light), await bg(dark)];
  check('Follows the OS light/dark preference', lbg !== dbg, `light ${lbg}, dark ${dbg}`);

  const host = await render(browser, withHostTokens(html), { colorScheme: 'dark' });
  const [hbg, hfg] = await host.evaluate(() => [
    getComputedStyle(document.body).backgroundColor,
    getComputedStyle(document.body).color,
  ]);
  check(
    'Follows a host theme: tokens injected first in <head> win',
    hbg === 'rgb(18, 52, 86)' && hfg === 'rgb(254, 220, 186)',
    `body bg ${hbg}, text ${hfg}`,
  );

  const [sw, cw] = await light.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  check('No sideways scroll at 1100 px', sw <= cw, `scrollWidth ${sw}, clientWidth ${cw}`);

  const info = await light.evaluate(() => {
    const svgs = [...document.querySelectorAll('svg')];
    const texts = [...document.querySelectorAll('svg text')].map((t) => parseFloat(getComputedStyle(t).fontSize));
    return {
      svgs: svgs.length,
      accessible: svgs.filter((s) => s.getAttribute('role') === 'img' && s.querySelector(':scope > title')).length,
      unfit: svgs.filter(
        (s) => s.hasAttribute('width') || !(s.viewBox.baseVal?.width > 0 && s.viewBox.baseVal.width <= 960),
      ).length,
      smallText: texts.filter((px) => px < 12).length,
      minText: texts.length ? Math.min(...texts) : null,
      h2: document.querySelectorAll('h2').length,
      leadPick: document.querySelector('.lead b')?.textContent.trim() || '',
      sources: document.querySelector('.sources')?.textContent.trim().length || 0,
      text: document.body.innerText,
    };
  });
  check('At least 3 section headings', info.h2 >= 3, `${info.h2} h2`);
  check('Has a filled .sources block', info.sources > 20, `${info.sources} chars`);
  if (e.svg) check('Has an SVG exhibit', info.svgs > 0, `${info.svgs} svg`);
  if (info.svgs) {
    check('Every SVG has role="img" and a <title>', info.accessible === info.svgs, `${info.accessible}/${info.svgs}`);
    check(
      'Every SVG fits: viewBox up to 960 wide, no width attribute',
      info.unfit === 0,
      `${info.unfit}/${info.svgs} do not fit`,
    );
    check('SVG text is 12 units or more', info.smallText === 0, `${info.smallText} small, smallest ${info.minText}`);
  }
  if (e.pick) check('The lead names the pick in <b>', info.leadPick, info.leadPick || 'no .lead b');
  if (e.facts) {
    const missing = e.facts.filter((f) => !new RegExp(f, 'i').test(info.text));
    check(
      'Every number of the source is on the page',
      missing.length === 0,
      missing.length ? `missing ${missing.join(' ')}` : `all ${e.facts.length}`,
    );
  }

  if (scripts) {
    await light.waitForTimeout(1500);
    check('No page errors', light.errors.length === 0, light.errors.slice(0, 3).join('; ') || 'none');

    const off = await render(browser, html, { javaScriptEnabled: false });
    const story = (p) =>
      p.evaluate(() =>
        [...document.querySelectorAll('h1, h2, p.sub, p.lead')]
          .map((el) => el.textContent.replace(/\s+/g, ' ').trim())
          .join(' | '),
      );
    const storyOn = await story(light);
    check(
      'The story (h1, h2, .sub, .lead) is static HTML',
      storyOn === (await story(off)),
      'scripts on against scripts off',
    );
    await off.close();

    const snap = () =>
      light.evaluate(() => {
        let h = 0;
        const s = [...document.querySelectorAll('figure')]
          .map((f) => f.innerHTML + [...f.querySelectorAll('canvas')].map((c) => c.toDataURL()).join(''))
          .join('|');
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return h;
      });
    await light.evaluate(() =>
      (
        document.querySelector('figure input, figure select, figure button')?.closest('figure') ||
        document.querySelector('figure')
      )?.scrollIntoView(),
    );
    await light.waitForTimeout(300);
    const s0 = await snap();
    await light.waitForTimeout(1500);
    const idle = s0 === (await snap());
    check(
      'Nothing runs while the reader does nothing',
      idle,
      idle ? 'no change in 1.5 s' : 'figures changed in 1.5 s with no input',
    );

    if (idle) {
      const controls = await light.evaluate(
        () => document.querySelectorAll('input[type=range], select, input[type=checkbox], button').length,
      );
      let how = null;
      let changed = false;
      let storyKept = true;
      for (let i = 0; i < controls && !changed; i++) {
        const before = await snap();
        how = await light.evaluate((k) => {
          const el = document.querySelectorAll('input[type=range], select, input[type=checkbox], button')[k];
          const fire = (type) => el.dispatchEvent(new Event(type, { bubbles: true }));
          if (el.matches('input[type=range]')) {
            el.value = el.value === el.max ? el.min : el.max;
            fire('input');
            fire('change');
            return `range ${el.id || el.name || k} to ${el.value}`;
          }
          if (el.matches('select')) {
            if (el.options.length < 2) return null;
            el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
            fire('change');
            return `select ${el.id || k} to option ${el.selectedIndex}`;
          }
          if (el.getAttribute('aria-pressed') === 'true' || el.disabled) return null;
          el.click();
          return `${el.tagName === 'BUTTON' ? 'click' : 'toggle'} "${(el.textContent || el.id).trim().slice(0, 20)}"`;
        }, i);
        if (!how) continue;
        await light.waitForTimeout(400);
        changed = before !== (await snap());
        storyKept &&= storyOn === (await story(light));
      }
      if (how || e.exhibit === 'interactive')
        check(
          'A control changes a figure',
          changed,
          how ? `${how}: ${changed ? 'figure changed' : 'no control changed a figure'}` : 'no control found',
        );
      if (how) check('Controls leave the story unchanged', storyKept, `${controls} controls`);
    }
  }

  if (e.invented) {
    check(
      'Numbers are marked as invented',
      /invent|made.up|fictional|illustrative/i.test(info.text),
      'searched page text',
    );
    const accentMarks = await light.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.color = 'var(--color-accent)';
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return [...document.querySelectorAll('svg rect, svg path, svg polyline, svg circle, svg line')].filter((m) => {
        const s = getComputedStyle(m);
        return s.fill === accent || s.stroke === accent;
      }).length;
    });
    check(
      'Chart data is not drawn in the accent (at most 2 accent marks)',
      accentMarks <= 2,
      `${accentMarks} marks in the accent`,
    );
  }

  for (const p of [light, dark, host]) await p.close();

  const passed = ex.filter((x) => x.passed).length;
  const grading = {
    expectations: ex,
    summary: { passed, failed: ex.length - passed, total: ex.length, pass_rate: +(passed / ex.length).toFixed(2) },
  };
  fs.writeFileSync(path.join(runDir, 'grading.json'), `${JSON.stringify(grading, null, 2)}\n`);
  console.log(`${path.relative(dir, runDir)}: ${passed}/${ex.length}`);
  for (const x of ex.filter((y) => !y.passed)) console.log(`  FAIL ${x.text} — ${x.evidence}`);
}

(async () => {
  const browser = await chromium().launch({ channel: 'chrome' });
  for (const run of findRuns(dir)) await grade(browser, run);
  await browser.close();
})();

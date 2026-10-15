const path = require('node:path');
const { slash, chromium, findRuns } = require('./lib.cjs');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node shots.cjs <iteration dir>');
  process.exit(1);
}

(async () => {
  const browser = await chromium().launch({ channel: 'chrome' });
  for (const run of findRuns(path.resolve(dir))) {
    const file = path.join(run, 'outputs', 'page.html');
    for (const colorScheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme });
      await page.goto(`file:///${slash(file)}`, { waitUntil: 'load' });
      await page.screenshot({
        path: path.join(run, 'outputs', `${colorScheme}.jpg`),
        fullPage: true,
        type: 'jpeg',
        quality: 50,
      });
      await page.close();
    }
    console.log(path.relative(dir, run));
  }
  await browser.close();
})();

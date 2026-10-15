const fs = require('node:fs');
const path = require('node:path');

const CCK = path.resolve(__dirname, '../..');
const HUB = path.resolve(CCK, '..');
const SKILL = path.join(CCK, 'plugin/plugins/claude-code-kanban/skills/visualize');
const RUNS = path.join(__dirname, 'runs');

const slash = (p) => p.replace(/\\/g, '/');
const fill = (s) => s.replaceAll('{cck}', slash(CCK)).replaceAll('{hub}', slash(HUB));
const loadEvals = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'evals.json'), 'utf8')).evals;

function chromium() {
  try {
    return require('playwright-core').chromium;
  } catch {
    console.error(
      'playwright-core is missing: run `npm install --no-save playwright-core` in cck. The scripts drive the installed Chrome.',
    );
    process.exit(1);
  }
}

function findRuns(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (fs.existsSync(path.join(p, 'outputs', 'page.html'))) out.push(p);
    else findRuns(p, out);
  }
  return out;
}

module.exports = { CCK, SKILL, RUNS, slash, fill, loadEvals, chromium, findRuns };

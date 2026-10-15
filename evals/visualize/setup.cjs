const fs = require('node:fs');
const path = require('node:path');
const { SKILL, RUNS, slash, fill, loadEvals } = require('./lib.cjs');

const [iteration, ...ids] = process.argv.slice(2);
if (!iteration) {
  console.error('usage: node setup.cjs <iteration> [eval id ...]');
  process.exit(1);
}

const root = path.join(RUNS, `iteration-${iteration}`);
const skill = path.join(root, 'skill');
fs.mkdirSync(skill, { recursive: true });
for (const f of ['SKILL.md', 'template.html']) fs.copyFileSync(path.join(SKILL, f), path.join(skill, f));

const runs = [];
for (const e of loadEvals().filter((x) => !ids.length || ids.includes(String(x.id)))) {
  const missing = e.files.map(fill).filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`skip eval ${e.id} ${e.name}: missing ${missing.join(', ')}`);
    continue;
  }
  const dir = path.join(root, `eval-${e.id}-${e.name}`);
  const run = path.join(dir, 'run-1');
  fs.mkdirSync(path.join(run, 'outputs'), { recursive: true });
  fs.mkdirSync(path.join(run, 'extras'), { recursive: true });
  const meta = { eval_id: e.id, eval_name: e.name, prompt: fill(e.prompt), assertions: [] };
  fs.writeFileSync(path.join(dir, 'eval_metadata.json'), `${JSON.stringify(meta, null, 2)}\n`);
  runs.push({
    eval: `${e.id}-${e.name}`,
    run: slash(run),
    prompt: [
      `Use the skill at ${slash(skill)}/SKILL.md. Read it first and follow it as if the user typed the request below. Its template.html is in the same folder. The \`show\` guides it links to are in ${slash(path.join(SKILL, '../show/references'))}/.`,
      '',
      `Request: ${fill(e.prompt)}`,
      '',
      `Write the page to ${slash(run)}/outputs/page.html. Put any other file you make (screenshots, check scripts) in the run-1/extras folder next to outputs. Run the skill's Check step; skip its Show step (do not add a pane). Do not change any file outside run-1.`,
      '',
      'Final answer, short: each exhibit with its kind (static, slider, toggle, stepper or running model) and why; what you checked; any skill rule that was unclear.',
    ].join('\n'),
  });
}
fs.writeFileSync(path.join(root, 'prompts.json'), `${JSON.stringify(runs, null, 2)}\n`);
console.log(`${runs.length} runs, prompts in ${slash(path.join(root, 'prompts.json'))}`);

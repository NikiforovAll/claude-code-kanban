# visualize evals

Eval cases for the `visualize` skill (`plugin/plugins/claude-code-kanban/skills/visualize`). Each case is a `/visualize` request; an agent runs the skill, and `grade.cjs` checks the page it writes. Runs go to `runs/`, which Git ignores.

## Cases

`evals.json` lists the cases. Each one has:

- `prompt`: the request. `{cck}` is this repo's root, `{hub}` its parent (the claude-code-hub checkout, when cck is its submodule).
- `files`: the sources the prompt names. `setup.cjs` skips a case when one is missing.
- `exhibit`: `static` (no script), `interactive` (a script and a control that changes a figure) or `either`.
- `expected_output`: what a good page does, for the reviewer.
- Optional checks: `pick` (the lead names the pick), `svg` (an SVG exhibit), `invented` (numbers marked as invented, at most 2 accent marks in charts), `facts` (regexes that must match the page text).

## Run

The scripts need Node and Chrome, plus `playwright-core`, which cck does not depend on: `npm install --no-save playwright-core`.

1. `node evals/visualize/setup.cjs <n> [eval id ...]` copies the current `SKILL.md` and `template.html` to `runs/iteration-<n>/skill/`, makes a run folder per case, and writes `prompts.json`.
2. Start one agent per entry of `prompts.json`, with its `prompt`, from a Claude Code session in this repo. The agents can run in parallel.
3. `node evals/visualize/grade.cjs evals/visualize/runs/iteration-<n>` writes `grading.json` per run and prints the failures.
4. `node evals/visualize/shots.cjs evals/visualize/runs/iteration-<n>` saves light and dark screenshots next to each page.
5. `uv run evals/visualize/review.py evals/visualize/runs/iteration-<n> --skill-name visualize --static evals/visualize/runs/iteration-<n>/review.html` builds a page with the prompt and screenshots of each run. It wraps the `skill-creator` skill's viewer; set `SKILL_CREATOR_VIEWER` when it is not found under `~/.claude`.

The grader cannot tell a made-up input from a real one: read the agents' reports for the "never add a control on an input you made up" rule.

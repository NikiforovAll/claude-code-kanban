const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createScratchpadDirResolver, scratchpadRoot } = require('../lib/scratchpad-dir');
const { encodeProjectDirName } = require('../lib/claude-dir');

const ROOT = path.resolve('/tmp/claude');
const PROJECTS = path.resolve('/home/.claude/projects');
const ID = '64601a65-8a20-45e6-aa35-5211fcfa4350';
const HUB = path.resolve('/dev/claude-code-hub');
const SUB = path.join(HUB, 'cck');
const SUB_WT = path.join(SUB, '.claude', 'worktrees', 'tree-highlight');

const dirFor = (cwd) => path.join(ROOT, encodeProjectDirName(cwd), ID, 'scratchpad');
const jsonlUnder = (cwd) => path.join(PROJECTS, encodeProjectDirName(cwd), `${ID}.jsonl`);

// `dirs` maps a scratchpad dir to its entry count; a dir not listed does not exist.
function resolver(dirs, worktrees = {}) {
  return createScratchpadDirResolver({
    root: ROOT,
    resolveWorktree: (dir) => worktrees[dir] ?? null,
    exists: (dir) => dir in dirs,
    isEmpty: (dir) => !dirs[dir],
  });
}

describe('getScratchpadDir', () => {
  it('returns null without a transcript', () => {
    assert.equal(resolver({})(ID, { project: SUB }), null);
  });

  it('keys on the transcript dir for a session that stayed where it started', () => {
    const get = resolver({});
    assert.equal(get(ID, { project: SUB, jsonlPath: jsonlUnder(SUB) }), dirFor(SUB));
  });

  it('keys on the launch dir when EnterWorktree moved the transcript', () => {
    const get = resolver({ [dirFor(SUB)]: 2, [dirFor(SUB_WT)]: 0 });
    assert.equal(get(ID, { project: SUB, jsonlPath: jsonlUnder(SUB_WT) }), dirFor(SUB));
  });

  it('keys on the repo when the first cwd is already the worktree', () => {
    const get = resolver({ [dirFor(SUB)]: 7 }, { [SUB_WT]: { repo: SUB } });
    assert.equal(get(ID, { project: SUB_WT, jsonlPath: jsonlUnder(SUB_WT) }), dirFor(SUB));
  });

  it('keeps a by-project dir that holds files over the launch dir', () => {
    const get = resolver({ [dirFor(SUB)]: 7, [dirFor(SUB_WT)]: 54 }, { [SUB_WT]: { repo: SUB } });
    assert.equal(get(ID, { project: SUB_WT, jsonlPath: jsonlUnder(SUB_WT) }), dirFor(SUB_WT));
  });

  it('keys on the launch dir when the transcript sits under another project with no worktree', () => {
    const cost = path.join(HUB, 'cost');
    const get = resolver({ [dirFor(HUB)]: 1 });
    assert.equal(get(ID, { project: HUB, jsonlPath: jsonlUnder(cost) }), dirFor(HUB));
  });

  it('stops probing once the by-project dir holds files', () => {
    const dirs = { [dirFor(SUB)]: 7, [dirFor(SUB_WT)]: 54 };
    const get = resolver(dirs);
    const meta = { project: SUB, jsonlPath: jsonlUnder(SUB_WT) };
    assert.equal(get(ID, meta), dirFor(SUB_WT));
    dirs[dirFor(SUB_WT)] = 0;
    assert.equal(get(ID, meta), dirFor(SUB_WT));
  });

  it('keeps the by-project path when no launch-keyed dir exists', () => {
    const get = resolver({});
    assert.equal(get(ID, { project: SUB, jsonlPath: jsonlUnder(SUB_WT) }), dirFor(SUB_WT));
  });

  it('takes the dir the transcript recorded, with its root in long form, over the convention', () => {
    const root = path.resolve('/SHORT~1/claude');
    const longRoot = path.resolve('/short-long/claude');
    let calls = 0;
    const get = createScratchpadDirResolver({
      root: ROOT,
      resolveWorktree: () => null,
      toLong: (p) => (calls++, p === root ? longRoot : p),
      exists: () => true,
      isEmpty: () => false,
    });
    const other = 'aaaaaaaa-8a20-45e6-aa35-5211fcfa4350';
    for (const id of [ID, other, ID]) {
      const meta = { project: SUB, jsonlPath: jsonlUnder(SUB), scratchpadDir: path.join(root, 'x', id, 'scratchpad') };
      assert.equal(get(id, meta), path.join(longRoot, 'x', id, 'scratchpad'));
    }
    assert.equal(calls, 1);
  });
});

describe('scratchpadRoot', () => {
  it('follows Claude Code: /tmp on macOS, the OS temp dir elsewhere, claude-<uid> on Unix', () => {
    assert.equal(scratchpadRoot({ platform: 'darwin', overrides: [], tmpdir: '/var/folders/x/T', uid: 501 }), '/tmp/claude-501');
    assert.equal(scratchpadRoot({ platform: 'linux', overrides: [], tmpdir: '/tmp', uid: 1000 }), '/tmp/claude-1000');
    assert.equal(scratchpadRoot({ platform: 'win32', overrides: [], tmpdir: 'C:\\Temp' }), 'C:\\Temp\\claude');
  });

  it('takes the first absolute CLAUDE_CODE_TMPDIR and skips a relative one', () => {
    assert.equal(scratchpadRoot({ platform: 'linux', overrides: [undefined, 'rel/dir', '/data/tmp/'], tmpdir: '/tmp', uid: 1000 }), '/data/tmp/claude-1000');
    assert.equal(scratchpadRoot({ platform: 'win32', overrides: ['D:/tmp', 'E:\\t'], tmpdir: 'C:\\Temp' }), 'D:\\tmp\\claude');
  });
});

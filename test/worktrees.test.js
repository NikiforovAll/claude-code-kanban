const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createWorktreeStore } = require('../lib/worktrees');
const { GRACE_MS } = require('../lib/retention');
const { encodeProjectDirName } = require('../lib/claude-dir');

const REPO = path.resolve('/dev/repo');
const SIDE = path.resolve('/dev/repo-feature');
const CLAUDE_WT = path.join(REPO, '.claude', 'worktrees', 'squid');

function fsError(code) {
  return Object.assign(new Error(code), { code });
}

function store({ files = {}, saved = null, clock = { t: 1_000_000_000 } } = {}) {
  const writes = [];
  const reads = [];
  const read = (dir) => {
    reads.push(dir);
    const f = files[dir];
    if (f instanceof Error) throw f;
    if (f === undefined) throw fsError('ENOENT');
    return f;
  };
  const deferred = [];
  const s = createWorktreeStore({
    load: () => saved,
    save: (d) => writes.push(d),
    read,
    now: () => clock.t,
    defer: (fn) => deferred.push(fn),
  });
  const flush = () => {
    for (const fn of deferred.splice(0)) fn();
  };
  return { s, writes, reads, clock, flush };
}

describe('createWorktreeStore', () => {
  it('reads the repo from the .git pointer, in the OS spelling', () => {
    const { s, writes, flush } = store({ files: { [SIDE]: 'gitdir: /dev/repo/.git/worktrees/feature\n' } });
    assert.deepEqual(s.resolve(SIDE), { repo: REPO, name: 'feature' });
    flush();
    assert.deepEqual(writes[0].worktrees[SIDE], { repo: REPO, name: 'feature', at: 1_000_000_000 });
  });

  it('saves several new worktrees in one write', () => {
    const { s, writes, flush } = store({ files: { [SIDE]: `gitdir: ${REPO}/.git/worktrees/feature` } });
    s.resolve(SIDE);
    s.resolve(CLAUDE_WT);
    flush();
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.keys(writes[0].worktrees).sort(), [CLAUDE_WT, SIDE].sort());
  });

  it('keeps an ordinary checkout as a miss and reads it once', () => {
    const { s, writes, reads, flush } = store({ files: { [REPO]: fsError('EISDIR') } });
    assert.equal(s.resolve(REPO), null);
    assert.equal(s.resolve(REPO), null);
    flush();
    assert.equal(reads.length, 1);
    assert.equal(writes.length, 0);
  });

  it('ignores a submodule pointer', () => {
    const { s } = store({ files: { [SIDE]: 'gitdir: ../.git/modules/feature' } });
    assert.equal(s.resolve(SIDE), null);
  });

  it('falls back to the claude worktree path once the checkout is gone', () => {
    const { s } = store();
    assert.deepEqual(s.resolve(CLAUDE_WT), { repo: REPO, name: 'squid' });
    assert.equal(s.resolve(SIDE), null);
  });

  it('answers a saved worktree without reading the disk', () => {
    const saved = { version: 1, worktrees: { [SIDE]: { repo: REPO, name: 'feature', at: 1 } } };
    const { s, reads } = store({ saved });
    assert.deepEqual(s.resolve(SIDE), { repo: REPO, name: 'feature' });
    assert.equal(reads.length, 0);
  });

  it('prunes a worktree whose transcripts are gone, after the grace period', () => {
    const { s, writes, clock, flush } = store({ files: { [SIDE]: `gitdir: ${REPO}/.git/worktrees/feature` } });
    s.resolve(SIDE);
    s.resolve(CLAUDE_WT);
    const knownDirs = new Set([encodeProjectDirName(CLAUDE_WT)]);
    assert.equal(s.prune(knownDirs), 0);
    clock.t += GRACE_MS;
    assert.equal(s.prune(knownDirs), 1);
    flush();
    assert.deepEqual(Object.keys(writes.at(-1).worktrees), [CLAUDE_WT]);
  });

  it('prunes nothing when the transcript scan found none', () => {
    const { s, clock } = store();
    s.resolve(CLAUDE_WT);
    clock.t += GRACE_MS;
    assert.equal(s.prune(null), 0);
  });
});

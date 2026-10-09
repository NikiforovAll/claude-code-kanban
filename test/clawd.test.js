const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clawdOn, createClawd, CLAWD_AGENT, CLAWD_PLUGIN_DIR } = require('../lib/clawd');
const { encodeProjectDirName } = require('../lib/claude-dir');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('clawd', () => {
  let root;
  let projects;
  let cck;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-'));
    cck = path.join(root, '.cck');
    projects = path.join(root, 'projects');
  });

  const ownDir = () => path.join(projects, encodeProjectDirName(path.join(cck, 'clawd')));
  const transcript = (id, mtime) => {
    fs.mkdirSync(ownDir(), { recursive: true });
    const f = path.join(ownDir(), `${id}.jsonl`);
    fs.writeFileSync(f, '{}\n');
    fs.utimesSync(f, mtime, mtime);
    return f;
  };

  it('is on unless config turns it off', () => {
    assert.equal(clawdOn(null), true);
    assert.equal(clawdOn({}), true);
    assert.equal(clawdOn({ clawd: { enabled: false } }), false);
  });

  it('starts a new session with the agent flags when there is no transcript', () => {
    const spec = createClawd({ cckDir: cck, projectsDir: projects }).startSpec();
    assert.equal(spec.cwd, path.join(cck, 'clawd'));
    assert.equal(spec.resume, undefined);
    assert.ok(fs.statSync(spec.cwd).isDirectory());
    const args = spec.extraArgs;
    assert.equal(args[args.indexOf('--agent') + 1], CLAWD_AGENT);
    assert.equal(args[args.indexOf('--plugin-dir') + 1], CLAWD_PLUGIN_DIR);
    assert.equal(args[args.indexOf('--add-dir') + 1], root);
    assert.ok(fs.existsSync(args[args.indexOf('--append-system-prompt-file') + 1]));
    assert.ok(fs.existsSync(path.join(CLAWD_PLUGIN_DIR, 'agents', 'clawd.md')));
  });

  it('resumes the newest transcript, the one after a /clear', () => {
    transcript(A, new Date(2026, 0, 1));
    transcript(B, new Date(2026, 0, 2));
    const c = createClawd({ cckDir: cck, projectsDir: projects });
    assert.equal(c.startSpec().resume, B);
    assert.ok(c.isOwnSession(A) && c.isOwnSession(B));
  });

  it('tracks a new transcript from the watcher and owns only its folder', () => {
    const c = createClawd({ cckDir: cck, projectsDir: projects });
    const f = path.join(ownDir(), `${A}.jsonl`);
    assert.ok(c.isOwnPath(f));
    assert.ok(!c.isOwnPath(path.join(projects, 'other', `${A}.jsonl`)));
    c.onTranscript(f, 'add');
    assert.equal(c.sessionId, A);
    assert.ok(c.isOwnSession(A));
    assert.ok(c.isOwnProjectDirName(path.basename(ownDir())));
  });
});

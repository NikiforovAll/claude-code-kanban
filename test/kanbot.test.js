const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { kanbotOn, kanbotModel, createKanbot, findCostCli, readCostServer, KANBOT_AGENT, KANBOT_PLUGIN_DIR } = require('../lib/kanbot');
const { encodeProjectDirName } = require('../lib/claude-dir');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('kanbot', () => {
  let root;
  let projects;
  let cck;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanbot-'));
    cck = path.join(root, '.cck');
    projects = path.join(root, 'projects');
  });

  const ownDir = () => path.join(projects, encodeProjectDirName(path.join(cck, 'kanbot')));
  const transcript = (id, mtime) => {
    fs.mkdirSync(ownDir(), { recursive: true });
    const f = path.join(ownDir(), `${id}.jsonl`);
    fs.writeFileSync(f, '{}\n');
    fs.utimesSync(f, mtime, mtime);
    return f;
  };

  it('is on unless config turns it off', () => {
    assert.equal(kanbotOn(null), true);
    assert.equal(kanbotOn({}), true);
    assert.equal(kanbotOn({ kanbot: { enabled: false } }), false);
  });

  it('takes a known model from config and passes it to the start spec', () => {
    assert.equal(kanbotModel(null), null);
    assert.equal(kanbotModel({ kanbot: { model: 'sonnet' } }), 'sonnet');
    assert.equal(kanbotModel({ kanbot: { model: 'sonnet --dangerously-skip-permissions' } }), null);
    const c = createKanbot({ cckDir: cck, projectsDir: projects });
    assert.equal(c.startSpec({ model: 'sonnet' }).model, 'sonnet');
    assert.equal(c.startSpec().model, null);
  });

  it('starts a new session with the agent flags when there is no transcript', () => {
    const spec = createKanbot({ cckDir: cck, projectsDir: projects }).startSpec({ boardUrl: 'http://127.0.0.1:4000' });
    assert.equal(spec.cwd, path.join(cck, 'kanbot'));
    assert.equal(spec.resume, undefined);
    assert.ok(fs.statSync(spec.cwd).isDirectory());
    const args = spec.extraArgs;
    assert.equal(args[args.indexOf('--agent') + 1], KANBOT_AGENT);
    assert.equal(args[args.indexOf('--plugin-dir') + 1], KANBOT_PLUGIN_DIR);
    assert.equal(args[args.indexOf('--add-dir') + 1], root);
    const help = fs.readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8');
    assert.match(help, /Usage: claude-code-kanban <command>/);
    assert.match(help, /This board runs at http:\/\/127\.0\.0\.1:4000/);
    assert.doesNotMatch(help, /# Costs/);
    assert.ok(fs.existsSync(path.join(KANBOT_PLUGIN_DIR, 'agents', 'kanbot.md')));
  });

  it('names the cost CLI in the help prompt when there is one', () => {
    const spec = createKanbot({ cckDir: cck, projectsDir: projects }).startSpec({ costCli: 'node "/x/server.js"' });
    const help = fs.readFileSync(spec.extraArgs[spec.extraArgs.indexOf('--append-system-prompt-file') + 1], 'utf8');
    assert.match(help, /`node "\/x\/server\.js" help`/);
    assert.match(help, /claude-code-kanban session cost <id>/);
  });

  describe('findCostCli', () => {
    const noBin = () => null;
    const serverFile = (rec) => {
      fs.mkdirSync(path.join(root, '.cost'), { recursive: true });
      fs.writeFileSync(path.join(root, '.cost', 'server.json'), JSON.stringify(rec));
    };

    it('takes the script of the live cost server from its server.json', () => {
      assert.equal(readCostServer(root), null);
      serverFile({ pid: process.pid, port: 4321, script: 'C:\\hub\\cost\\server.js' });
      assert.deepEqual(readCostServer(root), { url: 'http://localhost:4321', script: 'C:\\hub\\cost\\server.js' });
      assert.equal(findCostCli({ claudeDir: root, which: noBin }), 'node "C:/hub/cost/server.js"');
      serverFile({ pid: 2 ** 31 - 2, port: 4321, script: 'C:\\hub\\cost\\server.js' });
      assert.equal(readCostServer(root), null);
    });

    it('takes the bin on PATH only when its package has the CLI', () => {
      const prefix = path.join(root, 'npm');
      const bin = path.join(prefix, 'claude-code-cost.cmd');
      fs.mkdirSync(path.join(prefix, 'node_modules', 'claude-code-cost', 'lib'), { recursive: true });
      fs.writeFileSync(bin, '');
      assert.equal(findCostCli({ claudeDir: root, which: () => bin }), null);
      fs.writeFileSync(path.join(prefix, 'node_modules', 'claude-code-cost', 'lib', 'cli.js'), '');
      assert.equal(findCostCli({ claudeDir: root, which: () => bin }), 'claude-code-cost');
      assert.equal(findCostCli({ claudeDir: root, which: noBin }), null);
    });
  });

  it('resumes the newest transcript, the one after a /clear', () => {
    transcript(A, new Date(2026, 0, 1));
    transcript(B, new Date(2026, 0, 2));
    const c = createKanbot({ cckDir: cck, projectsDir: projects });
    assert.equal(c.startSpec().resume, B);
    assert.ok(c.isOwnSession(A) && c.isOwnSession(B));
  });

  it('tracks a new transcript from the watcher and owns only its folder', () => {
    const c = createKanbot({ cckDir: cck, projectsDir: projects });
    const f = path.join(ownDir(), `${A}.jsonl`);
    assert.ok(c.isOwnPath(f));
    assert.ok(!c.isOwnPath(path.join(projects, 'other', `${A}.jsonl`)));
    c.onTranscript(f, 'add');
    assert.equal(c.sessionId, A);
    assert.ok(c.isOwnSession(A));
    assert.ok(c.isOwnProjectDirName(path.basename(ownDir())));
    assert.ok(!c.isOwnSession(B));
    c.own(B);
    assert.ok(c.isOwnSession(B));
  });
});

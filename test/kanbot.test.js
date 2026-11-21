const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { kanbotOn, kanbotModel, createKanbot, findKanbotApps, readCostServer, KANBOT_AGENT, KANBOT_PLUGIN_DIR } = require('../lib/kanbot');
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

  describe('findKanbotApps', () => {
    const noBin = () => null;
    const serverFile = (dir, rec) => {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'server.json'), JSON.stringify(rec));
    };
    const reset = () => {
      for (const dir of ['.cost', '.memory']) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
    };
    const helpOf = (apps) => {
      const { extraArgs } = createKanbot({ cckDir: cck, projectsDir: projects }).startSpec({ apps });
      return { extraArgs, help: fs.readFileSync(extraArgs[extraArgs.indexOf('--append-system-prompt-file') + 1], 'utf8') };
    };

    it('takes the script of a live server from its server.json', () => {
      reset();
      assert.equal(readCostServer(root), null);
      serverFile('.cost', { pid: process.pid, port: 4321, script: 'C:\\hub\\cost\\server.js' });
      assert.deepEqual(readCostServer(root), { url: 'http://localhost:4321', script: 'C:\\hub\\cost\\server.js' });
      const { help } = helpOf(findKanbotApps({ claudeDir: root, which: noBin }));
      assert.match(help, /# Costs\n\n`node "C:\/hub\/cost\/server\.js" help`/);
      assert.match(help, /claude-code-kanban session cost <id>/);
      assert.doesNotMatch(help, /# Memory analysis/);
      serverFile('.cost', { pid: 2 ** 31 - 2, port: 4321, script: 'C:\\hub\\cost\\server.js' });
      assert.equal(readCostServer(root), null);
      assert.deepEqual(findKanbotApps({ claudeDir: root, which: noBin }), []);
    });

    it('takes the bin on PATH only when its package has the CLI', () => {
      reset();
      const prefix = path.join(root, 'npm');
      const bin = path.join(prefix, 'claude-code-memory-explorer.cmd');
      const which = (name) => (name === 'claude-code-memory-explorer' ? bin : null);
      fs.mkdirSync(path.join(prefix, 'node_modules', 'claude-code-memory-explorer', 'lib'), { recursive: true });
      fs.writeFileSync(bin, '');
      assert.deepEqual(findKanbotApps({ claudeDir: root, which }), []);
      fs.writeFileSync(path.join(prefix, 'node_modules', 'claude-code-memory-explorer', 'lib', 'cli.js'), '');
      const { help } = helpOf(findKanbotApps({ claudeDir: root, which }));
      assert.match(help, /# Memory analysis\n\n`claude-code-memory-explorer help`/);
      assert.doesNotMatch(help, /# Costs/);
    });

    it('loads the plugin of each found app that ships one', () => {
      reset();
      const appRoot = (name) => path.join(root, 'apps', name);
      serverFile('.cost', { pid: process.pid, port: 4330, script: path.join(appRoot('cost'), 'server.js') });
      serverFile('.memory', { pid: process.pid, port: 4331, script: path.join(appRoot('memory'), 'bin.js') });
      const memoryPlugin = path.join(appRoot('memory'), 'plugin', 'plugins', 'memory-diagnoser');
      fs.mkdirSync(path.join(memoryPlugin, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(memoryPlugin, '.claude-plugin', 'plugin.json'), '{}');
      const apps = findKanbotApps({ claudeDir: root, which: noBin });
      assert.deepEqual(apps.map((a) => a.pluginDir), [null, memoryPlugin]);
      const { extraArgs, help } = helpOf(apps);
      assert.deepEqual(extraArgs.slice(0, 5), ['--plugin-dir', KANBOT_PLUGIN_DIR, '--plugin-dir', memoryPlugin, '--agent']);
      assert.match(help, /# Costs[\s\S]*# Memory analysis/);
      reset();
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

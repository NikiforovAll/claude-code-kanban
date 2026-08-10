const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require('fs');
const os = require('os');
const path = require('path');

// Synced verbatim into every package that ships any of these helpers, so each
// describe skips when its module is not part of that package.
function optional(id) {
  try {
    return require(id);
  } catch {
    return null;
  }
}

const contain = optional('../lib/contain');
const openEditor = optional('../lib/open-editor');
const netGuard = optional('../lib/net-guard');
const validate = optional('../lib/validate');

const isContained = contain?.isContained;
const isContainedAny = contain?.isContainedAny;
const realpathDeepest = contain?.realpathDeepest ?? ((p) => p);
const splitCommandLine = openEditor?.splitCommandLine;
const assertOpenTarget = openEditor?.assertOpenTarget;
const parseHostHeader = netGuard?.parseHostHeader;
const isLoopbackAddress = netGuard?.isLoopbackAddress;

const isWin = process.platform === 'win32';

function tmp() {
  return realpathDeepest(mkdtempSync(path.join(os.tmpdir(), 'cch-sec-')));
}

describe('isContained', { skip: !contain }, () => {
  it('rejects a sibling that shares a name prefix', () => {
    const base = tmp();
    try {
      mkdirSync(path.join(base, 'foo'));
      mkdirSync(path.join(base, 'foo-evil'));
      writeFileSync(path.join(base, 'foo-evil', 'x.md'), 'x');
      assert.equal(isContained(path.join(base, 'foo-evil', 'x.md'), path.join(base, 'foo')), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('accepts a descendant and the root itself', () => {
    const base = tmp();
    try {
      const root = path.join(base, 'root');
      mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
      writeFileSync(path.join(root, 'a', 'b', 'x.md'), 'x');
      assert.equal(isContained(path.join(root, 'a', 'b', 'x.md'), root), true);
      assert.equal(isContained(root, root), true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects traversal out of the root', () => {
    const base = tmp();
    try {
      const root = path.join(base, 'root');
      mkdirSync(root);
      writeFileSync(path.join(base, 'secret.md'), 'x');
      assert.equal(isContained(path.join(root, '..', 'secret.md'), root), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects a symlink pointing out of the root', () => {
    const base = tmp();
    try {
      const root = path.join(base, 'root');
      mkdirSync(root);
      writeFileSync(path.join(base, 'secret.md'), 'x');
      try {
        symlinkSync(path.join(base, 'secret.md'), path.join(root, 'link.md'));
      } catch {
        return; // symlink creation needs privileges on Windows; nothing to assert
      }
      assert.equal(isContained(path.join(root, 'link.md'), root), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('is case-insensitive on win32 only', () => {
    const base = tmp();
    try {
      const root = path.join(base, 'Root');
      mkdirSync(root);
      writeFileSync(path.join(root, 'x.md'), 'x');
      // On win32 the same file reached through differing case is the same file;
      // on posix ROOT and Root are distinct directories.
      const shouted = path.join(base, 'ROOT', 'x.md');
      assert.equal(isContained(shouted, root), isWin);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects an absolute path on another root', () => {
    const other = isWin ? 'Z:\\other\\x.md' : '/other/x.md';
    const root = isWin ? 'C:\\root' : '/root';
    assert.equal(isContained(other, root), false);
  });

  it('rejects non-string input', () => {
    assert.equal(isContained(null, os.tmpdir()), false);
    assert.equal(isContained(os.tmpdir(), ''), false);
  });
});

describe('isContainedAny', { skip: !isContainedAny }, () => {
  it('accepts a child of any listed root and rejects one under none', () => {
    const base = tmp();
    try {
      const a = path.join(base, 'a');
      const b = path.join(base, 'b');
      mkdirSync(a);
      mkdirSync(b);
      writeFileSync(path.join(b, 'x.md'), 'x');
      assert.equal(isContainedAny(path.join(b, 'x.md'), [a, b]), true);
      assert.equal(isContainedAny(path.join(base, 'x.md'), [a, b]), false);
      assert.equal(isContainedAny(path.join(b, 'x.md'), []), false);
      assert.equal(isContainedAny(null, [a]), false);
      // A non-string root is skipped rather than throwing.
      assert.equal(isContainedAny(path.join(b, 'x.md'), [null, b]), true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('assertOpenTarget', { skip: !assertOpenTarget }, () => {
  const NUL = String.fromCharCode(0);

  it('returns the resolved absolute path for something that exists', () => {
    const base = tmp();
    try {
      assert.equal(assertOpenTarget(base), base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects empty, blank and non-string input with 400', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      assert.throws(() => assertOpenTarget(bad), (e) => e.status === 400, JSON.stringify(bad));
    }
  });

  it('rejects control characters with 400', () => {
    for (const bad of ['a\rb', 'a\nb', `a${NUL}b`]) {
      assert.throws(() => assertOpenTarget(bad), (e) => e.status === 400);
    }
  });

  it('rejects a path that does not exist with 404', () => {
    assert.throws(() => assertOpenTarget(path.join(os.tmpdir(), 'cch-definitely-absent-xyz')), (e) => e.status === 404);
  });
});

describe('splitCommandLine', { skip: !splitCommandLine }, () => {
  it('keeps a quoted program path intact', () => {
    assert.deepEqual(splitCommandLine('"C:\\Program Files\\x\\code.exe" -w'), [
      'C:\\Program Files\\x\\code.exe',
      '-w',
    ]);
  });

  it('splits a bare command with flags', () => {
    assert.deepEqual(splitCommandLine('code -w -n'), ['code', '-w', '-n']);
  });

  it('collapses runs of whitespace', () => {
    assert.deepEqual(splitCommandLine('  code   -w  '), ['code', '-w']);
  });

  it('returns an empty list for empty or non-string input', () => {
    assert.deepEqual(splitCommandLine(''), []);
    assert.deepEqual(splitCommandLine(undefined), []);
    assert.deepEqual(splitCommandLine(null), []);
  });
});

describe('parseHostHeader', { skip: !parseHostHeader }, () => {
  const ok = [
    ['localhost', 'localhost'],
    ['localhost:3541', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['127.0.0.1:3541', '127.0.0.1'],
    ['[::1]', '::1'],
    ['[::1]:3541', '::1'],
    ['localhost.', 'localhost'], // one trailing root dot is legal DNS
    ['LOCALHOST', 'localhost'],
  ];
  for (const [input, expected] of ok) {
    it(`parses ${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(parseHostHeader(input), expected);
    });
  }

  const bad = [
    '',
    '   ',
    // Userinfo is the rebinding trick that makes new URL() unsafe here: the
    // authority's real host is what follows the @.
    'a@localhost',
    'localhost@evil.com',
    'a:b:c',
    'localhost:notaport',
    'localhost:99999',
    'local\rhost',
    'local\nhost',
    'local host',
    'local\u0000host',
    '[::1',
    '::1]',
    null,
    undefined,
    42,
  ];
  for (const input of bad) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.equal(parseHostHeader(input), null);
    });
  }
});

describe('isLoopbackAddress', { skip: !isLoopbackAddress }, () => {
  for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
    it(`accepts ${host}`, () => assert.equal(isLoopbackAddress(host), true));
  }
  for (const host of ['0.0.0.0', '192.168.1.42', 'evil.com', '::', '', null]) {
    it(`rejects ${JSON.stringify(host)}`, () => assert.equal(isLoopbackAddress(host), false));
  }
});

describe('argv validators', { skip: !validate }, () => {
  const v = validate;

  it('rejects shell metacharacters in pluginId', () => {
    for (const bad of ['foo; calc', 'foo && calc', 'foo|calc', 'foo`calc`', 'a"b', 'foo $(calc)', '']) {
      assert.throws(() => v.assertPluginId(bad), /Invalid pluginId/, bad);
    }
  });

  it('rejects a pluginId that would become a flag', () => {
    assert.throws(() => v.assertPluginId('--dangerously-skip-permissions'), /Invalid pluginId/);
    assert.throws(() => v.assertPluginId('-n'), /Invalid pluginId/);
  });

  it('accepts real plugin ids', () => {
    for (const good of ['my-plugin', 'my.plugin_1', 'my-plugin@my-marketplace']) {
      assert.equal(v.assertPluginId(good), good);
    }
  });

  it('rejects non-string pluginId', () => {
    for (const bad of [null, undefined, 42, {}, ['a']]) {
      assert.throws(() => v.assertPluginId(bad), /Invalid pluginId/);
    }
  });

  it('constrains scope to the three known values', () => {
    for (const good of ['user', 'project', 'local']) assert.equal(v.assertScope(good), good);
    assert.equal(v.assertScope(undefined), null);
    assert.equal(v.assertScope(''), null);
    assert.throws(() => v.assertScope('User'), /Invalid scope/);
    assert.throws(() => v.assertScope('../../etc'), /Invalid scope/);
  });

  it('rejects a name with a path separator', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '']) assert.throws(() => v.assertName(bad), /Invalid name/);
    assert.equal(v.assertName('my-skill'), 'my-skill');
  });

  it('accepts owner/repo and git URLs as a source', () => {
    assert.equal(v.assertSource('NikiforovAll/claude-code-marketplace'), 'NikiforovAll/claude-code-marketplace');
    assert.equal(v.assertSource('https://github.com/a/b.git'), 'https://github.com/a/b.git');
    assert.equal(v.assertSource('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  });

  it('rejects an injecting or flag-shaped source', () => {
    for (const bad of ['a/b; calc', 'a/b && calc', '--flag', '-n', 'a"b', 'a/b`calc`', 'a/b$(calc)', 'a/b%PATH%', '']) {
      assert.throws(() => v.assertSource(bad), /Invalid source/, bad);
    }
  });

  it('accepts an existing local directory as a source', () => {
    const base = tmp();
    try {
      assert.equal(v.assertSource(base), base);
      assert.throws(() => v.assertSource(path.join(base, 'nope')), /Invalid source/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

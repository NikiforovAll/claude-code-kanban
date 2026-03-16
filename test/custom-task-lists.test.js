const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Test helpers: create a temp directory structure that mimics ~/.claude/
// ---------------------------------------------------------------------------

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Extract pure functions from server.js for unit testing.
// These are copy-pasted to avoid modifying the server module structure.
// If the server is refactored to export these, replace with imports.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeProjectPath(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  if (encoded.startsWith('/')) return encoded;
  if (!encoded.startsWith('-')) return null;
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

function scanCustomTaskListsSync(tasksDir, metadata) {
  const map = {};
  if (!fs.existsSync(tasksDir)) return map;

  const dirs = fs.readdirSync(tasksDir, { withFileTypes: true }).filter(d => d.isDirectory());

  for (const dir of dirs) {
    if (UUID_RE.test(dir.name)) continue;
    if (metadata[dir.name]) continue;

    const dirPath = path.join(tasksDir, dir.name);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
        if (task.metadata && task.metadata.project) {
          map[dir.name] = task.metadata.project;
          break;
        }
      } catch (e) { /* skip */ }
    }
  }

  return map;
}

function findActiveSessionForProject(project, metadata, getLogMtime) {
  let bestId = null;
  let bestMtime = 0;
  const decoded = decodeProjectPath(project);

  for (const [sessionId, meta] of Object.entries(metadata)) {
    const matches = meta.project === project ||
      (decoded && meta.project === decoded);
    if (!matches) continue;
    const mtime = getLogMtime ? (getLogMtime(sessionId) || 0) : 0;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      bestId = sessionId;
    }
  }

  return bestId;
}

function getProjectToCustomListMap(tasksDir, metadata) {
  const customLists = scanCustomTaskListsSync(tasksDir, metadata);
  const map = {};
  for (const [dirName, project] of Object.entries(customLists)) {
    map[project] = dirName;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decodeProjectPath', () => {
  it('returns null for null/undefined/empty', () => {
    assert.equal(decodeProjectPath(null), null);
    assert.equal(decodeProjectPath(undefined), null);
    assert.equal(decodeProjectPath(''), null);
  });

  it('returns the path as-is if it already starts with /', () => {
    assert.equal(decodeProjectPath('/Users/me/projects/foo'), '/Users/me/projects/foo');
  });

  it('decodes an encoded path starting with -', () => {
    assert.equal(decodeProjectPath('-Users-me-projects-foo'), '/Users/me/projects/foo');
  });

  it('returns null for strings that do not start with - or /', () => {
    assert.equal(decodeProjectPath('some-random-string'), null);
    assert.equal(decodeProjectPath('Users-me'), null);
  });

  it('returns null for non-string values', () => {
    assert.equal(decodeProjectPath(42), null);
    assert.equal(decodeProjectPath({}), null);
  });
});

describe('scanCustomTaskListsSync', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty map when tasks dir does not exist', () => {
    const result = scanCustomTaskListsSync(path.join(tmpDir, 'nonexistent'), {});
    assert.deepEqual(result, {});
  });

  it('skips UUID-named directories', () => {
    const uuidDir = path.join(tmpDir, '93deddc1-d604-4b18-8367-2e8ccce27cd1');
    writeJson(path.join(uuidDir, '1.json'), {
      id: '1', subject: 'test', status: 'pending',
      metadata: { project: '/Users/me/projects/foo' }
    });

    const result = scanCustomTaskListsSync(tmpDir, {});
    assert.deepEqual(result, {});
  });

  it('skips directories already in metadata (team sessions)', () => {
    const customDir = path.join(tmpDir, 'my-project');
    writeJson(path.join(customDir, '1.json'), {
      id: '1', subject: 'test', status: 'pending',
      metadata: { project: '/Users/me/projects/foo' }
    });

    const metadata = { 'my-project': { slug: 'team-session' } };
    const result = scanCustomTaskListsSync(tmpDir, metadata);
    assert.deepEqual(result, {});
  });

  it('discovers custom task list with metadata.project', () => {
    const customDir = path.join(tmpDir, 'syntetiq');
    writeJson(path.join(customDir, '1.json'), {
      id: '1', subject: 'Pipeline', status: 'in_progress',
      metadata: { agent: 'eva', project: '/Users/me/projects/syntetiq' }
    });

    const result = scanCustomTaskListsSync(tmpDir, {});
    assert.deepEqual(result, { syntetiq: '/Users/me/projects/syntetiq' });
  });

  it('skips tasks without metadata.project', () => {
    const customDir = path.join(tmpDir, 'no-project');
    writeJson(path.join(customDir, '1.json'), {
      id: '1', subject: 'test', status: 'pending',
      metadata: { agent: 'eva' }
    });

    const result = scanCustomTaskListsSync(tmpDir, {});
    assert.deepEqual(result, {});
  });

  it('reads project from first task that has it', () => {
    const customDir = path.join(tmpDir, 'my-app');
    writeJson(path.join(customDir, '1.json'), {
      id: '1', subject: 'no project', status: 'pending', metadata: {}
    });
    writeJson(path.join(customDir, '2.json'), {
      id: '2', subject: 'has project', status: 'pending',
      metadata: { project: '/home/user/my-app' }
    });

    const result = scanCustomTaskListsSync(tmpDir, {});
    assert.deepEqual(result, { 'my-app': '/home/user/my-app' });
  });

  it('handles multiple custom task list directories', () => {
    writeJson(path.join(tmpDir, 'project-a', '1.json'), {
      id: '1', subject: 'a', status: 'pending',
      metadata: { project: '/projects/a' }
    });
    writeJson(path.join(tmpDir, 'project-b', '1.json'), {
      id: '1', subject: 'b', status: 'pending',
      metadata: { project: '/projects/b' }
    });

    const result = scanCustomTaskListsSync(tmpDir, {});
    assert.equal(result['project-a'], '/projects/a');
    assert.equal(result['project-b'], '/projects/b');
  });

  it('skips invalid JSON files gracefully', () => {
    const customDir = path.join(tmpDir, 'bad-json');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, '1.json'), 'not valid json');
    writeJson(path.join(customDir, '2.json'), {
      id: '2', subject: 'good', status: 'pending',
      metadata: { project: '/good/path' }
    });

    const result = scanCustomTaskListsSync(tmpDir, {});
    assert.deepEqual(result, { 'bad-json': '/good/path' });
  });
});

describe('findActiveSessionForProject', () => {
  it('returns null when no sessions match the project', () => {
    const metadata = {
      'session-1': { project: '/other/project' }
    };
    const result = findActiveSessionForProject('/my/project', metadata, () => 100);
    assert.equal(result, null);
  });

  it('returns the session with the highest mtime', () => {
    const metadata = {
      'session-old': { project: '/my/project' },
      'session-new': { project: '/my/project' },
      'session-other': { project: '/other' },
    };
    const mtimes = { 'session-old': 100, 'session-new': 200, 'session-other': 300 };
    const result = findActiveSessionForProject('/my/project', metadata, (id) => mtimes[id]);
    assert.equal(result, 'session-new');
  });

  it('matches using decoded path when project is encoded', () => {
    const metadata = {
      'session-1': { project: '/Users/me/projects/foo' }
    };
    const result = findActiveSessionForProject('-Users-me-projects-foo', metadata, () => 100);
    assert.equal(result, 'session-1');
  });

  it('prefers exact match over decoded match', () => {
    const metadata = {
      'session-exact': { project: '/my/project' },
    };
    const result = findActiveSessionForProject('/my/project', metadata, () => 100);
    assert.equal(result, 'session-exact');
  });

  it('returns null for empty metadata', () => {
    const result = findActiveSessionForProject('/my/project', {}, () => 100);
    assert.equal(result, null);
  });
});

describe('getProjectToCustomListMap', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty map when no custom task lists exist', () => {
    const result = getProjectToCustomListMap(tmpDir, {});
    assert.deepEqual(result, {});
  });

  it('builds reverse map from project path to directory name', () => {
    writeJson(path.join(tmpDir, 'syntetiq', '1.json'), {
      id: '1', subject: 'test', status: 'pending',
      metadata: { project: '/Users/me/projects/syntetiq' }
    });

    const result = getProjectToCustomListMap(tmpDir, {});
    assert.equal(result['/Users/me/projects/syntetiq'], 'syntetiq');
  });

  it('handles multiple projects', () => {
    writeJson(path.join(tmpDir, 'app-a', '1.json'), {
      id: '1', subject: 'a', status: 'pending',
      metadata: { project: '/projects/a' }
    });
    writeJson(path.join(tmpDir, 'app-b', '1.json'), {
      id: '1', subject: 'b', status: 'pending',
      metadata: { project: '/projects/b' }
    });

    const result = getProjectToCustomListMap(tmpDir, {});
    assert.equal(result['/projects/a'], 'app-a');
    assert.equal(result['/projects/b'], 'app-b');
  });
});

describe('UUID_RE', () => {
  it('matches valid UUIDs', () => {
    assert.ok(UUID_RE.test('93deddc1-d604-4b18-8367-2e8ccce27cd1'));
    assert.ok(UUID_RE.test('6628b4b8-e51c-4861-ad64-be21ff8d0ec1'));
    assert.ok(UUID_RE.test('AABBCCDD-1122-3344-5566-778899AABBCC'));
  });

  it('does not match non-UUID strings', () => {
    assert.ok(!UUID_RE.test('syntetiq'));
    assert.ok(!UUID_RE.test('my-project'));
    assert.ok(!UUID_RE.test('not-a-uuid-at-all'));
    assert.ok(!UUID_RE.test('93deddc1-d604-4b18-8367'));
    assert.ok(!UUID_RE.test(''));
  });
});

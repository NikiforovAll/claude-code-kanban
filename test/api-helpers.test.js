const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];

let reply;
const calls = [];
const page = vm.runInNewContext(`${fn('apiPath')}\n${fn('api')}\n${fn('getJson')}\n({ apiPath, api, getJson })`, {
  URLSearchParams,
  fetch: async (url, init) => {
    calls.push({ url, init });
    return reply();
  },
});
const { apiPath, api, getJson } = page;

const response = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
const last = () => calls.at(-1);

describe('apiPath', () => {
  it('encodes each value and leaves the literal parts as they are', () => {
    const team = 'my team/x';
    const agent = 'writer@team';
    assert.equal(apiPath`/api/teams/${team}/agents/${agent}?x=1`, '/api/teams/my%20team%2Fx/agents/writer%40team?x=1');
  });

  it('gives the plain string when there are no values', () => {
    assert.equal(apiPath`/api/version`, '/api/version');
  });
});

describe('api', () => {
  it('builds the query and drops null and undefined values', async () => {
    reply = () => response(200, '{}');
    await api('/api/sessions', { query: { limit: 20, project: 'C:/a b', filter: null, include: undefined } });
    assert.equal(last().url, '/api/sessions?limit=20&project=C%3A%2Fa+b');
  });

  it('sends a JSON body with its content type and keeps other headers', async () => {
    await api('/api/x', { method: 'POST', body: { a: 1 }, headers: { 'X-Terminal-Token': 't' } });
    assert.equal(last().init.method, 'POST');
    assert.equal(last().init.body, '{"a":1}');
    assert.deepEqual({ ...last().init.headers }, { 'Content-Type': 'application/json', 'X-Terminal-Token': 't' });
  });

  it('sends no body and no content type without a body', async () => {
    for (const body of [undefined, null]) {
      await api('/api/x', { method: 'DELETE', body });
      assert.equal(last().init.body, undefined);
      assert.equal(last().init.headers, undefined);
    }
  });
});

describe('getJson', () => {
  it('gives the parsed body when the response is ok', async () => {
    reply = () => response(200, '[1,2]');
    assert.deepEqual([...(await getJson('/api/x'))], [1, 2]);
  });

  it('gives the fallback on an error status, without reading the body', async () => {
    reply = () => response(500, '{"error":"boom"}');
    assert.equal(await getJson('/api/x'), null);
    assert.equal(await getJson('/api/x', false), false);
  });

  it('gives the fallback when an ok body is not JSON', async () => {
    reply = () => response(200, '<html>restarting</html>');
    assert.equal(await getJson('/api/x', 'none'), 'none');
  });

  it('gives the fallback when the request fails', async () => {
    reply = () => {
      throw new TypeError('Failed to fetch');
    };
    assert.equal(await getJson('/api/x', 0), 0);
  });

  it('passes the options to the request', async () => {
    reply = () => response(200, '{}');
    await getJson('/api/x', null, { cache: 'no-store', query: { a: 'b' } });
    assert.equal(last().url, '/api/x?a=b');
    assert.equal(last().init.cache, 'no-store');
  });
});

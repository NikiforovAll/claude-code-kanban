const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { framingVerdict, probeFraming } = require('../lib/frame-policy');

const BOARD = 'http://localhost:3541';
const HUB = 'http://localhost:3540';
const verdict = (headers, target = 'http://localhost:8228/', ancestors = [BOARD]) =>
  framingVerdict(new Headers(headers), { target, ancestors });
const csp = (v) => ({ 'content-security-policy': `frame-ancestors ${v}` });

describe('framingVerdict', () => {
  it('frames a page with no framing headers', () => {
    assert.equal(verdict({}), true);
  });

  it('refuses X-Frame-Options DENY and SAMEORIGIN from another origin', () => {
    assert.equal(verdict({ 'x-frame-options': 'DENY' }), false);
    assert.equal(verdict({ 'x-frame-options': 'sameorigin' }), false);
    assert.equal(verdict({ 'x-frame-options': 'SAMEORIGIN' }, `${BOARD}/x`), true);
    assert.equal(verdict({ 'x-frame-options': 'ALLOW-FROM http://localhost:3541' }), true);
  });

  it("refuses frame-ancestors 'self' and 'none' from another origin", () => {
    assert.equal(verdict(csp("'self'")), false);
    assert.equal(verdict({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), false);
  });

  it('lets frame-ancestors win over X-Frame-Options', () => {
    assert.equal(verdict({ ...csp('http://localhost:3541'), 'x-frame-options': 'DENY' }), true);
  });

  it('matches host, port, scheme and wildcard sources', () => {
    assert.equal(verdict(csp('*')), true);
    assert.equal(verdict(csp('http:')), true);
    assert.equal(verdict(csp('https:')), false);
    assert.equal(verdict(csp('localhost:3541')), true);
    assert.equal(verdict(csp('localhost:*')), true);
    assert.equal(verdict(csp('localhost')), false);
    assert.equal(verdict(csp('http://localhost:9999')), false);
    assert.equal(verdict(csp('*.example.com'), 'https://a.example.com/', ['https://b.example.com']), true);
    assert.equal(verdict(csp('*.example.com'), 'https://a.example.com/', ['https://example.com']), false);
    assert.equal(verdict(csp('example.com'), 'http://x.test/', ['https://example.com']), true);
    assert.equal(verdict(csp('http://example.com:80'), 'http://x.test/', ['https://example.com']), true);
  });

  it('checks every ancestor, the hub included', () => {
    assert.equal(verdict(csp('http://localhost:3541'), undefined, [BOARD, HUB]), false);
    assert.equal(verdict(csp('localhost:3541 localhost:3540'), undefined, [BOARD, HUB]), true);
  });

  it('refuses when any of several policies refuses', () => {
    assert.equal(verdict({ 'content-security-policy': "frame-ancestors *, frame-ancestors 'none'" }), false);
    assert.equal(verdict({ 'content-security-policy': "script-src 'self', frame-ancestors *" }), true);
  });

  it('answers null without a usable ancestor', () => {
    assert.equal(verdict({}, undefined, ['file:///x']), null);
  });
});

describe('probeFraming', () => {
  it('reads the headers of the final URL', async () => {
    const fetchImpl = async () => ({ headers: new Headers(csp("'self'")), url: `${BOARD}/after-redirect`, body: null });
    assert.equal(await probeFraming('http://localhost:8228/', [BOARD], { fetchImpl }), true);
  });

  it('answers null on a network error', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    assert.equal(await probeFraming('http://a.test/', [BOARD], { fetchImpl }), null);
  });
});

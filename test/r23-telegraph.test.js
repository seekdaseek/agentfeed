// R23 F1: /telegraph/api/<route> -> 308 /api/<route>, for routes that exist only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { telegraphRedirect, routeExists } = require('../lib/telegraph-redirect');

function boot() {
  const app = express();
  app.use(telegraphRedirect());                       // mounted BEFORE the routes, as in server.js: existence is read at request time
  app.get('/api/token-risk/:mint', (req, res) => res.json({ answered: 'token-risk', mint: req.params.mint }));
  app.get('/api/trade-context', (_req, res) => res.json({ answered: 'trade-context' }));
  app.get('/api/fear-greed', (_req, res) => res.json({ answered: 'fear-greed' }));
  app.post('/api/only-post', (_req, res) => res.json({}));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}
function req(port, method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, cache: res.headers['cache-control'], body: b }));
    });
    r.on('error', reject); r.end();
  });
}

test('a path under /telegraph/api/ that names a mounted route is a 308 to the same path under /api/, query kept; HEAD too', async () => {
  const s = await new Promise((r) => { const x = boot().listen(0, () => r(x)); });
  const p = s.address().port;
  try {
    const cases = [
      ['GET', '/telegraph/api/trade-context', '/api/trade-context'],
      ['GET', '/telegraph/api/token-risk/So11111111111111111111111111111111111111112', '/api/token-risk/So11111111111111111111111111111111111111112'],
      ['GET', '/telegraph/api/fear-greed?x=1&y=%20z', '/api/fear-greed?x=1&y=%20z'],
      ['HEAD', '/telegraph/api/trade-context', '/api/trade-context'],
      ['GET', '/TELEGRAPH/API/Trade-Context', '/API/Trade-Context'],
      ['GET', '/telegraph/api/trade-context/', '/api/trade-context/'],
    ];
    for (const [m, from, to] of cases) {
      const r = await req(p, m, from);
      assert.equal(r.status, 308, `${m} ${from}`); assert.equal(r.location, to, `${m} ${from}`); assert.match(r.cache, /max-age=300/);
    }
    // following the redirect reaches the real handler (control: the target answers 200 by itself)
    assert.equal((await req(p, 'GET', '/api/trade-context')).status, 200);
  } finally { s.close(); }
});

test('no redirect when the route does not exist, the method is not GET/HEAD, or the path has a dot segment; the prefix alone is not enough (negative controls)', async () => {
  const s = await new Promise((r) => { const x = boot().listen(0, () => r(x)); });
  const p = s.address().port;
  try {
    for (const [m, path] of [
      ['GET', '/telegraph/api/no-such-route'], ['GET', '/telegraph/api/'], ['GET', '/telegraph'], ['GET', '/telegraph/health'], ['GET', '/telegraph/api/only-post'],
      ['POST', '/telegraph/api/trade-context'], ['GET', '/telegraph/api/trade-context/../../health'], ['GET', '/telegraph/api/%2e%2e/health'], ['GET', '/telegraph/api/trade-context\\x'],
      ['GET', '/telegraphx/api/trade-context'], ['GET', '/x/telegraph/api/trade-context'],
    ]) {
      const r = await req(p, m, path);
      assert.notEqual(r.status, 308, `${m} ${path} must not redirect`); assert.equal(r.location, undefined, `${m} ${path}`);
    }
  } finally { s.close(); }
});

test('routeExists reads mounted routes only: a middleware path is not a route; HEAD follows GET', () => {
  const app = express(); app.use('/api/mw', (_q, _r, n) => n()); app.get('/api/a/:id', (_q, r) => r.end());
  assert.equal(routeExists(app, 'GET', '/api/a/1'), true); assert.equal(routeExists(app, 'HEAD', '/api/a/1'), true);
  assert.equal(routeExists(app, 'GET', '/api/mw'), false); assert.equal(routeExists(app, 'POST', '/api/a/1'), false);
  assert.equal(routeExists({}, 'GET', '/api/a/1'), false);
});

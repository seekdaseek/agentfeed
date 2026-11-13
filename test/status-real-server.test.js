// R25: the real server.js (booted by test/helpers/real-server.js, scratch databases) serves /api/status and /status free, and every discovery surface lists it as free.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const H = require('./helpers/real-server');

let s;
const get = (p, m = 'GET') => H.raw(s.port, m, p, { 'cf-connecting-ip': '198.51.100.21' });
before(async () => { s = await H.boot(); });
after(() => { if (s) s.close(); });

test('real server: /api/status and /status answer 200 unpaid with the full document, HEAD answers 200 without a body', async () => {
  for (const p of ['/api/status', '/status']) {
    const r = await get(p);
    assert.equal(r.status, 200, p); assert.equal(r.headers['cache-control'], 'no-store'); assert.ok(!r.headers['payment-required']);
    const j = JSON.parse(r.body);
    assert.deepEqual(Object.keys(j), ['ok', 'as_of', 'service', 'venues', 'collectors', 'problems']);
    assert.deepEqual(j.venues.map((v) => v.venue), ['binance', 'bybit', 'okx']); assert.equal(j.collectors.length, 12);
    assert.equal(j.service.name, 'agentfeed'); assert.match(j.service.version, /^\d+\.\d+\.\d+/);
    assert.equal(typeof j.ok, 'boolean');
  }
  const h = await get('/api/status', 'HEAD'); assert.equal(h.status, 200); assert.equal(h.body, '');
});

test('real server: no charge row is written and no paid handler ran for /api/status', async () => {
  await get('/api/status');
  const rows = s.db().prepare("SELECT COUNT(*) AS n FROM calls WHERE status = 'paid'").get().n;
  assert.equal(rows, 0);
});

test('real server: openapi, the /api index, llms.txt and SKILL.md list it as a free route', async () => {
  const spec = JSON.parse((await get('/openapi.json')).body);
  const op = spec.paths['/api/status'].get;
  assert.deepEqual(op.security, []); assert.ok(!op['x-payment-info']); assert.ok(op.tags.includes('free'));
  assert.equal(JSON.parse((await get('/api')).body).links.status, 'https://x402.ochinimus.app/api/status');
  const llms = (await get('/llms.txt')).body;
  assert.ok(llms.includes('- GET /api/status — free, not payment-gated') && llms.includes('/api/status — live age of every venue'));
  assert.ok((await get('/SKILL.md')).body.includes('/api/status'));
  const n = (llms.match(/(\d+) free routes/) || [])[1];
  assert.equal(Number(n), llms.split('## Free routes')[1].split('## Paid')[0].split('\n').filter((l) => l.startsWith('- GET ')).length, 'the free-route count in llms.txt equals the list under it');
});

test('R28: the version is service.version (not a top-level field) and equals server.json, the registry version the box serves; it cannot silently fall back to "unknown"', async () => {
  const j = JSON.parse((await get('/api/status')).body);
  const want = require('../server.json').version;
  assert.equal(j.service.version, want);
  assert.notEqual(j.service.version, 'unknown');
  assert.ok(!('version' in j), 'the document has no top-level version: it lives under service');
});

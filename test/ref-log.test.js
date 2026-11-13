// R29 (13 Nov 2026): ?ref=<slug> is counted per caller per day and changes nothing in any response; package.json, server.json and /api/status agree on one version.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { makeRefLog, SLUG } = require('../lib/ref-log');

async function boot(t) {
  const db = new Database(':memory:'); const app = express();
  app.use((req, _res, next) => { req.callerIp = req.headers['x-test-ip'] || '203.0.113.9'; next(); });
  app.use(makeRefLog({ db, now: () => Date.UTC(2026, 10, 13, 12) }));
  app.get('/free', (_q, r) => r.json({ ok: 1 }));
  app.get('/paid', (_q, r) => { r.setHeader('PAYMENT-REQUIRED', 'x'); r.status(402).json({ error: 'Payment required' }); });
  app.get('/err', (_q, r) => r.status(500).json({}));
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); t.after(() => s.close());
  return { base: `http://127.0.0.1:${s.address().port}`, db };
}
const rows = (db) => db.prepare('select day, ref, caller, kind, n from ref_hits order by ref, caller, kind').all();

test('free answers and first-contact 402s are counted once per caller per day per ref, with a count', async (t) => {
  const { base, db } = await boot(t);
  await fetch(`${base}/free?ref=glama`); await fetch(`${base}/free?ref=glama`); await fetch(`${base}/paid?ref=glama`);
  await fetch(`${base}/free?ref=glama`, { headers: { 'x-test-ip': '198.51.100.7' } });
  assert.deepEqual(rows(db), [
    { day: '2026-11-13', ref: 'glama', caller: '198.51.100.7', kind: 'free', n: 1 },
    { day: '2026-11-13', ref: 'glama', caller: '203.0.113.9', kind: 'free', n: 2 },
    { day: '2026-11-13', ref: 'glama', caller: '203.0.113.9', kind: 'unpaid402', n: 1 }]);
});

test('nothing is counted without a valid slug, on a 5xx, or for a repeated/array/oversized ref; and the response is the same with and without ?ref', async (t) => {
  const { base, db } = await boot(t);
  for (const q of ['', '?ref=', '?ref=Bad_Slug', '?ref=a&ref=b', `?ref=${'x'.repeat(41)}`, '?ref=%3Cscript%3E']) await fetch(`${base}/free${q}`);
  await fetch(`${base}/err?ref=glama`);
  assert.deepEqual(rows(db), []);
  const [a, b] = [await fetch(`${base}/paid`), await fetch(`${base}/paid?ref=glama`)];
  assert.equal(a.status, b.status); assert.equal(a.headers.get('payment-required'), b.headers.get('payment-required')); assert.equal(await a.text(), await b.text());
  assert.ok(SLUG.test('mcp-so') && !SLUG.test('-x') && !SLUG.test('A'));
});

test('one version: package.json, server.json and the package-lock root agree', () => {
  const p = require('../package.json').version, s = require('../server.json').version, l = require('../package-lock.json').version;
  assert.match(p, /^\d+\.\d+\.\d+$/); assert.equal(p, s); assert.equal(p, l);
});

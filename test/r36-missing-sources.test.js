// R36 (14 Nov 2026): no route may crash the boot when its data file is missing.
// tools/overhang.js opened /opt/overhang/overhang.db when it was required, so a machine without that file could not start the server at all (and tools/liquidations.js did the same with
// its tape). Both are now opened on the first request. This test boots the REAL server.js with the preload's database redirect OFF (AF_NO_DB_REDIRECT=1: a missing must-exist database
// stays missing, nothing is faked) and every data file pointing at a file that does not exist, and asserts:
//   - the server starts;
//   - the overhang-backed routes answer a clean 503 JSON "data source unavailable", and are NOT charged (nothing settled, no paid row), paid or free;
//   - every other route is unaffected: free documents, an unpaid challenge on a priced route, and a paid call on a route that needs no outside data.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const H = require('./helpers/real-server');

let s; let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.19.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const get = (p, h = {}) => H.raw(s.port, 'GET', p, { ...ip(), ...h });

before(async () => { s = await H.boot({ AF_NO_DB_REDIRECT: '1' }); });
after(() => { if (s) s.close(); });

test('control: the overhang database really is missing and the preload does not stand in for it', () => {
  assert.equal(fs.existsSync(s.env.OVERHANG_DB_PATH), false, 'the file named by OVERHANG_DB_PATH does not exist');
  assert.equal(s.env.AF_NO_DB_REDIRECT, '1');
});

test('the server started although the overhang tape (and every other box database) is missing', async () => {
  assert.match(s.out(), /agentfeed up on/);
  assert.equal((await get('/health')).status, 200);
  assert.equal((await get('/api/status')).status, 200);
});

test('the free overhang route answers 503 "data source unavailable", JSON, with a retry_after', async () => {
  const r = await get('/api/exit-method');
  assert.equal(r.status, 503);
  assert.match(r.headers['content-type'], /json/);
  const j = JSON.parse(r.body);
  assert.match(j.error, /data source unavailable/);
  assert.equal(j.tool, 'get_exit_method');
  assert.ok(j.retry_after >= 1);
});

test('the paid overhang route: an unpaid call is the 402 as always; a PAID call gets the 503 and is not charged', async () => {
  const ch = await get('/api/exit-quote?symbol=SPYx');
  assert.equal(ch.status, 402, 'unpaid: the challenge is unchanged');
  const settledBefore = s.fac.log.filter((l) => l.op === 'settle').length;
  const paid = await get('/api/exit-quote?symbol=SPYx', { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
  assert.equal(paid.status, 503, paid.body.slice(0, 200));
  assert.match(JSON.parse(paid.body).error, /data source unavailable/);
  assert.equal(s.fac.log.filter((l) => l.op === 'settle').length, settledBefore, 'nothing was settled: a 503 is never charged');
  const rows = await H.rowsSince(s, 0);
  assert.equal(rows.filter((r) => r.status === 'paid').length, 0, 'no paid row was written for the failed call');
});

test('every other route is unaffected: an unpaid challenge, a free document, and a paid call that needs no outside data settles', async () => {
  assert.equal((await get('/api/sol-price')).status, 402);
  assert.equal((await get('/openapi.json')).status, 200);
  assert.equal((await get('/.well-known/x402')).status, 200);
  const ch = await get('/api/time');
  assert.equal(ch.status, 402);
  const ok = await get('/api/time', { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
  assert.equal(ok.status, 200, ok.body.slice(0, 200));
  assert.equal(s.fac.log.filter((l) => l.op === 'settle').length, 1, 'exactly that one call settled');
});

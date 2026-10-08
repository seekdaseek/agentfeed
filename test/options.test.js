// test/options.test.js — the options desk's math and its staleness contract.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-'));
process.env.OPTIONS_SNAPSHOT = path.join(dir, 'options.json');
const O = require('../tools/options');

test('normal CDF matches known values', () => {
  assert.ok(Math.abs(O._ncdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(O._ncdf(1.96) - 0.975002) < 1e-5);
  assert.ok(Math.abs(O._ncdf(-1) - 0.158655) < 1e-5);
});

test('Black-76 delta/gamma: the BTC-30OCT26-81000 hand-check against Deribit public/ticker', () => {
  // Deribit 2026-10-08: mark_iv 35.09, underlying 80883.43, T 0.05912y -> delta 0.51028 / -0.48972, gamma 0.00006
  const c = O._greeks(80883.43, 81000, 0.3509, 0.05912, true);
  const p = O._greeks(80883.43, 81000, 0.3509, 0.05912, false);
  assert.equal(Number(c.delta.toFixed(5)), 0.51028);
  assert.equal(Number(p.delta.toFixed(5)), -0.48972);
  assert.equal(Number(c.gamma.toFixed(5)), 0.00006);
  assert.equal(c.gamma, p.gamma);
});

test('max pain minimises intrinsic paid', () => {
  const opts = [
    { strike: 90, isCall: false, oi: 10 }, { strike: 100, isCall: true, oi: 5 }, { strike: 100, isCall: false, oi: 5 },
    { strike: 110, isCall: true, oi: 10 },
  ];
  // S=90: calls 0, puts (100-90)*5 = 50 -> 50; S=100: puts 10*0 + calls 0 = 0; S=110: calls (110-100)*5 = 50
  assert.deepEqual(O._maxPain(opts), { price: 100, payout: 0 });
});

test('interp stays inside the data', () => {
  assert.equal(O._interp([[0, 1], [1, 3]], 0.5), 2);
  assert.equal(O._interp([[0, 1], [1, 3]], 2), null);
});

test('flip level: calls above spot and puts below give a sign change between them', () => {
  const mk = (strike, isCall, oi) => ({ strike, isCall, oi, iv: 0.5, forward: 100, T: 30 / 365 });
  const flip = O._flipLevel([mk(85, false, 100), mk(115, true, 100)], 100);
  assert.ok(flip > 85 && flip < 115, `flip ${flip}`);
});

test('a stale snapshot answers 503, an unknown currency 400', () => {
  const now = Date.now();
  fs.writeFileSync(process.env.OPTIONS_SNAPSHOT, JSON.stringify({ as_of: new Date(now - 3600e3).toISOString(), as_of_ms: now - 3600e3, underlyings: [{ underlying: 'BTC', summary: {}, gex: {} }] }));
  assert.throws(() => O.getOptionsSummary({ currency: 'BTC' }, { now }), (e) => e.status === 503 && /3600s old/.test(e.message));
  const t = new Date(now + 5000); fs.utimesSync(process.env.OPTIONS_SNAPSHOT, t, t);
  fs.writeFileSync(process.env.OPTIONS_SNAPSHOT, JSON.stringify({ as_of: new Date(now).toISOString(), as_of_ms: now, underlyings: [{ underlying: 'BTC', summary: { term_structure: [] }, gex: { net_gex_usd_per_1pct: 1 } }] }));
  const t2 = new Date(now + 9000); fs.utimesSync(process.env.OPTIONS_SNAPSHOT, t2, t2);
  assert.throws(() => O.getOptionsSummary({ currency: 'DOGE' }, { now }), (e) => e.kind === 'bad_request');
  assert.equal(O.getOptionsGex({ currency: 'btc' }, { now }).net_gex_usd_per_1pct, 1);
});

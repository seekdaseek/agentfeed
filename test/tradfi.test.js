// test/tradfi.test.js — session labels, radar ranking/filters, equity-24h contract.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradfi-'));
process.env.FUNDING_RADAR_SNAPSHOT = path.join(dir, 'fr.json');
process.env.PEGWATCH_DB = path.join(dir, 'none.db');
const T = require('../tools/tradfi');
const at = (s) => Date.parse(s);

test('session labels in New York time', () => {
  assert.equal(T.sessionLabel(at('2026-10-08T14:00:00Z')), 'open');      // Thu 10:00 EDT
  assert.equal(T.sessionLabel(at('2026-10-08T12:00:00Z')), 'pre');       // Thu 08:00
  assert.equal(T.sessionLabel(at('2026-10-08T21:00:00Z')), 'after');     // Thu 17:00
  assert.equal(T.sessionLabel(at('2026-10-09T02:00:00Z')), 'overnight'); // Thu 22:00
  assert.equal(T.sessionLabel(at('2026-10-10T01:00:00Z')), 'weekend');   // Fri 21:00
  assert.equal(T.sessionLabel(at('2026-10-11T15:00:00Z')), 'weekend');   // Sun 11:00
  assert.equal(T.sessionLabel(at('2026-10-12T01:00:00Z')), 'overnight'); // Sun 21:00
});

function snap(now, markets) {
  fs.writeFileSync(process.env.FUNDING_RADAR_SNAPSHOT, JSON.stringify({ tradfi: { as_of: new Date(now).toISOString(), as_of_ms: now, min_track_usd: 250000, dexes: [], markets } }));
  const t = new Date(Date.now() + Math.random() * 1e6); fs.utimesSync(process.env.FUNDING_RADAR_SNAPSHOT, t, t);
}
const M = (venue, ticker, cls, f8, oi, mark = 100) => ({ venue, market: venue === 'hyperliquid' ? `xyz:${ticker}` : undefined, symbol: `${ticker}USDT`, ticker, asset_class: cls, funding_rate_8h: f8, oi_usd: oi, volume_24h_usd: 1e6, mark });

test('radar ranks by |funding 8h|, filters by class and venue; Binance (no OI) survives min_oi 0 only', () => {
  const now = Date.now();
  snap(now, [M('hyperliquid', 'TSLA', 'stock', 0.0001, 5e6), M('binance', 'XAU', 'commodity', -0.003, null), M('okx', 'US500', 'index', 0.001, 2e6)]);
  const r = T.getTradfiRadar({}, { now });
  assert.deepEqual(r.markets.map((m) => m.ticker), ['XAU', 'US500', 'TSLA']);
  assert.deepEqual(T.getTradfiRadar({ class: 'stock' }, { now }).markets.map((m) => m.ticker), ['TSLA']);
  assert.deepEqual(T.getTradfiRadar({ venue: 'okx' }, { now }).markets.map((m) => m.ticker), ['US500']);
  assert.deepEqual(T.getTradfiRadar({ min_oi_usd: 1e6 }, { now }).markets.map((m) => m.ticker), ['US500', 'TSLA']);
  assert.throws(() => T.getTradfiRadar({ class: 'crypto' }, { now }), (e) => e.kind === 'bad_request');
});

test('stale snapshot -> 503; unknown ticker -> 503; missing symbol -> 400', () => {
  const now = Date.now();
  snap(now - 3600e3, [M('hyperliquid', 'TSLA', 'stock', 0, 5e6)]);
  assert.throws(() => T.getTradfiRadar({}, { now }), (e) => e.status === 503);
  snap(now, [M('hyperliquid', 'TSLA', 'stock', 0, 5e6)]);
  assert.throws(() => T.getEquity24h({ symbol: 'ZZZZQ' }, { now }), (e) => e.status === 503);
  assert.throws(() => T.getEquity24h({}, { now }), (e) => e.kind === 'bad_request');
  const e = T.getEquity24h({ symbol: 'tsla' }, { now });
  assert.equal(e.indicative, true);
  assert.equal(e.indicative_price, 100);
  assert.equal(e.last_regular_session.price, null);
});

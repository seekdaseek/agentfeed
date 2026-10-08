// test/funding-radar.test.js — the radar's statistics and its cache contract.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fradar-'));
process.env.FUNDING_RADAR_SNAPSHOT = path.join(dir, 'snap.json');
const R = require('../tools/fundingradar');

const H = 3_600_000;

test('8h series: interval is the spacing to the previous settlement', () => {
  const rows = [{ ts: 0, rate: 0.0001 }, { ts: 8 * H, rate: 0.0001 }, { ts: 12 * H, rate: 0.0001 }];
  const s = R._to8hSeries(rows, { fallbackIntervalH: 8 });
  assert.equal(s.length, 2); // the first row is only a predecessor
  assert.equal(s[0].r8, 0.0001); // 8h spacing: unchanged
  assert.equal(s[1].r8, 0.0002); // 4h spacing: doubled
});

test('8h series: a gap wider than 8.5h falls back to the current interval, hourly venues are fixed', () => {
  const s = R._to8hSeries([{ ts: 0, rate: 0.0001 }, { ts: 24 * H, rate: 0.0001 }], { fallbackIntervalH: 4 });
  assert.equal(s[0].r8, 0.0002);
  const hl = R._to8hSeries([{ ts: 0, rate: 0.00001 }, { ts: H, rate: 0.00002 }], { fixedIntervalH: 1 });
  assert.deepEqual(hl.map((p) => p.r8), [0.00008, 0.00016]);
});

test('window stats report the window actually used, and no z under 10 samples', () => {
  const now = 30 * 24 * H;
  const series = Array.from({ length: 5 }, (_, i) => ({ ts: now - i * 24 * H, r8: 0.0001 * (i + 1) }));
  const st = R._windowStats(series, 0, now);
  assert.equal(st.samples, 5);
  assert.equal(st.window_days, 4);
  const z = R._zScore(0.001, st);
  assert.equal(z.z, null);
  assert.match(z.z_note, /only 5 settled rates/);
});

test('z-score is (current - mean) / sample std; flat history gives no z', () => {
  const st = { samples: 10, mean_8h: 0.0001, std_8h: 0.00005 };
  assert.equal(R._zScore(0.0002, st).z, 2);
  assert.equal(R._zScore(0.0002, { samples: 10, mean_8h: 0.0001, std_8h: 0 }).z, null);
  assert.equal(R._zScore(null, st).z, null);
});

test('radar row: spread, extreme venue and the |z| >= 2 flag', () => {
  const row = R._radarRow('XUSDT', {
    bybit: { funding_rate_8h: 0.0003, z_30d: 2.4 },
    okx: { funding_rate_8h: 0.0001, z_30d: -1.1 },
    hyperliquid: null,
  }, { total: 1 });
  assert.equal(row.spread_8h, 0.0002);
  assert.equal(row.spread_high_venue, 'bybit');
  assert.equal(row.spread_low_venue, 'okx');
  assert.equal(row.max_abs_z, 2.4);
  assert.equal(row.extreme_venue, 'bybit');
  assert.equal(row.flag, true);
  assert.deepEqual(row.flagged_venues, ['bybit']);
  assert.equal(row.venues.hyperliquid, null);
});

test('sorted by largest |z|, rows without a z last', () => {
  const rows = [{ max_abs_z: null, spread_8h: 1 }, { max_abs_z: 1, spread_8h: 0 }, { max_abs_z: 3, spread_8h: 0 }];
  assert.deepEqual(rows.sort(R._byExtremity).map((r) => r.max_abs_z), [3, 1, null]);
});

function writeSnap(asOfMs, n = 30) {
  const symbols = Array.from({ length: n }, (_, i) => ({ symbol: `S${i}USDT`, oi_usd: { total: (n - i) * 1e6 }, max_abs_z: n - i }));
  fs.writeFileSync(process.env.FUNDING_RADAR_SNAPSHOT, JSON.stringify({
    version: 1, as_of: new Date(asOfMs).toISOString(), as_of_ms: asOfMs,
    universe_floor_oi_usd: 5e6, min_venues: 2, window_target_days: 30, coverage: {}, symbols,
  }));
  // a fresh mtime so the reader's cache picks the new file up
  const t = new Date(Date.now() + Math.random() * 1000);
  fs.utimesSync(process.env.FUNDING_RADAR_SNAPSHOT, t, t);
}

test('no parameters: useful defaults (top 20, min OI $10M), fresh', () => {
  const now = Date.now();
  writeSnap(now - 60_000);
  const r = R.getFundingRadar({}, { now });
  assert.equal(r.stale, false);
  assert.equal(r.min_oi_usd, 10e6);
  assert.equal(r.matched, 21); // totals 30M..10M
  assert.equal(r.returned, 20);
  assert.equal(r.symbols.length, 20);
});

test('a stale cache says so, with its age', () => {
  const now = Date.now();
  writeSnap(now - 3600_000);
  const r = R.getFundingRadar({}, { now });
  assert.equal(r.stale, true);
  assert.equal(r.age_s, 3600);
  assert.match(r.stale_note, /3600s old/);
});

test('min_oi_usd below the tracked floor is clamped and explained; garbage is a 400', () => {
  const now = Date.now();
  writeSnap(now);
  const r = R.getFundingRadar({ min_oi_usd: '0', top: '100' }, { now });
  assert.equal(r.min_oi_usd, 5e6);
  assert.match(r.min_oi_note, /5,000,000/);
  assert.equal(r.returned, 26);
  assert.throws(() => R.getFundingRadar({ min_oi_usd: 'abc' }, { now }), (e) => e.kind === 'bad_request');
});

test('no snapshot yet: an honest error, not an empty answer', () => {
  fs.rmSync(process.env.FUNDING_RADAR_SNAPSHOT);
  assert.throws(() => R.getFundingRadar({}), /has not been built yet/);
});

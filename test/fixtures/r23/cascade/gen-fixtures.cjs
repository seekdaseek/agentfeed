// test/fixtures/r23/cascade/gen-fixtures.cjs: writes the SYNTHETIC world the cascade-backtest tests and the published example run on. Every number is generated, none is a market reading.
//   node test/fixtures/r23/cascade/gen-fixtures.cjs        (rewrites tape.csv and candles/ beside this file)
// The committed outputs are what the tests read; this script is their provenance, and test/r23-cascade-backtest.test.js checks the committed tape against SCHEDULE below.
//
// World: two symbols (BTCUSDT -> coin BTC, SOLUSDT -> coin SOL), 2026-01-05 06:00 UTC to 2026-01-11 12:30 UTC.
//   candles: 15-minute closes, a seeded random walk; the first day starts at 06:00 (as if the source's history began there), the last day ends at 12:00 (the cache's newest candle),
//            and BTC has one missing candle (2026-01-07 18:00) so the gap case is in the data.
//   tape:    background prints of 0.4k-3k USD every few minutes on both sides (none near a burst), plus the bursts in SCHEDULE.
'use strict';
const fs = require('fs');
const path = require('path');
const K = require('../../../../tools/r23/cascade-backtest/candles.js');

const DIR = __dirname;
const MIN = 60_000, STEP = 900_000, DAY = 86_400_000;
const T = (s) => Date.parse(s);
const WORLD = { start: T('2026-01-05T06:00:00Z'), cacheEnd: T('2026-01-11T12:00:00Z'), tapeEnd: T('2026-01-11T12:30:00Z') };

// bursts: symbol, side ('Buy' = longs liquidated), start, prints, usd per print, seconds between prints
const SCHEDULE = [
  { symbol: 'BTCUSDT', side: 'Buy', at: T('2026-01-06T09:12:00Z'), prints: 10, usd: 60_000, gapS: 9 },
  { symbol: 'BTCUSDT', side: 'Buy', at: T('2026-01-07T14:30:30Z'), prints: 12, usd: 40_000, gapS: 7 },
  { symbol: 'BTCUSDT', side: 'Sell', at: T('2026-01-08T23:50:00Z'), prints: 9, usd: 70_000, gapS: 10 },
  { symbol: 'BTCUSDT', side: 'Buy', at: T('2026-01-09T03:05:00Z'), prints: 9, usd: 50_000, gapS: 12 },
  { symbol: 'BTCUSDT', side: 'Buy', at: T('2026-01-10T20:10:00Z'), prints: 6, usd: 100_000, gapS: 15 },
  { symbol: 'BTCUSDT', side: 'Sell', at: T('2026-01-11T07:00:00Z'), prints: 8, usd: 80_000, gapS: 8 },
  { symbol: 'SOLUSDT', side: 'Buy', at: T('2026-01-06T16:40:00Z'), prints: 7, usd: 30_000, gapS: 10 },
  { symbol: 'SOLUSDT', side: 'Sell', at: T('2026-01-09T11:20:00Z'), prints: 6, usd: 45_000, gapS: 14 },
  { symbol: 'SOLUSDT', side: 'Buy', at: T('2026-01-10T01:00:00Z'), prints: 8, usd: 35_000, gapS: 6 },
];
const GAPS = { BTCUSDT: [T('2026-01-07T18:00:00Z')], SOLUSDT: [] };      // candle starts with no candle
const COINS = { BTCUSDT: { coin: 'BTC', p0: 94_000, vol: 0.0016 }, SOLUSDT: { coin: 'SOL', p0: 180, vol: 0.0024 } };

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function candlesOf(symbol, seed) {
  const { p0, vol } = COINS[symbol];
  const r = lcg(seed);
  const first = Math.ceil(WORLD.start / STEP) * STEP;
  const closes = new Map();
  let p = p0;
  for (let s = first; s < WORLD.cacheEnd; s += STEP) {
    p *= Math.exp((r() + r() + r() - 1.5) * vol * 2);
    if (!GAPS[symbol].includes(s)) closes.set(s, Number(p.toPrecision(7)));
  }
  return closes;
}

function writeCandles() {
  fs.rmSync(path.join(DIR, 'candles'), { recursive: true, force: true });
  for (const [symbol, i] of [['BTCUSDT', 1], ['SOLUSDT', 2]]) {
    const closes = candlesOf(symbol, 7000 + i);
    K.writeMeta(path.join(DIR, 'candles'), symbol, COINS[symbol].coin);
    for (let ds = Math.floor(WORLD.start / DAY) * DAY; ds < WORLD.cacheEnd; ds += DAY) {
      const arr = new Float64Array(96).fill(NaN);
      for (let k = 0; k < 96; k++) { const v = closes.get(ds + k * STEP); if (v !== undefined) arr[k] = v; }
      const from = Math.max(ds, Math.ceil(WORLD.start / STEP) * STEP);
      const through = Math.min(ds + DAY, WORLD.cacheEnd);
      K.writeDayFile(path.join(DIR, 'candles', symbol, K.dayName(ds)), { dayStart: ds, from, through, closes: arr });
    }
  }
}

function writeTape() {
  const rows = [];
  for (const [symbol, i] of [['BTCUSDT', 1], ['SOLUSDT', 2]]) {
    const closes = candlesOf(symbol, 7000 + i);
    const r = lcg(9000 + i);
    const priceAt = (t) => closes.get(Math.floor(t / STEP) * STEP) || COINS[symbol].p0;
    // background prints stay out of a burst's neighbourhood (6 minutes before its first print to a minute after its last), so the print that completes each burst is predictable
    const quiet = (t) => SCHEDULE.some((b) => b.symbol === symbol && t >= b.at - 6 * MIN && t <= b.at + b.prints * b.gapS * 1000 + MIN);
    for (let t = WORLD.start + Math.floor(r() * 5 * MIN); t < WORLD.tapeEnd; t += Math.floor((2 + r() * 12) * MIN)) {
      if (quiet(t)) continue;
      const side = r() < 0.55 ? 'Buy' : 'Sell';
      rows.push([t, symbol, side, Math.round((400 + r() * 2600) * 100) / 100, priceAt(t), r() < 0.6 ? 'bybit' : r() < 0.5 ? 'binance' : 'okx']);
    }
  }
  for (const b of SCHEDULE) {
    const closes = candlesOf(b.symbol, b.symbol === 'BTCUSDT' ? 7001 : 7002);
    for (let k = 0; k < b.prints; k++) {
      const t = b.at + k * b.gapS * 1000;
      rows.push([t, b.symbol, b.side, b.usd, closes.get(Math.floor(t / STEP) * STEP) || COINS[b.symbol].p0, 'bybit']);
    }
  }
  rows.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  fs.writeFileSync(path.join(DIR, 'tape.csv'), rows.map((x) => x.join(',')).join('\n') + '\n');
  return rows.length;
}

if (require.main === module) {
  writeCandles();
  console.log('tape rows', writeTape());
}
module.exports = { SCHEDULE, WORLD, GAPS, COINS, candlesOf, lcg };

// test/fixtures/r23/cascade/world.cjs: builders the cascade-backtest tests share: a tape database from rows, a candle cache from a price function, and the committed fixture world.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const K = require('../../../../tools/r23/cascade-backtest/candles.js');

const STEP = 900_000, DAY = 86_400_000;
const T = (s) => Date.parse(s);
const tmp = (label = 'r23casc') => fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));

/** a tape database with the box's schema and indexes. rows: [ts, symbol, side, usd] or [ts, symbol, side, usd, price, exchange] */
function buildDb(rows, file = ':memory:') {
  const db = new Database(file);
  db.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit');
    CREATE INDEX idx_liq_sym_ts ON liquidations(symbol, ts); CREATE INDEX idx_liq_ex_ts ON liquidations(exchange, ts); CREATE INDEX idx_liq_ts ON liquidations(ts);`);
  const ins = db.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd, exchange) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => { for (const r of rows) ins.run(r[0], r[1], r[2], 1, r[4] || 100, r[3], r[5] || 'bybit'); })();
  return db;
}

/**
 * Write a candle cache for one symbol: a day file per UTC day from `from` to `to`.
 * @param {string} dir cache root
 * @param {object} o { symbol, coin, from (ms, on the 15-minute grid: the first candle the source had), to (ms: through), price: (candleStartMs) => number|NaN }
 */
function makeCache(dir, { symbol, coin, from, to, price }) {
  K.writeMeta(dir, symbol, coin);
  for (let ds = Math.floor(from / DAY) * DAY; ds < to; ds += DAY) {
    const closes = new Float64Array(96).fill(NaN);
    for (let k = 0; k < 96; k++) { const s = ds + k * STEP; if (s >= from && s < to) closes[k] = price(s); }
    K.writeDayFile(path.join(dir, symbol, K.dayName(ds)), { dayStart: ds, from: Math.max(ds, from), through: Math.min(ds + DAY, to), closes });
  }
}

/** the committed fixture world: tape rows (as parsed from tape.csv) and the cache directory */
const FIX = path.join(__dirname);
function fixtureRows() {
  return fs.readFileSync(path.join(FIX, 'tape.csv'), 'utf8').split('\n').filter(Boolean).map((l) => { const f = l.split(','); return [Number(f[0]), f[1], f[2], Number(f[3]), Number(f[4]), f[5]]; });
}
function fixtureDb(file) { return buildDb(fixtureRows(), file); }
/** a private, writable copy of the committed candle cache (tests that refresh or damage files must not touch the committed ones) */
function copyFixtureCache() {
  const dst = tmp('r23casc-cache');
  fs.cpSync(path.join(FIX, 'candles'), dst, { recursive: true });
  return dst;
}
/** the fixed clock the fixture world and the example use: the minute the cache ends plus 20 minutes */
const FIXTURE_NOW = T('2026-01-11T12:20:00Z');

module.exports = { buildDb, makeCache, fixtureRows, fixtureDb, copyFixtureCache, tmp, STEP, DAY, T, FIX, FIXTURE_NOW };

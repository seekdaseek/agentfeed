// test/helpers/brief-files.js: the collector files the briefs read, built from the seeded synthetic market of brief-world.js, so the REAL accessors
// (tools/briefs/sources.js over lib/hl-oi.js, liqdb.js, fundingradar.js, macro.js) can be exercised end to end by the real server.js. Synthetic only.
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { makeWorld, makeCalibration } = require('./brief-world');

/** writes hl-oi.db, liq.db, funding-radar.json, macro.json and calibration.json into dir; returns the env a server needs to read them */
function writeFiles(dir, { now = Date.now(), sampler = 'ok', extra = 8, shock, tape = 'ok' } = {}) {
  const w = makeWorld({ now, extra, seed: 21, shock });
  const oiPath = path.join(dir, 'hl-oi.db');
  const oi = new Database(oiPath);
  oi.exec(`CREATE TABLE IF NOT EXISTS hl_oi (coin TEXT NOT NULL, ts INTEGER NOT NULL, oi REAL NOT NULL, mark REAL, funding REAL, vol24 REAL, PRIMARY KEY (coin, ts)) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS hl_oi_ts ON hl_oi(ts);`);
  const ins = oi.prepare('INSERT OR REPLACE INTO hl_oi (coin, ts, oi, mark, funding, vol24) VALUES (?, ?, ?, ?, ?, ?)');
  const age = sampler === 'stale' ? 3 * 3600 : 0;
  oi.transaction(() => { for (const [coin, rows] of w.series) for (const r of rows) ins.run(coin, r.ts - age, r.oi, r.mark, r.funding, 1e8); })();
  oi.close();

  const liqPath = path.join(dir, 'liq.db');
  const liq = new Database(liqPath);
  liq.exec(`CREATE TABLE IF NOT EXISTS liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit'); CREATE INDEX IF NOT EXISTS idx_liq_sym_ts ON liquidations(symbol, ts); CREATE INDEX IF NOT EXISTS idx_liq_ts ON liquidations(ts);`);
  const li = liq.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd) VALUES (?, ?, ?, ?, ?, ?)');
  liq.transaction(() => {
    for (const coin of ['BTC', 'ETH', 'SOL', 'HYPE']) {
      const mark = w.series.get(coin)[w.series.get(coin).length - 1].mark;
      for (let h = tape === 'stale' ? 3 : 0; h < 7 * 24; h++) li.run(now - h * 3600_000 - 600_000, `${coin}USDT`, h % 2 ? 'Buy' : 'Sell', 1, mark * (1 + ((h % 9) - 4) / 100), 18_000 + (h % 5) * 2000);
      li.run(tape === 'stale' ? now - 3 * 3600_000 : now - 30_000, `${coin}USDT`, 'Buy', 1, mark, 25_000);   // the tape is alive: a print in the last minute (or three hours ago)
    }
  })();
  liq.close();

  const nowS = Math.floor(now / 1000);
  const radar = {
    version: 2, as_of: new Date(now).toISOString(), as_of_ms: now, universe_floor_oi_usd: 0, window_target_days: 30, coverage: {}, perps: { total: 4, by_dex: { main: 4 } },
    symbols: ['BTC', 'ETH', 'SOL', 'HYPE'].map((c, i) => ({ symbol: `${c}USDT`, coin: c, dex: null, oi_usd: 1e8, max_abs_z: 0.4 + i * 0.1, flag: false, venues: { hyperliquid: { funding_rate_8h: 0.0001, funding_rate_raw: 0.0000125, funding_interval_hours: 1, z_30d: 0.4 + i * 0.1, samples: 90, window_days: 30 } } })),
  };
  const radarPath = path.join(dir, 'funding-radar.json');
  fs.writeFileSync(radarPath, JSON.stringify(radar));
  const day = new Date(now).toISOString().slice(0, 10);
  const macro = { version: 1, verified_at: new Date(now - 3600_000).toISOString(), verified_at_ms: now - 3600_000, timezone_of_source: 'America/New_York', unavailable: [],
    events: [{ type: 'CPI', title: 'Consumer Price Index', reference_period: null, date_new_york: day, time_new_york: '08:30', utc: `${day}T23:30:00.000Z`, source_url: 'https://www.bls.gov/schedule/news_release/cpi.htm', verified_at: new Date(now - 3600_000).toISOString() }] };
  const macroPath = path.join(dir, 'macro.json');
  fs.writeFileSync(macroPath, JSON.stringify(macro));
  const calPath = path.join(dir, 'calibration.json');
  fs.writeFileSync(calPath, JSON.stringify(makeCalibration(now, ['BTC', 'ETH', 'SOL', 'HYPE', 'C00', 'C01', 'C02']).value));
  void nowS;
  return { HL_OI_DB: oiPath, LIQ_DB: liqPath, FUNDING_RADAR_SNAPSHOT: radarPath, MACRO_SNAPSHOT: macroPath, BRIEF_CALIBRATION: calPath, CALIPER_LIQ_DB: liqPath };
}

module.exports = { writeFiles };

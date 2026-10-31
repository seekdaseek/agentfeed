// test/fixtures/r23/cascade/tz-probe.cjs: runs one event study around the EU and US daylight-saving changes and the UTC midnight, and prints the raw result as JSON.
// The test spawns it under several TZ settings and requires byte-identical output: nothing in the tool may depend on the machine's time zone.
//   TZ=America/New_York node test/fixtures/r23/cascade/tz-probe.cjs
'use strict';
const W = require('./world.cjs');
const { backtest } = require('../../../../tools/r23/cascade-backtest/backtest');
const fs = require('fs');
const { T, STEP, DAY } = W;
const BASE = T('2026-10-24T00:00:00Z');
const lin = (s) => 100 + (s - BASE) / STEP;
const burst = (at, side) => Array.from({ length: 4 }, (_, k) => [at + k * 20_000, 'TZUSDT', side, 30_000]);
const rows = [
  ...burst(T('2026-10-25T00:50:00Z'), 'Buy'),      // 10 minutes before the EU clocks go back (01:00 UTC)
  ...burst(T('2026-10-25T01:10:00Z'), 'Sell'),     // 10 minutes after it
  ...burst(T('2026-11-01T05:50:00Z'), 'Buy'),      // before the US clocks go back (06:00 UTC)
  ...burst(T('2026-11-01T06:10:00Z'), 'Sell'),
  ...burst(T('2026-10-27T23:50:00Z'), 'Buy'),      // its 15m horizon ends exactly at UTC midnight, the 24h one is the next night
];
const dir = W.tmp('r23casc-tz');
W.makeCache(dir, { symbol: 'TZUSDT', coin: 'TZ', from: BASE, to: BASE + 12 * DAY, price: lin });
const db = W.buildDb(rows);
backtest({ symbol: 'TZUSDT', coin: 'TZ', sideMode: 'both', minUsd: 100_000, windowMin: 5, cooldownMin: 15 }, { db, cacheDir: dir, now: BASE + 20 * DAY, offline: true }).then((r) => {
  const out = { events: r.events, horizons: r.horizons, baseline: r.baseline, period: r.period, localDate: new Date(2026, 9, 25, 0, 0).getTime() };
  process.stdout.write(JSON.stringify(out));
  fs.rmSync(dir, { recursive: true, force: true });
});

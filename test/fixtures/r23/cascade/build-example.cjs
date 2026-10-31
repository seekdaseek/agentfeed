// test/fixtures/r23/cascade/build-example.cjs: builds the published example of get_cascade_backtest from the SYNTHETIC fixture world (world.cjs, gen-fixtures.cjs): the real handler over
// generated data with a fixed clock, so every number in it is constructed, none is a market reading. The test rebuilds it and fails when tools/r23/cascade-backtest/example.json differs.
//   node test/fixtures/r23/cascade/build-example.cjs        (rewrites tools/r23/cascade-backtest/example.json)
'use strict';
const fs = require('fs');
const path = require('path');
const W = require('./world.cjs');

async function buildExample() {
  const { run } = require('../../../../tools/r23/cascade-backtest');
  const db = W.fixtureDb();
  const cacheDir = W.copyFixtureCache();
  try { return JSON.parse(JSON.stringify(await run({ symbol: 'BTC', side: 'both', min_usd: 100000, window_min: 5 }, null, { db, cacheDir, now: W.FIXTURE_NOW, offline: true }))); } finally { db.close(); fs.rmSync(cacheDir, { recursive: true, force: true }); }
}
if (require.main === module) {
  buildExample().then((ex) => { const f = path.join(__dirname, '../../../../tools/r23/cascade-backtest/example.json'); fs.writeFileSync(f, JSON.stringify(ex, null, 1) + '\n'); console.log('wrote', f, JSON.stringify(ex).length, 'bytes', 'events', ex.events_found); });
}
module.exports = { buildExample };

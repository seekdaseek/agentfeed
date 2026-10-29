// tools/briefs/example.js: the output example of each brief for bazaar-examples.json (gen-bazaar-meta.js). A brief cannot be captured in a short-lived
// process on a machine that does not hold the box's collector data, so the example is CONSTRUCTED: the real brief function run over the seeded synthetic
// market in test/helpers/brief-world.js, with a fixed clock. The entry is marked `static: true` (like the prepaid-key routes) and every number in it is
// generated, none is a market reading. `gen-bazaar-meta.js --recapture=get_morning_brief,get_move_alert,get_anomaly_flag` on the box replaces it with a
// live capture (a read of our own collectors, no payment) once the sampler is warm.
'use strict';
const TOOLS = ['get_morning_brief', 'get_move_alert', 'get_anomaly_flag'];
const NOW = Date.UTC(2026, 0, 15, 8, 2, 0);

async function exampleFor(tool) {
  const { makeWorld, makeCalibration } = require('../../test/helpers/brief-world');
  const events = [{ type: 'CPI', title: 'Consumer Price Index', utc: '2026-01-15T13:30:00.000Z', source_url: 'https://www.bls.gov/schedule/news_release/cpi.htm' }];
  if (tool === 'get_morning_brief') {
    const w = makeWorld({ now: NOW, shock: { SOL: { markPct: -4.2, oiPct: 6, steps: 90 } }, funding: { SOL: -2.6 }, liq: { SOL: { lastHourUsd: 400_000, longsShare: 0.8, windowH: 8 } }, events });
    return require('./morning').getMorningBrief({}, { now: NOW, deps: w.deps });
  }
  if (tool === 'get_move_alert') {
    const w = makeWorld({ now: NOW, shock: { SOL: { markPct: -3.4, steps: 12 } }, spikes: [{ coin: 'C00', oi_change_1h_pct: 11.5, spike_z: 5.2 }], events });
    return require('./move').getMoveAlert({}, { now: NOW, deps: w.deps, calibration: () => makeCalibration(NOW) });
  }
  if (tool === 'get_anomaly_flag') {
    const w = makeWorld({ now: NOW, funding: { SOL: 3.1 }, liq: { SOL: { lastHourUsd: 700_000, longsShare: 0.85 } }, spikes: [{ coin: 'C07', oi_change_1h_pct: 8.4, spike_z: 4.1 }] });
    return require('./anomaly').getAnomalyFlag({}, { now: NOW, deps: w.deps });
  }
  throw new Error(`no brief example for ${tool}`);
}
module.exports = { TOOLS, exampleFor, NOW };

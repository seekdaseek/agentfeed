#!/usr/bin/env node
// warm-oi-example.js — get_oi_spike_scan keeps its OI baseline in a process-local
// array and returns {warming:true} until a snapshot is 30 minutes old, so a
// short-lived generator run can never capture its real answer. This primes the
// baseline, waits it out, and writes the real response for gen-bazaar-meta.js.
// run: cd /opt/agentfeed && nohup node --env-file=.env warm-oi-example.js &
'use strict';
const fs = require('fs');
const { getOiSpikeScan } = require('./tools/derivs');
const OUT = '/opt/agentfeed/captures/get_oi_spike_scan.json';
const log = (m) => fs.appendFileSync('/root/oi-warm.log', `${new Date().toISOString()} ${m}\n`);

(async () => {
  log(`start pid=${process.pid}`);
  const first = await getOiSpikeScan({});
  log(`prime: ${JSON.stringify(first).slice(0, 120)}`);
  for (let i = 1; i <= 40; i++) {
    await new Promise((r) => setTimeout(r, 120_000)); // 2 min
    const r = await getOiSpikeScan({});
    if (!r.warming) {
      fs.writeFileSync(OUT, JSON.stringify(r, null, 1));
      log(`READY after ${i * 2} min -> ${OUT} (${JSON.stringify(r).length} B, baseline_min_ago=${r.baseline_min_ago}, spikes=${r.spikes.length})`);
      process.exit(0);
    }
    log(`tick ${i}: still warming, ready_in_min=${r.ready_in_min}`);
  }
  log('GAVE UP after 80 min');
  process.exit(1);
})().catch((e) => { log('ERR ' + e.message); process.exit(1); });

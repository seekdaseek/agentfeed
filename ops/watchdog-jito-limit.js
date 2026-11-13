#!/usr/bin/env node
// ops/watchdog-jito-limit.js: the staleness limit /opt/watchdog.sh applies to jito-tips.json, in seconds, derived from the collector's schedule.
// lib/jito-age.js REFRESH_S is the cadence bin/jito-tips-collect.js is scheduled at (cron `2-59/15`, 900 s). The limit is two cycles: one missed or thin run (the file is then about 1170 s old at the
// watchdog's :08/:23/:38/:53 check) is tolerated, two missed runs (about 2070 s) page. R26 (13 Nov 2026): it was a hand-written 720 s from the 5-minute era, so every single missed run paged.
// The watchdog calls it as:  fchk /opt/agentfeed/jito-tips.json jito-tips "$(/usr/bin/node /opt/agentfeed/ops/watchdog-jito-limit.js 2>/dev/null || echo 1800)"
// It prints digits only (a non-number would make fchk's test fail silently) and nothing else. JITO_MAX_AGE_S (the route's own cutoff, /api/status uses 3 x REFRESH_S = 2700 s) is not read here.
'use strict';
const CYCLES = 2;
const limitS = (refreshS = require('../lib/jito-age').REFRESH_S) => {
  if (!Number.isInteger(refreshS) || refreshS <= 0) throw new Error('REFRESH_S is not a positive integer');
  return refreshS * CYCLES;
};
module.exports = { limitS, CYCLES };
if (require.main === module) process.stdout.write(String(limitS()) + '\n');

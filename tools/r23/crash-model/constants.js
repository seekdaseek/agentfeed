// tools/r23/crash-model/constants.js: the numbers the scorer, the routes and the public text share, so a number in a description is the number the code uses (R23 T1).
'use strict';

const FALL_PCT = 80;              // a "fall" is a price at the 24 hour check at least this many percent below the frozen entry price
const HORIZON_HOURS = 24;

module.exports = {
  FALL_PCT, HORIZON_HOURS,
  MEANING: `chance of an ${FALL_PCT} percent price fall within ${HORIZON_HOURS} hours`,
  COVER_DAYS: 7,                  // a pool is covered by the routes for this long after it was scored
  RADAR_DEFAULT: 25, RADAR_MAX: 100,
  SCAN_SLACK_SEC: 6 * 3600,       // after a scan that reached the end of the window, the next scans start this long before the newest pool seen (a pool is written minutes after its t0_ts)
  BATCH_MAX: 500,                 // the most pools one scoring tick may write
  ENTRY_LAG_SEC: 1800,            // "scored at entry": scored within this many seconds of the pool's frozen entry time
  MIN_RESOLVED: 200,              // a week with fewer resolved pools has no AUC
  LIVE_CUTS_MIN: 2000, LIVE_CUTS_DAYS: 14,
  STALE_NEWEST_SEC: 1800,         // newest score older than this while LaunchLedger runs: the scorer is behind
  TICK_STALE_SEC: 600,            // the scorer has not completed a run for this long: it is not running
  LEDGER_RUNNING_SEC: 1800,       // LaunchLedger completed a cycle within this long (its cycle is 10 minutes; its own integrity guard allows 3 cycles)
};

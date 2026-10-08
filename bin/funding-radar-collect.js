#!/usr/bin/env node
// bin/funding-radar-collect.js — one collector run for get_funding_radar.
// cron, every 5 minutes, under flock so two runs never overlap:
//   */5 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/funding-radar.lock /usr/bin/node bin/funding-radar-collect.js >> /opt/agentfeed/funding-radar.log 2>&1
// The paid route only ever reads the snapshot this writes; see tools/fundingradar.js.
'use strict';
const { collect } = require('../tools/fundingradar');

collect({ log: (m) => console.log(new Date().toISOString(), m) })
  .then((s) => console.log(new Date().toISOString(), 'ok', JSON.stringify(s)))
  .catch((e) => { console.log(new Date().toISOString(), 'FAILED', e.message); process.exit(1); });

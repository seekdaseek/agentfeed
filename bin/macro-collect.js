#!/usr/bin/env node
// bin/macro-collect.js — re-read the Fed, BLS and BEA calendars (tools/macro.js).
// cron, daily, under flock:
//   23 5 * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/macro.lock /usr/bin/node bin/macro-collect.js >> /opt/agentfeed/macro.log 2>&1
'use strict';
const { collect } = require('../tools/macro');

collect()
  .then((s) => console.log(new Date().toISOString(), 'ok', JSON.stringify(s)))
  .catch((e) => { console.log(new Date().toISOString(), 'FAILED', e.message); process.exit(1); });

#!/usr/bin/env node
// bin/options-collect.js — one options-desk collector run (tools/options.js).
// cron, every 5 minutes, under flock:
//   */5 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/options.lock /usr/bin/node bin/options-collect.js >> /opt/agentfeed/options.log 2>&1
'use strict';
const { collect } = require('../tools/options');

collect({ log: (m) => console.log(new Date().toISOString(), m) })
  .then((s) => console.log(new Date().toISOString(), 'ok', JSON.stringify(s)))
  .catch((e) => { console.log(new Date().toISOString(), 'FAILED', e.message); process.exit(1); });

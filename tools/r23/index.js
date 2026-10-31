// tools/r23/index.js: the R23 tools batch (31 Oct 2026), the one place that decides which of its routes exist.
//   shipped: x402-lint and x402-test (x402/), cascade-backtest, claim-check, site-signals (RDAP off unless R23_SITESIGNALS_RDAP=on)
//   cut by their gates or by data terms, so NOT listed here (the code of T5 pkg-check stays in the repo, unregistered): see docs/SOURCES.md and the R23 report
//   held by the owner: the three crash-risk routes (crash-risk.js) join only while R23_CRASH_ROUTES=on, which no deploy sets (their data is GeckoTerminal-derived)
// Every module exports `entries`, objects shaped like the EXP entries in expansion.js (name, route, usd, tags, desc, schema, run) plus title, question and example.
'use strict';
const crash = require('./crash-risk');

const entries = [
  ...require('./x402').entries,
  ...require('./cascade-backtest').entries,
  ...require('./claim-check').entries,
  ...require('./site-signals').entries,
  ...(crash.enabled() ? crash.entries : []),
];

module.exports = { entries, crashRoutesOn: crash.enabled };

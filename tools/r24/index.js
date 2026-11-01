// tools/r24/index.js: the R24 batch (1 Nov 2026), the one place that decides which of its routes exist.
//   shipped by their registered gates: pkg-check re-gated (code in tools/r23/pkg-check.js, 40 of 40 on a new held-out list) and tx-precheck (12 of 12)
//   company-check (item 5, passed its third gate, held-out list sha256 3ea73a0c...) and rwa-yields (item 3, the five products that passed: usdy, ousg, ustb, usyc, syrupusdc; tbill and mtbill are unserved)
//   cut: the three Solana token routes keep answering 503 Not charged (item 2, gate failed on the box); pm-movers (item 6, the terms claim on-chain data)
// Every module exports `entries`, shaped like the EXP entries in expansion.js (name, route, usd, tags, desc, schema, run) plus title, question and example.
'use strict';

const entries = [
  ...require('../r23/pkg-check').entries,
  ...require('./txprecheck').entries,
  ...require('./company-check').entries,
  ...require('./rwa').entries,
];

module.exports = { entries };

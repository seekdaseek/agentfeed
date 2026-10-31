#!/usr/bin/env node
// ops/r23-crash-e2e-snapshot.js: the whole ledger-score pipeline on REAL data, checked against scikit-learn (R23 T1, gate G2 on the snapshot).
//   node ops/r23-crash-e2e-snapshot.js --ledger <copy of ll-snap-20261031.db> --model <validation-model.json> --reference <weekly-reference.csv> --workdir <empty dir> [--clock 2026-09-24T00:00:00Z] [--now 2026-10-31T15:30:00Z]
// The scorer runs on the snapshot with the VALIDATION model and a clock set to the day that model's training window ended, so every pool after it is "scored at entry" (scored before its
// outcome check) exactly as it would have been live. The daily job then computes the weekly AUC from the stored scores and the snapshot's labels and checks. The reference is
// sklearn.metrics.roc_auc_score of the Python scores of the same pools (06_weekly_reference.py). Exit 0 only if every week matches: same n, same positives, AUC to 1e-9.
// Never writes the ledger copy (the scorer opens it read-only); the sha256 of the file is printed before and after.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createScorer } = require('../ledger-score/score');

function args(argv) { const a = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i]; return a; }
const a = args(process.argv.slice(2));
for (const k of ['ledger', 'model', 'reference', 'workdir']) if (!a[k]) { console.error(`missing --${k}`); process.exit(2); }
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const clock = Date.parse(a.clock || '2026-09-24T00:00:00Z') / 1000, now = Date.parse(a.now || '2026-10-31T15:30:00Z') / 1000;
fs.mkdirSync(a.workdir, { recursive: true });
const before = sha(a.ledger);
const s = createScorer({ cfg: { ledgerDb: a.ledger, scoreDb: path.join(a.workdir, 'scores.db'), modelFile: a.model, backfillDays: 0, aucWeeks: 14 }, clock: () => clock });
const began = Date.now();
let ticks = 0, total = 0;
for (let r; (r = s.tick()).scored > 0 || r.skipped > 0; ticks++) total += r.scored;
const scoreMs = Date.now() - began;
const out = s.daily(now, true);
const rows = s.sc.prepare('SELECT week_start, n, positives, auc FROM auc_weekly ORDER BY week_start').all();
s.close();
const ref = fs.readFileSync(a.reference, 'utf8').trim().split('\n').slice(1).map((l) => { const [week_start, n, positives, auc] = l.split(','); return { week_start, n: Number(n), positives: Number(positives), auc: Number(auc) }; });
const cmp = ref.map((r) => { const j = rows.find((x) => x.week_start === r.week_start); return { week_start: r.week_start, n: [j && j.n, r.n], positives: [j && j.positives, r.positives], auc_js: j && j.auc, auc_sklearn: r.auc, abs_diff: j ? Math.abs(j.auc - r.auc) : null }; });
const ok = ref.length === rows.length && cmp.every((c) => c.n[0] === c.n[1] && c.positives[0] === c.positives[1] && c.abs_diff !== null && c.abs_diff < 1e-9);
const after = sha(a.ledger);
console.log(JSON.stringify({ pools_scored: total, ticks, score_ms: scoreMs, weeks_written: out.weeks.length, comparison: cmp, ledger_sha256_before: before, ledger_sha256_after: after, ledger_unchanged: before === after, all_weeks_match: ok }, null, 1));
process.exit(ok && before === after ? 0 : 1);

#!/usr/bin/env node
// ops/r23-crash-mutate.js: the negative controls of R23 T1 as one run. Each mutation removes or breaks ONE check in ledger-score/score.js, tools/r23/crash-risk.js or
// tools/r23/crash-model/*.js; the tests that rely on that check must then FAIL. The file is always restored (also on a signal), and the suite is run once more unmutated at the end.
//   node ops/r23-crash-mutate.js            -> a table; exit 0 only if every mutation was caught and the unmutated suite is green
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCORE = 'ledger-score/score.js', ROUTES = 'tools/r23/crash-risk.js', METRICS = 'tools/r23/crash-model/metrics.js', EVAL = 'tools/r23/crash-model/evaluator.js', FEAT = 'tools/r23/crash-model/features.js';
const T = { score: 'test/r23-crash-score.test.js', routes: 'test/r23-crash-routes.test.js', model: 'test/r23-crash-model.test.js', real: 'test/r23-crash-real-server.test.js' };

// [id, file, from, to, test file that must fail, what the check is, (optional) how many times `from` occurs: all of them are replaced]
const M = [
  ['reader-writable', SCORE, "new Database(file, { readonly: true, fileMustExist: true });\n  db.pragma('query_only = ON');", 'new Database(file, { fileMustExist: true });', T.score, 'launchledger handle is read-only'],
  ['skip-done-check', SCORE, "      if (isDone.get(row.id, row.id)) continue;\n      todo.push(row);\n      if (todo.length >= cfg.batch) { headFull = true; break; }", "      todo.push(row);\n      if (todo.length >= cfg.batch) { headFull = true; break; }", T.score, 'a scored pool is not picked again'],
  ['required-columns', SCORE, "const miss = missingColumn(row);\n      if (miss)", "const miss = null;\n      if (miss)", T.score, 'a pool with a NULL t0 column is skipped'],
  ['no-transaction', SCORE, 'sc.transaction(() => {\n      for (const r of outRows)', '(() => {\n      for (const r of outRows)', T.score, 'a batch is written in one transaction'],
  ['batch-cap', SCORE, 'cfg.batch = Math.min(Math.max(1, Math.floor(Number(cfg.batch) || HARD_BATCH)), HARD_BATCH);', 'cfg.batch = Number(cfg.batch) || HARD_BATCH;', T.score, 'at most 500 pools per tick'],
  ['entry-lag-rule', SCORE, 'AND scored_ts - t0_ts <= ?', 'AND scored_ts - t0_ts <= ? + 1e12', T.score, 'only pools scored at entry count', 3],
  ['outcome-after-scoring', SCORE, 'if (!Number.isFinite(atTs) || !(atTs > scoredTs)) continue;', 'if (!Number.isFinite(atTs)) continue;', T.score, 'the outcome must come after the score'],
  ['out-of-sample-guard', SCORE, "const from = outOfSampleFrom(ver);\n      if (from === null) continue;                                      // cannot show", "const from = 0;\n      if (from === null) continue;                                      // cannot show", T.score, 'pools inside the training window do not count'],
  ['auc-floor', SCORE, 's.length >= cfg.minResolved &&', 's.length >= 0 &&', T.score, 'AUC is NULL under 200 resolved pools'],
  ['scan-restart-on-gap', SCORE, 'now - st.at > C.SCAN_SLACK_SEC / 2 ||', '', T.score, 'a gap of hours restarts the scan from the top'],
  ['scan-cursor', SCORE, 'cursor = broke || examined >= limit ? last : null;', 'cursor = null;', T.score, 'the backlog continues from the saved cursor'],
  ['tie-ranks', METRICS, 'const avg = (i + j) / 2 + 1;', 'const avg = i + 1;', T.model, 'tied scores share their average rank'],
  ['threshold-slack', EVAL, 'const slack = opts.slack === undefined ? SLACK : opts.slack;', 'const slack = 0;', T.model, 'thresholds are widened by 8 ulp'],
  ['hour-tables', FEAT, 'hour_sin: tables.hour_sin[hour], hour_cos: tables.hour_cos[hour],', 'hour_sin: Math.sin((2 * Math.PI * hour) / 24), hour_cos: Math.cos((2 * Math.PI * hour) / 24),', T.model, 'hour_sin / hour_cos come from the numpy table'],
  ['version-check', EVAL, "if (got !== m[2]) throw new Error(", "if (false) throw new Error(", T.model, 'an edited model file does not load'],
  ['coverage-7d', ROUTES, 'WHERE ${key} = ? AND scored_ts >= ? AND t0_ts >= ? ORDER BY', 'WHERE ${key} = ? AND scored_ts >= ? AND ? > 0 ORDER BY', T.routes, 'a pool must have entered within 7 days'],
  ['stale-newest', ROUTES, 'if (ledgerRunning && nowSec - newest > C.STALE_NEWEST_SEC)', 'if (false)', T.routes, 'a score older than 30 minutes while LaunchLedger runs is a 503'],
  ['scorer-heartbeat', ROUTES, 'if (nowSec - tick > C.TICK_STALE_SEC)', 'if (false)', T.routes, 'a scorer that stopped running is a 503'],
  ['exactly-one', ROUTES, 'if (hasMint === hasPool) throw', 'if (false) throw', T.routes, 'exactly one of mint or pool'],
  ['base58', ROUTES, 'typeof a[key] !== \'string\' || !BASE58_RE.test(a[key].trim())', 'typeof a[key] !== \'string\'', T.routes, '32 to 44 base58 characters'],
  ['limit-clamp', ROUTES, 'if (!Number.isInteger(n) || n < 1 || n > C.RADAR_MAX) throw', 'if (!Number.isInteger(n) || n < 1) throw', T.routes, 'a limit over 100 is a 400, never clamped'],
  ['not-recorded-503', ROUTES, "if (!h.ledgerRunning) throw unavailable('LaunchLedger has not completed a cycle recently", "if (false) throw unavailable('LaunchLedger has not completed a cycle recently", T.routes, 'an unscored pool while LaunchLedger is down is a 503, not a 404'],
  ['reopen-on-error', ROUTES, "if (!deps.db) { try { handle && handle.close(); } catch { /* already closed */ } handle = null; }", '', T.routes, 'the handle is reopened after an error'],
  ['live-cuts-floor', ROUTES, 'live.n >= minLive', 'true', T.routes, 'live decile boundaries need 2,000 scores'],
  ['flag-default-off', ROUTES, "=== 'on';", "!== 'off';", T.routes, 'the routes are off unless R23_CRASH_ROUTES=on'],
  ['flag-registration', 'tools/r23/index.js', '...(crash.enabled() ? crash.entries : []),', '...crash.entries,', T.real, 'with the switch off the entries are not registered (the lead\'s index.js; real-server test through the integrated path is the check in the notes)'],
];

const original = new Map();
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const restore = () => { for (const [f, src] of original) fs.writeFileSync(path.join(ROOT, f), src); };
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

const run = (file) => {
  const r = spawnSync(process.execPath, ['--test', file], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, OVERHANG_DB_PATH: '/Volumes/D/pensio/scratch/overhang.db', AGENTFEED_DB: ':memory:' }, timeout: 280000 });
  const m = /# fail (\d+)/.exec(r.stdout) || /ℹ fail (\d+)/.exec(r.stdout);
  return { code: r.status, fails: m ? Number(m[1]) : null };
};

const rows = [];
let allCaught = true;
for (const [id, file, from, to, test, what, times = 1] of M) {
  if (file === 'tools/r23/index.js') continue;                     // not a file of this task: documented in the notes, not mutated here
  const src = read(file);
  const n = src.split(from).length - 1;
  if (n !== times) { rows.push({ id, what, result: `SKIPPED: the text to mutate occurs ${n} times` }); allCaught = false; continue; }
  original.set(file, src);
  fs.writeFileSync(path.join(ROOT, file), src.split(from).join(to));
  let res;
  try { res = run(test); } finally { fs.writeFileSync(path.join(ROOT, file), src); original.delete(file); }
  const caught = res.code !== 0 && (res.fails === null || res.fails > 0);
  if (!caught) allCaught = false;
  rows.push({ id, what, test: path.basename(test), failing_tests: res.fails, result: caught ? 'CAUGHT' : 'NOT CAUGHT' });
}
const clean = [T.score, T.routes, T.model].map((t) => ({ test: path.basename(t), ...run(t) }));
console.table(rows);
console.log('unmutated suite:', JSON.stringify(clean));
const green = clean.every((c) => c.code === 0 && c.fails === 0);
console.log(JSON.stringify({ mutations: rows.length, caught: rows.filter((r) => r.result === 'CAUGHT').length, all_caught: allCaught, unmutated_green: green }));
process.exit(allCaught && green ? 0 : 1);

// test/r23-crash-score.test.js: gate G2 of R23 T1, the ledger-score service (ledger-score/score.js) against a synthetic launchledger.db built to the live schema.
//   - its scores equal the Python scores of the same rows (the production model, scikit-learn predict_proba, test/fixtures/r23/crash/parity-fixture.json);
//   - launchledger.db is byte-identical after a run, a write through the reader handle throws, and the control shows both checks can fail;
//   - a second run scores 0 pools, a crash between batches loses nothing and scores nothing twice, a batch is never more than 500;
//   - extra columns and tables are harmless, a missing needed column fails loudly and recovers, a pool with a NULL t0 column is skipped and counted;
//   - the weekly AUC job reproduces an AUC computed independently here (pairwise count) on a planted dataset, and writes NULL under the floor of 200.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { makeLedger, FIXTURE } = require('./fixtures/r23/crash/ledger-fixture');
const { createScorer, weekStartOf } = require('../ledger-score/score');
const { decileCuts } = require('../tools/r23/crash-model/metrics');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-crash-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const ROWS = FIXTURE.rows;
const NOW = Math.max(...ROWS.map((r) => r.t0_ts)) + 120;
const scorer = (d, over = {}, extra = {}) => createScorer({ cfg: { ledgerDb: path.join(d, 'll.db'), scoreDb: path.join(d, 'scores.db'), backfillDays: 1000, ...over }, clock: () => NOW, ...extra });
const scoreRows = (s) => s.sc.prepare('SELECT * FROM scores ORDER BY pool_id').all();

test('scores equal the Python scores of the same rows; mint, pool, entry numbers and model version are stored', () => {
  const d = tmp(); makeLedger(path.join(d, 'll.db'), { pools: ROWS });
  const s = scorer(d);
  const r = s.tick();
  assert.equal(r.scored, ROWS.length);
  const got = new Map(scoreRows(s).map((x) => [x.pool_id, x]));
  assert.equal(got.size, ROWS.length);
  let max = 0;
  ROWS.forEach((row, i) => {
    const g = got.get(row.id);
    max = Math.max(max, Math.abs(g.score - FIXTURE.py[i]));
    assert.equal(g.mint, row.base_mint); assert.equal(g.pool, row.pool_address); assert.equal(g.dex, row.dex); assert.equal(g.t0_ts, row.t0_ts);
    assert.equal(g.t0_liquidity_usd, row.t0_liquidity_usd); assert.equal(g.t0_fdv_usd, row.t0_fdv_usd);
    assert.equal(g.model_version, s.model.model_version); assert.equal(g.scored_ts, NOW);
  });
  assert.ok(max < 1e-9, `largest difference from the Python score ${max}`);
  assert.ok(ROWS.some((r) => r.t0_liquidity_usd === null) && ROWS.some((r) => r.t0_fdv_usd === null), 'control: the fixture holds pools with a NULL liquidity and a NULL fdv, and they were scored');
  s.close();
});

test('launchledger.db is byte-identical after a run; a write through the reader handle throws; the control shows the hash and the throw can fail', () => {
  const d = tmp(); const ll = path.join(d, 'll.db');
  makeLedger(ll, { pools: ROWS });
  const before = sha(ll);
  const s = scorer(d);
  s.tick(); s.daily(NOW, true);
  assert.throws(() => s.ll.prepare('UPDATE pools SET cohort = 0').run(), /readonly/i);
  assert.throws(() => s.ll.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('x', 'y'), /readonly/i);
  assert.throws(() => s.ll.exec('CREATE TABLE intruder (a)'), /readonly/i);
  s.close();
  assert.equal(sha(ll), before, 'the launchledger file did not change');
  // negative control: a normal handle CAN write this file, and the hash then differs
  const w = new Database(ll); w.prepare('UPDATE pools SET cohort = 1 WHERE id = ?').run(ROWS[0].id); w.prepare("INSERT INTO meta (k, v) VALUES ('probe', '1')").run(); w.pragma('wal_checkpoint(TRUNCATE)'); w.close();
  assert.notEqual(sha(ll), before, 'control: the hash does detect a write');
  const ro = new Database(ll, { readonly: true });
  assert.throws(() => ro.prepare("INSERT INTO meta (k, v) VALUES ('probe2', '1')").run(), /readonly/i, 'control: a readonly handle refuses writes on its own');
  ro.close();
});

test('a second run scores 0 new pools, in the same process and after a restart', () => {
  const d = tmp(); makeLedger(path.join(d, 'll.db'), { pools: ROWS });
  const s = scorer(d);
  assert.equal(s.tick().scored, ROWS.length);
  assert.equal(s.tick().scored, 0);
  assert.equal(s.meta('scored_total'), String(ROWS.length));
  s.close();
  const s2 = scorer(d);
  assert.equal(s2.tick().scored, 0);
  assert.equal(s2.sc.prepare('SELECT COUNT(*) AS n FROM scores').get().n, ROWS.length);
  assert.equal(s2.sc.prepare('SELECT COUNT(*) AS n FROM (SELECT pool_id FROM scores GROUP BY pool_id HAVING COUNT(*) > 1)').get().n, 0);
  s2.close();
});

test('a tick scores at most 500 pools (also when asked for more), newest entry first, and the backlog drains over ticks with nothing twice', () => {
  const d = tmp();
  const big = []; for (let k = 0; k < 1300; k++) { const r = ROWS[k % ROWS.length]; big.push({ ...r, id: 1000000 + k, pool_address: `p${k}`, base_mint: `m${k}`, t0_ts: NOW - 5000 + k }); }
  makeLedger(path.join(d, 'll.db'), { pools: big });
  const s = scorer(d, { batch: 10000 });
  const a = s.tick();
  assert.equal(a.scored, 500); assert.equal(a.full, true);
  const ids = scoreRows(s).map((x) => x.pool_id);
  assert.equal(Math.min(...ids), 1000000 + 800, 'the newest 500 entries were scored first');
  assert.equal(s.tick().scored, 500);
  const c = s.tick();
  assert.equal(c.scored, 300); assert.equal(c.full, false);
  assert.equal(s.tick().scored, 0);
  assert.equal(scoreRows(s).length, 1300);
  s.close();
});

test('a crash between batches loses nothing and scores nothing twice (the failed batch is rolled back whole)', () => {
  const d = tmp(); makeLedger(path.join(d, 'll.db'), { pools: ROWS });
  const hooks = { beforeCommit: (i) => { if (i === 1) throw new Error('simulated crash'); } };
  const s = scorer(d, { batch: 100 }, { hooks });
  assert.equal(s.tick().scored, 100);
  assert.throws(() => s.tick(), /simulated crash/);
  assert.equal(s.sc.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 100, 'the crashed batch left no half-written rows');
  assert.equal(s.meta('scored_total'), '100', 'and no counter moved');
  assert.equal(s.ll, null, 'the launchledger handle was dropped so the next tick reopens it');
  s.close();
  // restart: a new process picks up exactly the rest
  const s2 = scorer(d, { batch: 100 });
  let total = 100, guard = 0;
  for (let r; (r = s2.tick()).scored > 0 && guard < 10; guard++) total += r.scored;
  assert.equal(total, ROWS.length);
  const rows = scoreRows(s2);
  assert.deepEqual(rows.map((x) => x.pool_id).sort((a, b) => a - b), ROWS.map((x) => x.id).sort((a, b) => a - b), 'every pool exactly once');
  s2.close();
  // the same instance also recovers once the fault is gone
  const d2 = tmp(); makeLedger(path.join(d2, 'll.db'), { pools: ROWS });
  const h2 = { beforeCommit: () => { throw new Error('boom'); } };
  const s3 = scorer(d2, { batch: 100 }, { hooks: h2 });
  assert.throws(() => s3.tick(), /boom/);
  h2.beforeCommit = null;
  assert.equal(s3.tick().scored, 100);
  s3.close();
});

test('extra unknown columns and tables in launchledger.db change nothing', () => {
  const d = tmp(); makeLedger(path.join(d, 'll.db'), { pools: ROWS, extras: true });
  const s = scorer(d);
  assert.ok(s.ll === null);
  assert.equal(s.tick().scored, ROWS.length);
  const d0 = tmp(); makeLedger(path.join(d0, 'll.db'), { pools: ROWS });
  const s0 = scorer(d0); s0.tick();
  assert.deepEqual(scoreRows(s).map((x) => x.score), scoreRows(s0).map((x) => x.score), 'identical scores with and without the extras');
  s.close(); s0.close();
});

test('a needed column missing from pools fails loudly, writes nothing, and recovers when it is back', () => {
  const d = tmp(); const ll = path.join(d, 'll.db');
  makeLedger(ll, { pools: ROWS.slice(0, 20) });
  const w = new Database(ll); w.exec('ALTER TABLE pools DROP COLUMN quote_mint'); w.close();
  const s = scorer(d);
  assert.throws(() => s.tick(), /lacks the column\(s\) quote_mint/);
  assert.equal(s.sc.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 0);
  assert.equal(s.ll, null, 'the handle is dropped, so a later tick looks at the file again');
  const w2 = new Database(ll); w2.exec('ALTER TABLE pools ADD COLUMN quote_mint TEXT'); w2.close();
  const r = s.tick();
  assert.deepEqual([r.scored, r.skipped], [0, 20], 'the column is back but empty: every pool is skipped as missing it, none is scored with an invented quote');
  const w3 = new Database(ll); const upd = w3.prepare('UPDATE pools SET quote_mint = ? WHERE id = ?'); for (const x of ROWS.slice(0, 20)) upd.run(x.quote_mint, x.id); w3.close();
  s.sc.exec("DELETE FROM skipped; DELETE FROM meta WHERE k = 'scan'");           // the operator's way to say "look at these again"
  assert.equal(s.tick().scored, 20, 'with the values back the same pools score');
  s.close();
});

test('a pool with a NULL (or non-positive) t0 column is skipped and counted, once, never scored; the same pool with the value present is scored', () => {
  const d = tmp();
  const a = { ...ROWS[0], id: 9000001, pool_address: 'a', base_mint: 'ma' }, b = { ...ROWS[1], id: 9000002, pool_address: 'b', base_mint: 'mb', t0_price_usd: null },
    c = { ...ROWS[2], id: 9000003, pool_address: 'c', base_mint: 'mc', t0_volume24h_usd: null }, z = { ...ROWS[3], id: 9000004, pool_address: 'z', base_mint: 'mz', t0_price_usd: 0 },
    ok2 = { ...ROWS[1], id: 9000005, pool_address: 'd', base_mint: 'md' };
  makeLedger(path.join(d, 'll.db'), { pools: [a, b, c, z, ok2] });
  const s = scorer(d);
  const r = s.tick();
  assert.deepEqual([r.scored, r.skipped], [2, 3]);
  assert.deepEqual(s.sc.prepare('SELECT pool_id FROM scores ORDER BY pool_id').pluck().all(), [9000001, 9000005], 'control: the same features with a price present are scored');
  assert.deepEqual(s.sc.prepare('SELECT pool_id, reason FROM skipped ORDER BY pool_id').all(), [{ pool_id: 9000002, reason: 'missing t0_price_usd' }, { pool_id: 9000003, reason: 'missing t0_volume24h_usd' }, { pool_id: 9000004, reason: 'missing t0_price_usd' }]);
  assert.equal(s.meta('skipped_total'), '3');
  const r2 = s.tick();
  assert.deepEqual([r2.scored, r2.skipped], [0, 0], 'a skipped pool is not counted again on the next tick');
  assert.equal(s.meta('skipped_total'), '3');
  s.close();
});

test('only cohort pools with a t0_ts inside the backfill window are scored', () => {
  const d = tmp();
  const rows = [
    { ...ROWS[0], id: 9100001, pool_address: 'in', base_mint: 'm1', t0_ts: NOW - 3600 },
    { ...ROWS[1], id: 9100002, pool_address: 'old', base_mint: 'm2', t0_ts: NOW - 8 * 86400 },
    { ...ROWS[2], id: 9100003, pool_address: 'nc', base_mint: 'm3', t0_ts: NOW - 3600, cohort: 0 },
    { ...ROWS[3], id: 9100004, pool_address: 'nt', base_mint: 'm4', t0_ts: null, discovered_ts: NOW - 100, cohort_ts: null },
  ];
  makeLedger(path.join(d, 'll.db'), { pools: rows });
  const s = scorer(d, { backfillDays: 7 });
  assert.equal(s.tick().scored, 1);
  assert.deepEqual(s.sc.prepare('SELECT pool_id FROM scores').pluck().all(), [9100001]);
  s.close();
});

test('the launchledger file missing is an error the process survives: the next tick works once the file exists', () => {
  const d = tmp();
  const s = scorer(d);
  assert.throws(() => s.tick(), /unable to open database|SQLITE_CANTOPEN|no such file|Cannot open/i);
  makeLedger(path.join(d, 'll.db'), { pools: ROWS.slice(0, 5) });
  assert.equal(s.tick().scored, 5);
  s.close();
});

// ---- the weekly AUC job on a planted dataset
const MODEL_VERSION = () => require('../tools/r23/crash-model/meta.json').model_version;
const WEEK0 = Date.parse('2026-11-02T00:00:00Z') / 1000;           // a Monday, after the production model's training window (it ends 2026-10-29)
const THEN = WEEK0 + 10 * 86400;
function lcg(seed) { let x = seed >>> 0; return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296); }

/** pairwise AUC, written here and not shared with the code under test: P(positive > negative) + half of the ties */
function pairwiseAuc(scores, labels) {
  let win = 0, pairs = 0;
  for (let i = 0; i < scores.length; i++) if (labels[i]) for (let j = 0; j < scores.length; j++) if (!labels[j]) { pairs++; win += scores[i] > scores[j] ? 1 : scores[i] === scores[j] ? 0.5 : 0; }
  return win / pairs;
}

/** plant `n` pools of one week: scores in the score database, outcome in the ledger */
function plant({ d, n, positives, weekStart = WEEK0, idBase = 100, lag = 30, seed = 7, quantize = 100, reverse = false, outcomeAtTsOffset = 86000 }) {
  const rnd = lcg(seed); const pools = [], labels = [], checks = [], scores = [], y = [];
  for (let k = 0; k < n; k++) {
    const id = idBase + k, t0 = weekStart + 600 + k * 120, pos = k < positives ? 1 : 0;
    const sc = Math.round((pos ? 0.35 + 0.65 * rnd() : 0.75 * rnd()) * quantize) / quantize;      // quantised, so there are ties
    pools.push({ id, pool_address: `pp${id}`, base_mint: `pm${id}`, t0_ts: t0, t0_price_usd: 2.0, ...{ t0_volume24h_usd: 1, t0_txns24h: 1, pool_created_ts: t0 - 10, name: 'X / SOL', dex: 'pump-fun', quote_mint: 'So11111111111111111111111111111111111111112', cohort_reason: 'volume>=1000' } });
    const at = t0 + outcomeAtTsOffset;
    labels.push({ pool_id: id, horizon_days: 1, label: pos ? 'liquidity_collapsed' : 'active', evidence: { at_ts: at } });
    checks.push({ pool_id: id, ts: at, price_usd: pos ? 0.2 : 1.9 });            // -90% against -5%
    scores.push([id, `pm${id}`, `pp${id}`, 'pump-fun', reverse ? 1 - sc : sc, null, t0 + lag, t0, 1000, 5000]);
    y.push(pos);
  }
  return { pools, labels, checks, scores, y };
}
function load(s, scores, version) {
  const ins = s.sc.prepare('INSERT INTO scores (pool_id, mint, pool, dex, score, model_version, scored_ts, t0_ts, t0_liquidity_usd, t0_fdv_usd) VALUES (?,?,?,?,?,?,?,?,?,?)');
  s.sc.transaction(() => { for (const r of scores) ins.run(...r.slice(0, 5), version, ...r.slice(6)); })();
}

test('weekly AUC equals an independent pairwise AUC on a planted dataset; deciles sum to n; the row is the latest computation (upsert)', () => {
  const d = tmp(); const P = plant({ d, n: 300, positives: 60 });
  makeLedger(path.join(d, 'll.db'), { pools: P.pools, labels: P.labels, checks: P.checks });
  const s = createScorer({ cfg: { ledgerDb: path.join(d, 'll.db'), scoreDb: path.join(d, 'scores.db') }, clock: () => THEN });
  load(s, P.scores, s.model.model_version);
  const out = s.daily(THEN, true);
  assert.equal(out.weeks.length, 1);
  const row = s.sc.prepare('SELECT * FROM auc_weekly').get();
  const want = pairwiseAuc(P.scores.map((r) => r[4]), P.y);
  assert.equal(row.week_start, '2026-11-02'); assert.equal(row.model_version, s.model.model_version);
  assert.equal(row.n, 300); assert.equal(row.positives, 60);
  assert.ok(Math.abs(row.auc - want) < 1e-12, `${row.auc} vs ${want}`);
  assert.ok(want > 0.8 && want < 1, 'control: the planted AUC is neither trivial nor perfect');
  const dec = JSON.parse(row.deciles);
  assert.equal(dec.basis, 'frozen'); assert.equal(dec.rows.length, 10);
  assert.equal(dec.rows.reduce((a, r) => a + r.n, 0), 300); assert.equal(dec.rows.reduce((a, r) => a + r.positives, 0), 60);
  assert.ok(dec.rows[9].positives / dec.rows[9].n > dec.rows[0].positives / Math.max(1, dec.rows[0].n), 'the top decile has the higher hit rate');
  assert.equal(row.computed_ts, THEN);
  // run again at a later time: still one row per (week, model), recomputed
  s.daily(THEN + 2 * 86400, true);
  assert.equal(s.sc.prepare('SELECT COUNT(*) AS n FROM auc_weekly').get().n, 1);
  assert.equal(s.sc.prepare('SELECT computed_ts FROM auc_weekly').get().computed_ts, THEN + 2 * 86400);
  // negative control: reversed scores give 1 - AUC, so the number really comes from the scores
  const d2 = tmp(); const R = plant({ d: d2, n: 300, positives: 60, reverse: true });
  makeLedger(path.join(d2, 'll.db'), { pools: R.pools, labels: R.labels, checks: R.checks });
  const s2 = createScorer({ cfg: { ledgerDb: path.join(d2, 'll.db'), scoreDb: path.join(d2, 'scores.db') }, clock: () => THEN });
  load(s2, R.scores, s2.model.model_version); s2.daily(THEN, true);
  assert.ok(Math.abs(s2.sc.prepare('SELECT auc FROM auc_weekly').get().auc - (1 - want)) < 1e-12);
  s.close(); s2.close();
});

test('weekly AUC is NULL under 200 resolved pools and when there is no positive or no negative; n and positives are still written', () => {
  const d = tmp();
  const A = plant({ d, n: 199, positives: 50, weekStart: WEEK0, idBase: 1000 });                       // 199: one under the floor
  const B = plant({ d, n: 200, positives: 50, weekStart: WEEK0 + 7 * 86400, idBase: 2000 });          // exactly 200: computed
  const C = plant({ d, n: 250, positives: 0, weekStart: WEEK0 + 14 * 86400, idBase: 3000 });          // no positive
  const E = plant({ d, n: 250, positives: 250, weekStart: WEEK0 + 21 * 86400, idBase: 4000 });        // no negative
  const all = (k) => [A, B, C, E].flatMap((x) => x[k]);
  makeLedger(path.join(d, 'll.db'), { pools: all('pools'), labels: all('labels'), checks: all('checks') });
  const NOW2 = WEEK0 + 40 * 86400;
  const s = createScorer({ cfg: { ledgerDb: path.join(d, 'll.db'), scoreDb: path.join(d, 'scores.db'), aucWeeks: 12 }, clock: () => NOW2 });
  load(s, all('scores'), s.model.model_version);
  s.daily(NOW2, true);
  const rows = Object.fromEntries(s.sc.prepare('SELECT * FROM auc_weekly').all().map((r) => [r.week_start, r]));
  assert.equal(rows['2026-11-02'].n, 199); assert.equal(rows['2026-11-02'].auc, null);
  assert.equal(rows['2026-11-09'].n, 200); assert.ok(rows['2026-11-09'].auc > 0.5);
  assert.equal(rows['2026-11-16'].positives, 0); assert.equal(rows['2026-11-16'].auc, null);
  assert.equal(rows['2026-11-23'].positives, 250); assert.equal(rows['2026-11-23'].auc, null);
  s.close();
});

test('which pools count: scored at entry, outside the training window, outcome AFTER scoring, a 24 hour price present; each exclusion has a control run that includes it', () => {
  const d = tmp();
  const base = plant({ d, n: 220, positives: 40, idBase: 5000 });
  // 1 pool scored 2 hours after entry (not at entry)
  const late = plant({ d, n: 1, positives: 0, idBase: 6000, lag: 7200 });
  // 1 pool whose outcome check is BEFORE it was scored (a check at t0 + 10 s, scored at t0 + 30 s), and 1 whose check is just AFTER (t0 + 100 s): the control
  const pre = plant({ d, n: 1, positives: 1, idBase: 6100, outcomeAtTsOffset: 10 });
  const post = plant({ d, n: 1, positives: 0, idBase: 6150, outcomeAtTsOffset: 100 });
  // 1 pool inside the production model's training window (week of 2026-10-26: it entered before the window ended)
  const ins = plant({ d, n: 1, positives: 1, idBase: 6200, weekStart: Date.parse('2026-10-26T00:00:00Z') / 1000 });
  // pools with no label, a label without at_ts, a check with a NULL price, a price of exactly 0
  const nolabel = plant({ d, n: 1, positives: 0, idBase: 6300 }); nolabel.labels.length = 0;
  const noat = plant({ d, n: 1, positives: 0, idBase: 6400 }); noat.labels[0].evidence = { reason: 'no observation at horizon' };
  const nullp = plant({ d, n: 1, positives: 1, idBase: 6500 }); nullp.checks[0].price_usd = null;
  const zero = plant({ d, n: 1, positives: 0, idBase: 6600 }); zero.checks[0].price_usd = 0;      // price 0 counts as -100%: a positive
  const parts = [base, late, pre, post, ins, nolabel, noat, nullp, zero];
  const all = (k) => parts.flatMap((x) => x[k]);
  makeLedger(path.join(d, 'll.db'), { pools: all('pools'), labels: all('labels'), checks: all('checks') });
  const mk = (over) => { const s = createScorer({ cfg: { ledgerDb: path.join(d, 'll.db'), scoreDb: path.join(d, `s${Math.random()}.db`), aucWeeks: 12, ...over }, clock: () => THEN }); load(s, all('scores'), s.model.model_version); return s; };
  const s = mk({}); s.daily(THEN, true);
  const w2 = s.sc.prepare("SELECT * FROM auc_weekly WHERE week_start = '2026-11-02'").get();
  assert.equal(w2.n, 220 + 2, 'the 220 planted pools, the price-0 pool and the pool whose check came just after scoring; nothing else');
  assert.equal(w2.positives, 40 + 1, 'the price-0 pool is a positive');
  assert.equal(s.sc.prepare("SELECT COUNT(*) AS n FROM auc_weekly WHERE week_start = '2026-10-26'").get().n, 0, 'a week holding only in-sample pools is not written');
  // controls: relax each rule and the count moves
  const loose = mk({ entryLagSec: 1e9 }); loose.daily(THEN, true);
  assert.equal(loose.sc.prepare("SELECT n FROM auc_weekly WHERE week_start = '2026-11-02'").get().n, 222 + 1, 'without the at-entry rule the pool scored two hours after entry counts too (the pool whose outcome pre-dates its score stays out)');
  s.close(); loose.close();
});

test('live decile boundaries: written only from at-entry scores after the training window, only with 2,000 or more; below that the frozen ones are used', () => {
  const d = tmp(); makeLedger(path.join(d, 'll.db'), { pools: [] });
  const s = createScorer({ cfg: { ledgerDb: path.join(d, 'll.db'), scoreDb: path.join(d, 'scores.db') }, clock: () => THEN });
  const ver = s.model.model_version, rnd = lcg(11);
  const mkRows = (n, idBase, t0, lag, inWindow = true) => Array.from({ length: n }, (_, k) => [idBase + k, `m${idBase + k}`, `p${idBase + k}`, 'pump-fun', rnd() ** 3, null, t0 + k + lag, t0 + k, 1, 1]);
  load(s, mkRows(1999, 1, THEN - 3 * 86400, 20), ver);
  assert.deepEqual(s.liveCuts(THEN), []);
  assert.equal(s.meta(`live:${ver}`), null, '1,999 is under the floor');
  load(s, mkRows(1, 5000, THEN - 3 * 86400, 20), ver);                                    // the 2,000th
  assert.equal(s.liveCuts(THEN).length, 1);
  const live = JSON.parse(s.meta(`live:${ver}`));
  assert.equal(live.n, 2000); assert.equal(live.cuts.length, 9);
  assert.deepEqual(live.cuts, decileCuts(s.sc.prepare('SELECT score FROM scores').pluck().all()));
  // controls: pools scored late, or inside the training window, or older than 14 days, are not in the sample
  const s2 = createScorer({ cfg: { ledgerDb: path.join(d, 'll.db'), scoreDb: path.join(d, 'scores2.db') }, clock: () => THEN });
  load(s2, mkRows(1500, 1, THEN - 3 * 86400, 20), ver);
  load(s2, mkRows(1500, 10000, THEN - 3 * 86400, 7200), ver);                             // scored two hours after entry
  load(s2, mkRows(1500, 20000, Date.parse('2026-10-20T00:00:00Z') / 1000, 20), ver);     // entered inside the training window
  load(s2, mkRows(1500, 30000, THEN - 20 * 86400, 20), ver);                              // older than 14 days
  assert.deepEqual(s2.liveCuts(THEN), [], 'only the 1,500 qualifying pools are counted: under the floor');
  s.close(); s2.close();
});

test('the scan: a backlog drains from a saved cursor reading each pool about once, idle ticks read only the newest 6 hours, a pool written late inside the slack is scored, a gap of hours or a longer window starts again from the top', () => {
  const d = tmp(); const ll = path.join(d, 'll.db');
  const newest = Math.max(...ROWS.map((x) => x.t0_ts));
  makeLedger(ll, { pools: ROWS });
  let t = NOW;
  const mkScorer = (dir, over = {}) => createScorer({ cfg: { ledgerDb: path.join(dir, 'll.db'), scoreDb: path.join(dir, 'scores.db'), backfillDays: 1000, batch: 100, ...over }, clock: () => t });
  const s = mkScorer(d);
  const head = ROWS.filter((x) => x.t0_ts >= NOW - 6 * 3600).length;
  let r; const scanned = [];
  while ((r = s.tick()).scored > 0) scanned.push(r.scanned);
  assert.equal(s.sc.prepare('SELECT COUNT(*) AS n FROM scores').get().n, ROWS.length);
  assert.ok(Math.max(...scanned) <= head + 100 + 1, `a tick reads the head plus at most one batch: ${scanned.join(',')} (head ${head})`);
  assert.equal(JSON.parse(s.meta('scan')).cursor, null, 'drained');
  const idle = s.tick();
  assert.equal(idle.scanned, head, 'an idle tick reads only the pools of the last 6 hours');
  assert.ok(head < ROWS.length / 10, 'control: that is a small part of the window');
  // a pool written minutes after its t0_ts is scored; one written more than the slack after its t0_ts is not found while nothing is catching up (the documented limit), and a restart of the scan finds it
  const w = new Database(ll);
  const mk = (id, ageS) => ({ ...ROWS[0], id, pool_address: `late${id}`, base_mint: `mlate${id}`, t0_ts: NOW - ageS, discovered_ts: NOW - ageS, cohort_ts: NOW - ageS });
  const put = (row) => { const cols = Object.keys(row); w.prepare(`INSERT INTO pools (${cols.join(',')}, cohort, retired) VALUES (${cols.map((c) => '@' + c).join(',')}, 1, 0)`).run(row); };
  put(mk(8800001, 3600)); assert.equal(s.tick().scored, 1, 'inside the slack');
  put(mk(8800002, 7 * 3600)); assert.equal(s.tick().scored, 0, 'outside the slack, nothing catching up');
  s.sc.exec("DELETE FROM meta WHERE k = 'scan'");
  assert.equal(s.tick().scored, 1, 'control: a scan that starts again from the top finds it');
  // the process was down for hours: the scan starts again from the top by itself
  put(mk(8800003, 9 * 3600));
  t = NOW + 3600; assert.equal(s.tick().scored, 0, 'one hour later: still outside the head');
  t = NOW + 3600 + 4 * 3600; assert.equal(s.tick().scored, 1, 'a gap of 4 hours since the last tick: found');
  w.close(); s.close();
  // a longer backfill window than the scan was made for starts from its own floor
  t = NOW;
  const d2 = tmp(); makeLedger(path.join(d2, 'll.db'), { pools: ROWS });
  const sorted = [...ROWS].sort((x, y) => y.t0_ts - x.t0_ts);
  const a2 = mkScorer(d2, { backfillDays: (NOW - sorted[40].t0_ts) / 86400, batch: 500 });
  const nA = a2.tick().scored; assert.ok(nA >= 41 && nA < ROWS.length); a2.close();
  const b2 = mkScorer(d2, { backfillDays: 1000, batch: 500 });
  assert.equal(b2.tick().scored, ROWS.length - nA, 'the older pools are scored once the window is longer');
  b2.close();
  void newest;
});

test('a long run of pools that are already scored does not end the catch-up: a tick that finds nothing new inside its read limit says a backlog remains, and the next ticks go on past them', () => {
  const d = tmp(); makeLedger(path.join(d, 'll.db'), { pools: ROWS });
  const s = scorer(d, { batch: 10 });                                      // the backlog pass reads at most 40 rows a tick
  const sorted = [...ROWS].sort((x, y) => y.t0_ts - x.t0_ts);
  const done = sorted.slice(5, 205);                                         // 200 pools between the newest and the rest are scored already (by an older model)
  const ins = s.sc.prepare("INSERT INTO scores (pool_id, mint, pool, dex, score, model_version, scored_ts, t0_ts) VALUES (?,?,?,?,?,'older-model',?,?)");
  for (const r of done) ins.run(r.id, r.base_mint, r.pool_address, r.dex, 0.5, NOW, r.t0_ts);
  let r, ticks = 0, empty = 0;
  while (ticks < 200) { r = s.tick(); ticks++; if (r.scored === 0 && r.full) empty++; if (!r.full && r.scored === 0) break; }
  assert.ok(empty >= 1, `at least one tick read only scored pools and still said a backlog remains (${empty})`);
  assert.equal(s.sc.prepare("SELECT COUNT(*) AS n FROM scores WHERE model_version != 'older-model'").get().n, ROWS.length - 200, 'every pool that was not scored got scored');
  assert.equal(s.sc.prepare("SELECT COUNT(*) AS n FROM scores WHERE model_version = 'older-model'").get().n, 200, 'and the others were left alone');
  assert.equal(JSON.parse(s.meta('scan')).cursor, null, 'drained at the end');
  s.close();
});

test('weekStartOf is the Monday of the ISO week, UTC', () => {
  assert.equal(weekStartOf(Date.parse('2026-11-02T00:00:00Z') / 1000), '2026-11-02');
  assert.equal(weekStartOf(Date.parse('2026-11-08T23:59:59Z') / 1000), '2026-11-02');
  assert.equal(weekStartOf(Date.parse('2026-11-09T00:00:00Z') / 1000), '2026-11-09');
  assert.equal(weekStartOf(Date.parse('2026-01-01T12:00:00Z') / 1000), '2025-12-29');
});

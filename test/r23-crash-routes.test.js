// test/r23-crash-routes.test.js: gate G3 of R23 T1, the three crash-risk routes (tools/r23/crash-risk.js) over a synthetic scores.db, and the R23_CRASH_ROUTES switch.
// Every branch of get_crash_risk (exactly one of mint/pool, base58, the 7 day edge, two pools of a mint, stale, missing, unreadable, reopened), get_launch_radar (limit, order,
// coverage, 503) and the free record (empty is empty), plus the wording rules for text a customer reads. The unpaid-402 / paid-200 / refund behaviour on the real server is
// test/r23-crash-real-server.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const CR = require('../tools/r23/crash-risk');
const C = require('../tools/r23/crash-model/constants');
const { ensureSchema } = require('../tools/r23/crash-model/schema');
const { decileOf } = require('../tools/r23/crash-model/metrics');
const META = require('../tools/r23/crash-model/meta.json');
const { makeLedger, FIXTURE } = require('./fixtures/r23/crash/ledger-fixture');
const { createScorer } = require('../ledger-score/score');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-crash-r-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const NOW = 1793600000;                                   // the clock of every test here, unix seconds
const M1 = 'So11111111111111111111111111111111111111112', M2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', M3 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const P1 = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', P2 = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu', P3 = 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX';
const VER = META.model_version;

/** a score database to the real schema; rows: [pool_id, mint, pool, dex, score, scored_ago_s, entry_ago_s] */
function mk(file, rows, { tickAgo = 30, cycleAgo = 60, extraMeta = {}, aucs = [], version = VER } = {}) {
  const d = new Database(file); ensureSchema(d);
  const ins = d.prepare('INSERT INTO scores (pool_id, mint, pool, dex, score, model_version, scored_ts, t0_ts, t0_liquidity_usd, t0_fdv_usd) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const put = d.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');
  const { trees, baseline, feature_names, categories, tables, required_columns, ...pub } = META;
  d.transaction(() => {
    for (const [id, mint, pool, dex, score, sAgo, eAgo] of rows) ins.run(id, mint, pool, dex, score, version, NOW - sAgo, NOW - (eAgo === undefined ? sAgo + 40 : eAgo), 12345.678, 45678.9);
    put.run('current_model', version); put.run(`model:${version}`, JSON.stringify(pub)); put.run(`frozen:${version}`, JSON.stringify({ cuts: META.decile_cuts, source: META.decile_cuts_source }));
    if (tickAgo !== null) put.run('last_tick_ts', String(NOW - tickAgo));
    if (cycleAgo !== null) put.run('ledger_last_cycle', String(NOW - cycleAgo));
    put.run('entry_lag_sec', String(C.ENTRY_LAG_SEC));
    for (const [k, v] of Object.entries(extraMeta)) put.run(k, typeof v === 'string' ? v : JSON.stringify(v));
    for (const a of aucs) d.prepare('INSERT INTO auc_weekly (week_start, model_version, n, positives, auc, deciles, computed_ts) VALUES (?,?,?,?,?,?,?)').run(a.week, a.version || version, a.n, a.positives, a.auc, JSON.stringify(a.deciles || { basis: 'frozen', rows: [] }), NOW - 3600);
  })();
  d.close();
  return file;
}
const H = (file, over = {}) => CR.makeHandlers({ env: { LEDGER_SCORE_DB: file }, now: () => NOW * 1000, ...over });
const rejects = (fn, props, msg) => { try { fn(); } catch (e) { for (const [k, v] of Object.entries(props)) assert.equal(e[k], v, `${msg || ''} ${k}`); return e; } assert.fail(`did not throw: ${msg || ''}`); };
const HOUR = 3600, DAY = 86400;
const base = () => [[1, M1, P1, 'pump-fun', 0.8123456789, 600], [2, M2, P2, 'pumpswap', 0.0004, 1200], [3, M3, P3, 'meteora-dbc', 0.05, 2400]];

test('entries: three routes, the free one flagged, descriptions of 180 to 255 characters that open the house way, schemas, titles, questions and examples', () => {
  const E = CR.entries;
  assert.deepEqual(E.map((e) => e.name), ['get_crash_risk', 'get_launch_radar', 'get_crash_risk_record']);
  assert.deepEqual(E.map((e) => e.route), ['GET /api/crash-risk', 'GET /api/launch-radar', 'GET /api/crash-risk-record']);
  assert.deepEqual(E.map((e) => e.usd), [0.02, 0.10, 0]);
  assert.deepEqual(E.map((e) => !!e.free), [false, false, true]);
  for (const e of E) {
    assert.ok(e.desc.length >= 180 && e.desc.length <= 255, `${e.name} desc is ${e.desc.length} characters`);
    assert.match(e.desc, /^Use when an agent needs /);
    assert.ok(e.tags.every((t) => t === t.toLowerCase()) && e.tags.length >= 3);
    assert.equal(typeof e.title, 'string'); assert.ok(e.title.length > 0 && e.title.length <= 40);
    assert.match(e.question, /\?$/);
    assert.equal(typeof e.schema, 'object'); assert.equal(typeof e.run, 'function');
    assert.deepEqual(JSON.parse(JSON.stringify(e.example)), e.example, `${e.name} example is plain JSON`);
    assert.ok(!/:[a-z]/.test(e.route.replace('GET /api/', '')), 'no path parameter');
  }
  assert.match(E[0].desc, /404 or 503 is never charged/); assert.match(E[1].desc, /503, not charged/);
  assert.ok(E[0].desc.includes(`${C.COVER_DAYS} days`) && E[1].desc.includes(`${C.RADAR_MAX} pools`) && E[0].desc.includes(C.MEANING), 'numbers in the text are the code constants');
  // the zod schemas accept what the handlers accept and refuse the same shapes
  const { z } = require('zod');
  const s0 = z.object(E[0].schema), s1 = z.object(E[1].schema);
  assert.ok(s0.safeParse({ mint: M1 }).success && s0.safeParse({ pool: P1 }).success && s0.safeParse({}).success);
  assert.ok(!s0.safeParse({ mint: 'not-base58-0OIl' }).success && !s0.safeParse({ mint: 'a'.repeat(45) }).success);
  assert.ok(s1.safeParse({ limit: 100 }).success && !s1.safeParse({ limit: 101 }).success && !s1.safeParse({ limit: 0 }).success && !s1.safeParse({ limit: 2.5 }).success);
});

test('get_crash_risk by mint and by pool: the answer, the meaning sentence, the decile from the frozen boundaries, the method text', () => {
  const f = mk(path.join(tmp(), 's.db'), base());
  const h = H(f);
  const a = h.getCrashRisk({ mint: M1 }), b = h.getCrashRisk({ pool: P1 });
  assert.deepEqual(a, b);
  assert.equal(a.mint, M1); assert.equal(a.pool, P1); assert.equal(a.dex, 'pump-fun');
  assert.equal(a.score, 0.812346, 'rounded to 6 decimals');
  assert.equal(a.meaning, 'chance of an 80 percent price fall within 24 hours');
  assert.equal(a.decile, decileOf(0.8123456789, META.decile_cuts)); assert.equal(a.decile_basis, 'frozen');
  assert.equal(h.getCrashRisk({ mint: M2 }).decile, decileOf(0.0004, META.decile_cuts));
  assert.ok(h.getCrashRisk({ mint: M2 }).decile < a.decile, 'control: a low score has a lower decile');
  assert.equal(a.model_version, VER); assert.equal(a.scored_ts, NOW - 600); assert.equal(a.entry_ts, NOW - 640); assert.equal(a.scored_seconds_after_entry, 40); assert.equal(a.scored_at_entry, true);
  assert.equal(a.liquidity_usd_at_entry, 12345.68); assert.equal(a.fdv_usd_at_entry, 45678.9); assert.equal(a.pools_scored_for_mint, 1); assert.equal(a.live_auc, null);
  assert.ok(a.method.includes(String(META.n_train)) && a.method.includes(META.trained_through_day) && /it is not a recommendation/.test(a.method) && /ranks new pools/.test(a.method));
  const late = mk(path.join(tmp(), 's2.db'), [[9, M1, P1, 'pump-fun', 0.5, 600, 600 + 7200]]);
  assert.equal(H(late).getCrashRisk({ mint: M1 }).scored_at_entry, false, 'scored two hours after entry is said so');
});

test('exactly one of mint or pool, 32 to 44 base58 characters; refused before the database is touched', () => {
  const missingFile = path.join(tmp(), 'does-not-exist.db');
  const h = H(missingFile);                                // a missing database would be a 503: a 400 proves validation came first
  for (const [args, msg] of [[{}, 'neither'], [{ mint: M1, pool: P1 }, 'both'], [{ mint: '' }, 'empty'], [{ mint: '   ' }, 'blank'], [{ mint: 'a'.repeat(31) }, '31 chars'], [{ mint: '1'.repeat(45) }, '45 chars'],
    [{ mint: M1.slice(0, 20) + '0' + M1.slice(21) }, 'a zero'], [{ mint: M1.slice(0, 20) + 'O' + M1.slice(21) }, 'a capital O'], [{ pool: M1.slice(0, 20) + 'l' + M1.slice(21) }, 'a lower l'], [{ pool: M1.slice(0, 20) + 'I' + M1.slice(21) }, 'a capital I'],
    [{ mint: [M1, M2] }, 'an array'], [{ mint: 5 }, 'a number'], [{ pool: `${P1}\n${P1}` }, 'two lines']]) rejects(() => h.getCrashRisk(args), { kind: 'bad_request' }, msg);
  // controls: the boundary lengths are accepted by validation (they reach the 503 of the missing database), a padded value is trimmed
  rejects(() => h.getCrashRisk({ mint: '1'.repeat(32) }), { status: 503 }, '32 chars passes validation');
  rejects(() => h.getCrashRisk({ pool: '1'.repeat(44) }), { status: 503 }, '44 chars passes validation');
  rejects(() => h.getCrashRisk({ mint: ` ${M1} ` }), { status: 503 }, 'trimmed');
  rejects(() => h.getCrashRisk({ mint: M1, pool: '' }), { status: 503 }, 'an empty pool beside a mint is "not given"');
  const e = rejects(() => h.getCrashRisk({}), { kind: 'bad_request' }); assert.match(e.message, /exactly one of mint or pool/);
});

test('a valid request outside what is scored is a 404 "not covered, not charged"', () => {
  const h = H(mk(path.join(tmp(), 's.db'), base()));
  const e = rejects(() => h.getCrashRisk({ mint: '3mRFwgiEZgJCDnCmbZULuX6ecQbFxCMfunXa9VafpDcJ' }), { status: 404 });
  assert.match(e.message, /not covered, not charged\.$/);
  rejects(() => h.getCrashRisk({ pool: M3 }), { status: 404 }, 'a mint given as a pool');
});

test('the 7 day edge: 6 d 23 h is in, 7 d 1 h is out (by score time and by entry time)', () => {
  const rows = [[1, M1, P1, 'pump-fun', 0.5, 6 * DAY + 23 * HOUR, 6 * DAY + 23 * HOUR + 40], [2, M2, P2, 'pump-fun', 0.5, 7 * DAY + HOUR, 7 * DAY + HOUR + 40],
    [3, M3, P3, 'pump-fun', 0.5, 600, 8 * DAY]];            // entered 8 days ago, scored just now (a backfill): the pool is older than the coverage
  const h = H(mk(path.join(tmp(), 's.db'), [...rows, [4, 'So11111111111111111111111111111111111111113', P3.slice(0, 43) + 'x', 'orca', 0.1, 60]], { tickAgo: 10 }));
  assert.equal(h.getCrashRisk({ mint: M1 }).mint, M1);
  rejects(() => h.getCrashRisk({ mint: M2 }), { status: 404 }, '7 d 1 h');
  rejects(() => h.getCrashRisk({ mint: M3 }), { status: 404 }, 'entered 8 days ago');
  const radar = h.getLaunchRadar({});
  assert.deepEqual(radar.launches.map((l) => l.mint).sort(), ['So11111111111111111111111111111111111111113', M1].sort(), 'the radar uses the same coverage');
});

test('two pools of one mint: the newest scored is returned and the count is said', () => {
  const rows = [[1, M1, P1, 'pump-fun', 0.3, 3600], [2, M1, P2, 'pumpswap', 0.9, 1200], [3, M2, P3, 'orca', 0.1, 100]];
  const h = H(mk(path.join(tmp(), 's.db'), rows));
  const a = h.getCrashRisk({ mint: M1 });
  assert.equal(a.pool, P2); assert.equal(a.score, 0.9); assert.equal(a.pools_scored_for_mint, 2);
  const b = h.getCrashRisk({ pool: P1 });
  assert.equal(b.pool, P1); assert.equal(b.score, 0.3); assert.equal(b.pools_scored_for_mint, 2, 'asked by the older pool: that pool, and the mint has two');
  assert.equal(h.getCrashRisk({ mint: M2 }).pools_scored_for_mint, 1);
});

test('stale and missing: the scorer not running, nothing scored, a score older than 30 minutes while LaunchLedger runs, a missing or unreadable file are 503s; each has a control that answers', () => {
  const ok = (over, rows = base()) => H(mk(path.join(tmp(), 's.db'), rows, over));
  // controls first
  assert.equal(ok({}).getCrashRisk({ mint: M1 }).mint, M1);
  assert.equal(ok({ tickAgo: C.TICK_STALE_SEC - 1 }).getCrashRisk({ mint: M1 }).mint, M1, 'a run 9 minutes ago is fine');
  // the scorer's last run is too old
  let e = rejects(() => ok({ tickAgo: C.TICK_STALE_SEC + 5 }).getCrashRisk({ mint: M1 }), { status: 503 }, 'last run 10 min ago'); assert.match(e.message, /Not charged\.$/);
  assert.equal(e.retryAfter, 120);
  rejects(() => ok({ tickAgo: null }).getCrashRisk({ mint: M1 }), { status: 503 }, 'no run recorded');
  // newest score older than 30 minutes while LaunchLedger completed a cycle recently
  const old = [[1, M1, P1, 'pump-fun', 0.5, C.STALE_NEWEST_SEC + 60]];
  rejects(() => ok({}, old).getCrashRisk({ mint: M1 }), { status: 503 }, '31 min old, ledger running');
  rejects(() => ok({}, old).getLaunchRadar({}), { status: 503 }, 'radar too');
  assert.equal(ok({}, [[1, M1, P1, 'pump-fun', 0.5, C.STALE_NEWEST_SEC - 60]]).getCrashRisk({ mint: M1 }).mint, M1, 'control: 29 min old is fine');
  // LaunchLedger itself not running: a pool we hold is still answered, a pool we do not hold is a 503 and not a 404
  const idle = ok({ cycleAgo: C.LEDGER_RUNNING_SEC + 120 }, old);
  assert.equal(idle.getCrashRisk({ mint: M1 }).mint, M1);
  rejects(() => idle.getCrashRisk({ mint: M2 }), { status: 503 }, 'not recorded, not "not covered"');
  rejects(() => ok({ cycleAgo: null }, old).getCrashRisk({ mint: M2 }), { status: 503 }, 'no cycle ever seen');
  // nothing scored at all
  rejects(() => ok({}, []).getCrashRisk({ mint: M1 }), { status: 503 }, 'empty');
  rejects(() => ok({}, []).getLaunchRadar({}), { status: 503 }, 'empty radar');
  // a missing file, a file that is not a database
  rejects(() => H(path.join(tmp(), 'nope.db')).getCrashRisk({ mint: M1 }), { status: 503 }, 'missing');
  const junk = path.join(tmp(), 'junk.db'); fs.writeFileSync(junk, 'this is not a sqlite database '.repeat(40));
  rejects(() => H(junk).getCrashRisk({ mint: M1 }), { status: 503 }, 'unreadable');
  rejects(() => H(junk).getLaunchRadar({}), { status: 503 }, 'unreadable radar');
});

test('the handle is reopened after an error: a handle that fails is dropped and the next call opens a new one (a faulty first handle, then a good one); a dropped table is a 503 and the call after it is back answers', () => {
  const f = mk(path.join(tmp(), 's.db'), base());
  let opened = 0;
  const h = CR.makeHandlers({ env: { LEDGER_SCORE_DB: f }, now: () => NOW * 1000, open: (file) => {
    opened++;
    const d = new Database(file, { readonly: true, fileMustExist: true });
    if (opened === 1) d.prepare = () => { throw new Error('disk I/O error'); };      // the first handle is broken for good
    return d;
  } });
  rejects(() => h.getCrashRisk({ mint: M1 }), { status: 503 }, 'the broken handle');
  assert.equal(h.getCrashRisk({ mint: M1 }).mint, M1, 'the next call opened a new handle');
  assert.equal(opened, 2);
  assert.equal(h.getCrashRisk({ mint: M2 }).mint, M2); assert.equal(opened, 2, 'and keeps it');
  h.close();
  // a table renamed away and back, on the real handle
  const h2 = H(f);
  assert.equal(h2.getCrashRisk({ mint: M1 }).mint, M1);
  const w = new Database(f); w.exec('ALTER TABLE scores RENAME TO scores_away');
  rejects(() => h2.getCrashRisk({ mint: M1 }), { status: 503 }, 'table gone');
  w.exec('ALTER TABLE scores_away RENAME TO scores'); w.close();
  assert.equal(h2.getCrashRisk({ mint: M1 }).mint, M1);
  h2.close();
});

test('the live weekly AUC: the latest week with a number, its week and n; NULL weeks and other models are skipped; the partial flag follows the clock', () => {
  const wk = (daysAgo) => new Date((NOW - daysAgo * DAY) * 1000).toISOString().slice(0, 10);
  const f = mk(path.join(tmp(), 's.db'), base(), { aucs: [
    { week: wk(2), n: 120, positives: 15, auc: null },                               // newest week, under the floor
    { week: wk(9), n: 640, positives: 80, auc: 0.9123456789 },                        // the answer
    { week: wk(16), n: 700, positives: 90, auc: 0.5 },
    { week: wk(1), version: 'hgb-t3-20260101-deadbeef', n: 900, positives: 100, auc: 0.99 }] });
  const a = H(f).getCrashRisk({ mint: M1 }).live_auc;
  assert.deepEqual([a.week, a.n, a.positives, a.auc, a.model_version], [wk(9), 640, 80, 0.912346, VER]);
  assert.equal(a.partial_week, false);
  const f2 = mk(path.join(tmp(), 's2.db'), base(), { aucs: [{ week: wk(3), n: 300, positives: 40, auc: 0.8 }] });
  assert.equal(H(f2).getCrashRisk({ mint: M1 }).live_auc.partial_week, true);
  assert.equal(H(mk(path.join(tmp(), 's3.db'), base(), { aucs: [{ week: wk(3), n: 100, positives: 10, auc: null }] })).getCrashRisk({ mint: M1 }).live_auc, null, 'only NULL weeks: null, never a number');
});

test('decile basis: the live boundaries once there are enough live scores, the frozen ones before; the same score moves decile between the two', () => {
  const live = { cuts: META.decile_cuts.map((c) => c * 0.01), n: C.LIVE_CUTS_MIN, computed_ts: NOW - 3600, window_days: 14 };      // much lower boundaries: a middling score is decile 10
  const f = mk(path.join(tmp(), 's.db'), base(), { extraMeta: { [`live:${VER}`]: live, live_cuts_min: String(C.LIVE_CUTS_MIN) } });
  const a = H(f).getCrashRisk({ mint: M3 });
  assert.equal(a.decile_basis, 'live-14d'); assert.equal(a.decile, decileOf(0.05, live.cuts));
  const frozen = H(mk(path.join(tmp(), 's2.db'), base(), { extraMeta: { [`live:${VER}`]: { ...live, n: C.LIVE_CUTS_MIN - 1 } } })).getCrashRisk({ mint: M3 });
  assert.equal(frozen.decile_basis, 'frozen'); assert.equal(frozen.decile, decileOf(0.05, META.decile_cuts));
  assert.notEqual(a.decile, frozen.decile, 'control: the two sets of boundaries give this score different deciles');
  const noCuts = H(mk(path.join(tmp(), 's3.db'), base(), { version: 'hgb-t3-20260101-deadbeef' }));      // a model version the meta table has frozen cuts for: it does
  assert.equal(noCuts.getCrashRisk({ mint: M3 }).decile_basis, 'frozen');
  const bare = mk(path.join(tmp(), 's4.db'), base()); const w = new Database(bare); w.prepare("DELETE FROM meta WHERE k LIKE 'frozen:%'").run(); w.close();
  const nb = H(bare).getCrashRisk({ mint: M3 });
  assert.equal(nb.decile, null); assert.equal(nb.decile_basis, null);
});

test('get_launch_radar: default 25, max 100, an out-of-range limit is a 400 (never clamped), newest scored first, fields from the score database only', () => {
  const rows = Array.from({ length: 130 }, (_, i) => [i + 1, `mint${String(i).padStart(3, '0')}${'1'.repeat(30)}`, `pool${String(i).padStart(3, '0')}${'1'.repeat(30)}`, i % 2 ? 'pump-fun' : 'orca', (i % 100) / 100, 60 + i * 30]);
  const h = H(mk(path.join(tmp(), 's.db'), rows, { tickAgo: 5 }));
  const d = h.getLaunchRadar({});
  assert.equal(d.count, C.RADAR_DEFAULT); assert.equal(d.limit, 25); assert.equal(d.launches.length, 25);
  assert.deepEqual(d.launches.map((l) => l.scored_ts), [...d.launches.map((l) => l.scored_ts)].sort((a, b) => b - a), 'newest scored first');
  assert.equal(d.launches[0].mint, rows[0][1]);
  assert.deepEqual(Object.keys(d.launches[0]), ['mint', 'pool', 'dex', 'score', 'decile', 'scored_ts', 'entry_ts', 'liquidity_usd_at_entry', 'fdv_usd_at_entry']);
  assert.equal(d.launches[0].liquidity_usd_at_entry, 12345.68);
  assert.equal(d.model_version, VER); assert.equal(d.decile_basis, 'frozen'); assert.equal(d.meaning, C.MEANING);
  assert.equal(h.getLaunchRadar({ limit: '100' }).count, 100); assert.equal(h.getLaunchRadar({ limit: 100 }).count, 100);
  assert.equal(h.getLaunchRadar({ limit: '1' }).count, 1); assert.equal(h.getLaunchRadar({ limit: '7' }).count, 7);
  assert.equal(h.getLaunchRadar({ limit: '' }).count, 25, 'an empty limit is "not given"');
  for (const bad of ['0', '101', '-1', '2.5', 'abc', '1e3', ['5', '6'], '100.0001', 101, 0, NaN]) rejects(() => h.getLaunchRadar({ limit: bad }), { kind: 'bad_request' }, `limit ${JSON.stringify(bad)}`);
  assert.equal(h.getLaunchRadar({ limit: '1e1' }).count, 10, 'Number() reads 1e1 as 10, the way the query guard would');
  const e = rejects(() => h.getLaunchRadar({ limit: '101' }), { kind: 'bad_request' }); assert.match(e.message, /integer from 1 to 100/);
  // a score of a second model version carries its own version and basis
  const f = mk(path.join(tmp(), 's2.db'), rows.slice(0, 3), { tickAgo: 5 }); const w = new Database(f);
  w.prepare("UPDATE scores SET model_version = 'hgb-t3-20260101-deadbeef' WHERE pool_id = 3").run(); w.close();
  const mixed = H(f).getLaunchRadar({});
  assert.equal(mixed.launches[0].model_version, undefined); assert.equal(mixed.launches[2].model_version, 'hgb-t3-20260101-deadbeef'); assert.equal(mixed.launches[2].decile, null); assert.equal(mixed.launches[2].decile_basis, null);
});

test('get_crash_risk_record: free, never throws on a missing database, says there is no record, and invents no number', () => {
  const none = H(path.join(tmp(), 'nope.db')).getCrashRiskRecord();
  assert.deepEqual(none.weeks, []); assert.match(none.message, /No week has a live record yet/);
  assert.equal(none.current_model_version, META.model_version); assert.equal(none.models[0].model_version, META.model_version);
  assert.equal(none.backtest.measured_on_the_live_model, false);
  assert.ok(!JSON.stringify(none).includes('"auc"'), 'no live "auc" key at all without data (the backtest block is named roc_auc and labelled)');
  const junk = path.join(tmp(), 'junk.db'); fs.writeFileSync(junk, 'x'.repeat(5000));
  assert.deepEqual(H(junk).getCrashRiskRecord().weeks, [], 'an unreadable database is an empty record, not an error');
  const wk = (n) => new Date((NOW - n * DAY) * 1000).toISOString().slice(0, 10);
  const dec = { basis: 'frozen', rows: Array.from({ length: 10 }, (_, i) => ({ decile: i + 1, n: 20, positives: i })) };
  const f = mk(path.join(tmp(), 's.db'), base(), { aucs: [{ week: wk(10), n: 200, positives: 24, auc: 0.9, deciles: dec }, { week: wk(3), n: 150, positives: 10, auc: null, deciles: dec }] });
  const r = H(f).getCrashRiskRecord();
  assert.equal(r.weeks.length, 2); assert.equal(r.weeks[0].week > r.weeks[1].week, true, 'newest first');
  assert.equal(r.weeks[0].auc, null); assert.equal(r.weeks[0].resolved_pools, 150); assert.equal(r.weeks[0].partial_week, true);
  assert.equal(r.weeks[1].auc, 0.9); assert.equal(r.weeks[1].base_rate, 0.12); assert.equal(r.weeks[1].decile_basis, 'frozen');
  assert.deepEqual(r.weeks[1].deciles[9], { decile: 10, resolved_pools: 20, positives: 9, hit_rate: 0.45 });
  assert.equal(r.message, undefined);
  assert.equal(r.backtest.roc_auc[0].window, 'all test weeks'); assert.ok(r.backtest.roc_auc[0].roc_auc > 0.9 && r.backtest.decile_hit_rates.length === 10);
  assert.equal(r.backtest.decile_hit_rates[9].hit_rate, Math.round(META.validation.decile_table[9].rate * 1e6) / 1e6, 'the backtest numbers are the model file\'s, not typed');
});

// ---- the text a customer reads
const BANNED = /\brug|guarantee|\bavoid|\bbuy|\bsell|\bhold\b|\bsafe|scam|advice|\bsince\b|recommend(?!ation)/i;
function strings(x, out = []) { if (typeof x === 'string') out.push(x); else if (x && typeof x === 'object') for (const v of Object.values(x)) strings(v, out); return out; }

test('wording: no advice, no "rug", no guarantee, no start date, in descriptions, titles, questions, examples, method texts, the record and every refusal message', () => {
  const texts = [];
  for (const e of CR.entries) texts.push(e.desc, e.title, e.question, ...Object.values(e.schema).map((s) => s.description || ''), ...strings(e.example));
  const f = mk(path.join(tmp(), 's.db'), base());
  const h = H(f);
  texts.push(...strings(h.getCrashRisk({ mint: M1 })), ...strings(h.getLaunchRadar({})), ...strings(h.getCrashRiskRecord()));
  for (const fn of [() => h.getCrashRisk({}), () => h.getCrashRisk({ mint: 'x' }), () => h.getCrashRisk({ mint: P3.slice(0, 40) + 'zzzz' }), () => h.getLaunchRadar({ limit: '0' }), () => H(path.join(tmp(), 'no.db')).getLaunchRadar({}),
    () => H(mk(path.join(tmp(), 'old.db'), base(), { tickAgo: 9999 })).getCrashRisk({ mint: M1 }), () => H(mk(path.join(tmp(), 'old2.db'), [[1, M1, P1, 'x', 0.1, 4000]], {})).getLaunchRadar({})]) {
    try { fn(); assert.fail('expected a refusal'); } catch (e) { if (e.name === 'AssertionError') throw e; texts.push(e.message); }
  }
  texts.push(CR.methodText(META), CR.methodText(null));
  assert.ok(texts.length > 40);
  const hits = texts.filter((t) => BANNED.test(t));
  assert.deepEqual(hits, []);
  // control: the pattern does match what it must catch
  for (const bad of ['a rug pull', 'RUGGED', 'guaranteed', 'avoid this', 'buy now', 'sell it', 'it is safe', 'a scam', 'financial advice', 'since July', 'we recommend this']) assert.ok(BANNED.test(bad), bad);
  // no start date anywhere a customer reads: the only dates are an END of the training window and the Monday of a week
  const dates = texts.flatMap((t) => t.match(/\b20\d\d-\d\d-\d\d\b/g) || []);
  assert.ok(dates.length >= 2 && dates.every((d) => d === META.trained_through_day || d === META.validation.trained_through_day), `dates found: ${dates.join(', ')}`);
  assert.ok(!/first_day|start/i.test(JSON.stringify(CR.entries.map((e) => e.example))), 'no start date field in the examples');
  assert.ok(!/\bmedian\b|\bprofit\b/i.test(texts.join(' ')), 'no claim about returns');
});

// ---- the scorer's database and the routes agree (integration)
test('integration: the scores.db the real scorer writes (fixture pools, the production model) is read correctly by the routes, and the answer equals the Python score', () => {
  const d = tmp(); const NOWS = Math.max(...FIXTURE.rows.map((r) => r.t0_ts)) + 120;
  makeLedger(path.join(d, 'll.db'), { pools: FIXTURE.rows, meta: { last_cycle: NOWS - 30 } });
  const s = createScorer({ cfg: { ledgerDb: path.join(d, 'll.db'), scoreDb: path.join(d, 'scores.db'), backfillDays: 1000 }, clock: () => NOWS });
  s.tick(); s.close();
  const h = CR.makeHandlers({ env: { LEDGER_SCORE_DB: path.join(d, 'scores.db') }, now: () => NOWS * 1000 });
  // the routes only cover the last 7 days: pick the pools that entered within 7 days of the newest, ask for each by mint and by pool
  const recent = FIXTURE.rows.map((r, i) => ({ r, py: FIXTURE.py[i] })).filter(({ r }) => r.t0_ts >= NOWS - 6 * DAY);
  assert.ok(recent.length >= 1, 'the fixture has pools from the last days');
  for (const { r, py } of recent) {
    const a = h.getCrashRisk({ pool: r.pool_address });
    assert.equal(a.pool, r.pool_address); assert.equal(h.getCrashRisk({ mint: r.base_mint }).mint, r.base_mint);
    assert.ok(Math.abs(a.score - py) < 5e-7 + 1e-9, `${a.score} vs ${py}`);
    assert.equal(a.model_version, s.model.model_version); assert.equal(a.decile, decileOf(py, s.model.decile_cuts)); assert.equal(a.decile_basis, 'frozen');
  }
  const older = FIXTURE.rows.find((r) => r.t0_ts < NOWS - 8 * DAY);
  rejects(() => h.getCrashRisk({ mint: older.base_mint }), { status: 404 }, 'a pool scored from a backfill that entered over 7 days before');
  assert.ok(h.getLaunchRadar({ limit: '50' }).count >= 1);
  assert.equal(h.getCrashRiskRecord().models[0].model_version, s.model.model_version);
  h.close();
});

// ---- the switch
test('enabled(): on only for the string "on" in R23_CRASH_ROUTES, read at call time, default off', () => {
  const was = process.env.R23_CRASH_ROUTES;
  try {
    delete process.env.R23_CRASH_ROUTES; assert.equal(CR.enabled(), false, 'unset');
    for (const v of ['', 'off', '0', 'false', '1', 'true', 'yes', ' on', 'on ', 'onn', 'o n']) { process.env.R23_CRASH_ROUTES = v; assert.equal(CR.enabled(), false, JSON.stringify(v)); }
    for (const v of ['on', 'ON', 'On']) { process.env.R23_CRASH_ROUTES = v; assert.equal(CR.enabled(), true, v); }
    process.env.R23_CRASH_ROUTES = 'off'; assert.equal(CR.enabled(), false, 'toggled back at call time');
  } finally { if (was === undefined) delete process.env.R23_CRASH_ROUTES; else process.env.R23_CRASH_ROUTES = was; }
});

test('the registration the notes give for expansion.js: with the flag off the entries are in no table; with it on they are added; the free route stays out of PRICES', () => {
  // the snippet of the notes, as a function over expansion.js's own structures
  const wire = (EXP, PRICES_ADD) => {
    if (CR.enabled()) { for (const t of CR.entries) { EXP.push(t); if (!t.free) PRICES_ADD[t.route] = { usd: t.usd, tool: t.name, desc: t.desc }; } }
    return { EXP, PRICES_ADD };
  };
  const was = process.env.R23_CRASH_ROUTES;
  try {
    delete process.env.R23_CRASH_ROUTES;
    let { EXP, PRICES_ADD } = wire([{ name: 'existing', route: 'GET /api/x' }], {});
    assert.deepEqual(EXP.map((e) => e.name), ['existing']); assert.deepEqual(PRICES_ADD, {});
    assert.ok(!JSON.stringify([EXP, PRICES_ADD]).includes('crash-risk') && !JSON.stringify([EXP, PRICES_ADD]).includes('launch-radar'));
    process.env.R23_CRASH_ROUTES = 'on';
    ({ EXP, PRICES_ADD } = wire([{ name: 'existing', route: 'GET /api/x' }], {}));
    assert.deepEqual(EXP.map((e) => e.name), ['existing', 'get_crash_risk', 'get_launch_radar', 'get_crash_risk_record']);
    assert.deepEqual(Object.keys(PRICES_ADD), ['GET /api/crash-risk', 'GET /api/launch-radar'], 'the free route is not priced');
  } finally { if (was === undefined) delete process.env.R23_CRASH_ROUTES; else process.env.R23_CRASH_ROUTES = was; }
});

test('the integrated gating: tools/r23/index.js (the one list expansion.js reads) holds the crash-risk entries only while R23_CRASH_ROUTES=on, in a fresh process each way', { skip: !fs.existsSync(path.join(__dirname, '..', 'tools', 'r23', 'index.js')) && 'tools/r23/index.js is not in this tree' }, () => {
  const { execFileSync } = require('child_process');
  const names = (flag) => JSON.parse(execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./tools/r23').entries.map((e) => e.name)))"], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, R23_CRASH_ROUTES: flag } }));
  const CRASH = ['get_crash_risk', 'get_launch_radar', 'get_crash_risk_record'];
  for (const off of ['', 'off', '0', 'true']) assert.deepEqual(names(off).filter((n) => CRASH.includes(n)), [], `flag ${JSON.stringify(off)}`);
  assert.deepEqual(names('on').filter((n) => CRASH.includes(n)), CRASH, 'control: with the flag on all three are in the list');
});

test('the entries run through their own run() functions as the wrapper calls them: plain objects, and the refusals carry the status the wrapper maps', async () => {
  const f = mk(path.join(tmp(), 's.db'), base());
  const was = process.env.LEDGER_SCORE_DB; process.env.LEDGER_SCORE_DB = f;
  const realNow = Date.now; Date.now = () => NOW * 1000;
  try {
    const [crash, radar, rec] = CR.entries;
    const a = await crash.run({ mint: M1 }); assert.equal(a.mint, M1); assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
    assert.equal((await radar.run({ limit: '2' })).count, 2);
    assert.equal((await rec.run({})).meaning, C.MEANING);
    await assert.rejects(() => crash.run({}), (e) => e.kind === 'bad_request');
    await assert.rejects(() => crash.run({ mint: '3mRFwgiEZgJCDnCmbZULuX6ecQbFxCMfunXa9VafpDcJ' }), (e) => e.status === 404);
  } finally { Date.now = realNow; if (was === undefined) delete process.env.LEDGER_SCORE_DB; else process.env.LEDGER_SCORE_DB = was; }
});

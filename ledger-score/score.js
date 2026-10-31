#!/usr/bin/env node
// ledger-score/score.js: the crash-risk scorer (R23 T1). A plain Node process; the one dependency is better-sqlite3.
//
// Every 60 seconds it scores each LaunchLedger cohort pool that has no score yet, from the pool's frozen t0 columns only, and writes the score to ITS OWN database.
// Once a day it measures its own stored scores against the outcomes that arrived after it scored them (weekly ROC AUC and decile hit rates), and refreshes the
// decile boundaries from its own live scores once there are enough.
//
//   reads   LEDGER_DB        (default /opt/launchledger/launchledger.db)   opened { readonly: true, fileMustExist: true } with PRAGMA query_only = ON; never written
//   writes  LEDGER_SCORE_DB  (default /opt/launchledger-score/scores.db)   tables scores, auc_weekly, meta, skipped (tools/r23/crash-model/schema.js)
//
// The columns it reads from `pools` are named (tools/r23/crash-model/features.js INPUT_COLUMNS), so extra columns and tables in the live database change nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// the model code sits in ./crash-model when this directory is deployed on its own, and in ../tools/r23/crash-model inside the AgentFeed repo
const MODEL_DIR = process.env.CRASH_MODEL_DIR || [path.join(__dirname, 'crash-model'), path.join(__dirname, '..', 'tools', 'r23', 'crash-model')].find((d) => fs.existsSync(path.join(d, 'evaluator.js')));
if (!MODEL_DIR) throw new Error('ledger-score: the crash-model directory (evaluator.js, features.js, metrics.js, schema.js, model.json) was not found; set CRASH_MODEL_DIR');
const { loadModel, score: modelScore } = require(path.join(MODEL_DIR, 'evaluator.js'));
const { makeFeatureBuilder, INPUT_COLUMNS } = require(path.join(MODEL_DIR, 'features.js'));
const { rocAuc, decileOf, decileCuts } = require(path.join(MODEL_DIR, 'metrics.js'));
const { ensureSchema } = require(path.join(MODEL_DIR, 'schema.js'));
const C = require(path.join(MODEL_DIR, 'constants.js'));

const DAY = 86400;
const HARD_BATCH = C.BATCH_MAX;                           // the most pools one tick may score
const FALL = -(C.FALL_PCT / 100);                         // the outcome: price at the 24 hour check / entry price - 1 <= -0.8
const nowSec = () => Math.floor(Date.now() / 1000);
const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : d; };

function loadConfig(env = process.env) {
  return {
    ledgerDb: env.LEDGER_DB || '/opt/launchledger/launchledger.db',
    scoreDb: env.LEDGER_SCORE_DB || '/opt/launchledger-score/scores.db',
    modelFile: env.CRASH_MODEL_FILE || path.join(MODEL_DIR, 'model.json'),
    intervalMs: num(env.SCORE_INTERVAL_MS, 60000),        // between ticks when nothing is waiting
    catchUpMs: num(env.SCORE_CATCHUP_MS, 1000),           // between ticks while a full batch says more are waiting
    batch: Math.min(Math.max(1, Math.floor(num(env.SCORE_BATCH, HARD_BATCH))), HARD_BATCH),
    backfillDays: num(env.SCORE_BACKFILL_DAYS, C.COVER_DAYS),       // pools that entered longer ago than this are never scored
    entryLagSec: num(env.SCORE_ENTRY_LAG_SEC, C.ENTRY_LAG_SEC), // a pool counts as "scored at entry" when scored within this many seconds of its t0_ts
    minResolved: num(env.SCORE_AUC_MIN_RESOLVED, C.MIN_RESOLVED), // weeks with fewer resolved pools get auc NULL
    aucWeeks: num(env.SCORE_AUC_WEEKS, 8),                // how many weeks back the daily job recomputes
    liveCutsMin: num(env.SCORE_LIVE_CUTS_MIN, C.LIVE_CUTS_MIN),
    liveCutsDays: num(env.SCORE_LIVE_CUTS_DAYS, C.LIVE_CUTS_DAYS),
  };
}

/** the Monday (UTC) of the ISO week a unix time falls in, YYYY-MM-DD */
function weekStartOf(ts) {
  const d = Math.floor(ts / DAY);
  return new Date((d - ((d + 3) % 7)) * DAY * 1000).toISOString().slice(0, 10);   // 1970-01-01 was a Thursday
}
const dayEnd = (day) => Date.parse(`${day}T00:00:00Z`) / 1000 + DAY;               // unix time of the end of a YYYY-MM-DD day (UTC)

/** the launchledger handle: read-only at the file level AND query_only, so even a bug cannot write */
function openLedger(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
function openScores(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  ensureSchema(db);
  return db;
}

/**
 * @param {object} o
 * @param {object} [o.cfg]        loadConfig() result, or overrides of it
 * @param {() => number} [o.clock]  unix seconds
 * @param {(line: object) => void} [o.log]
 * @param {object} [o.hooks]      tests only: { beforeCommit(batchIndex, rows) } runs inside the batch transaction
 */
function createScorer({ cfg: over = {}, clock = nowSec, log = () => {}, hooks = {} } = {}) {
  const cfg = { ...loadConfig(), ...over };
  cfg.batch = Math.min(Math.max(1, Math.floor(Number(cfg.batch) || HARD_BATCH)), HARD_BATCH);   // the cap holds whatever the caller passes
  const model = loadModel(cfg.modelFile);
  const build = makeFeatureBuilder(model.feature_names, model.categories, model.tables);
  const sc = openScores(cfg.scoreDb);
  let ll = null, q = null, batches = 0;

  const getMeta = sc.prepare('SELECT v FROM meta WHERE k = ?');
  const putMeta = sc.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  const meta = (k) => { const r = getMeta.get(k); return r ? r.v : null; };
  const metaJson = (k) => { try { const v = meta(k); return v ? JSON.parse(v) : null; } catch { return null; } };
  const setMeta = (k, v) => putMeta.run(k, typeof v === 'string' ? v : JSON.stringify(v));
  const bump = (k, by) => setMeta(k, String(Number(meta(k) || 0) + by));

  // ---- the model identity, written at every start: routes read it from here, they never load the model
  {
    const { compiled, trees_count, ...info } = model;
    const { feature_names, categories, tables, required_columns, ...pub } = info;
    sc.transaction(() => {
      setMeta('current_model', model.model_version);
      setMeta(`model:${model.model_version}`, { ...pub, n_trees: trees_count });
      setMeta(`frozen:${model.model_version}`, { cuts: model.decile_cuts, source: model.decile_cuts_source });
      if (!meta('started_ts')) setMeta('started_ts', String(clock()));
      setMeta('last_start_ts', String(clock())); setMeta('entry_lag_sec', String(cfg.entryLagSec)); setMeta('cover_days', String(cfg.backfillDays)); setMeta('live_cuts_min', String(cfg.liveCutsMin));
    })();
  }

  const insScore = sc.prepare('INSERT OR IGNORE INTO scores (pool_id, mint, pool, dex, score, model_version, scored_ts, t0_ts, t0_liquidity_usd, t0_fdv_usd) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insSkip = sc.prepare('INSERT OR IGNORE INTO skipped (pool_id, reason, ts) VALUES (?,?,?)');
  const isDone = sc.prepare('SELECT 1 AS x FROM scores WHERE pool_id = ? UNION ALL SELECT 1 FROM skipped WHERE pool_id = ?');

  /** open (or reopen) the launchledger handle and prepare what the ticks need */
  function ledger() {
    if (ll) return ll;
    const db = openLedger(cfg.ledgerDb);
    try {
      const have = new Set(db.prepare('PRAGMA table_info(pools)').all().map((r) => r.name));
      const missing = [...INPUT_COLUMNS, 'cohort'].filter((c) => !have.has(c));
      if (missing.length) throw new Error(`launchledger.db pools lacks the column(s) ${missing.join(', ')}`);
      // `retired IN (0, 1)` is what lets SQLite use the index (cohort, retired, t0_ts): without it the planner scans every cohort pool (measured on the 2026-10-31 snapshot: 3.2 s against 0.09 s for the same 7 days)
      const cols = INPUT_COLUMNS.join(', ');
      q = {
        head: db.prepare(`SELECT ${cols} FROM pools WHERE cohort = 1 AND retired IN (0, 1) AND t0_ts >= ? ORDER BY t0_ts DESC, id DESC`),
        back: db.prepare(`SELECT ${cols} FROM pools WHERE cohort = 1 AND retired IN (0, 1) AND t0_ts >= ? AND (t0_ts < ? OR (t0_ts = ? AND id < ?)) ORDER BY t0_ts DESC, id DESC LIMIT ?`),
        cycle: db.prepare(`SELECT v FROM meta WHERE k = 'last_cycle'`),
        outcome: db.prepare('SELECT l.evidence AS evidence, p.t0_price_usd AS t0_price FROM labels l JOIN pools p ON p.id = l.pool_id WHERE l.pool_id = ? AND l.horizon_days = 1'),
        check: db.prepare('SELECT price_usd FROM checks WHERE pool_id = ? AND ts = ?'),
      };
    } catch (e) { db.close(); throw e; }
    ll = db;
    return ll;
  }
  const dropLedger = () => { if (ll) { try { ll.close(); } catch { /* already closed */ } } ll = null; q = null; };

  const missingColumn = (row) => {
    for (const c of model.required_columns || []) if (row[c] === null || row[c] === undefined) return c;
    return Number(row.t0_price_usd) > 0 && Number.isFinite(Number(row.t0_price_usd)) ? null : 't0_price_usd';
  };

  /**
   * One batch: at most `cfg.batch` unscored cohort pools, newest entry first, one transaction. -> { scored, skipped, full, lagMax, scanned }
   * Two passes. HEAD: the pools of the last SCAN_SLACK_SEC (6 hours, about 650 rows), always: a pool is written minutes after its t0_ts, so new pools are found here whatever else is going on.
   * BACK: the older part of the window, from a saved position (the cursor) downwards, only while there is a backlog. A scan that reaches the floor of the window has seen everything:
   * the cursor becomes null and idle ticks read the head only. A gap of more than half the slack since the last tick (the process was down) or a different window starts again from the top,
   * so a pool that entered during downtime is found. A pool written more than the slack AFTER its t0_ts, while no catch-up is running, is not found: README, known limits.
   */
  function tickOnce() {
    const now = clock(), began = Date.now();
    ledger();
    const floor = now - cfg.backfillDays * DAY, headFrom = Math.max(floor, now - C.SCAN_SLACK_SEC);
    const TOP = { t0: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER };
    let st = metaJson('scan');
    if (!st || st.days !== cfg.backfillDays || !Number.isFinite(st.at) || now - st.at > C.SCAN_SLACK_SEC / 2 || now < st.at) st = { days: cfg.backfillDays, cursor: TOP, at: now };
    const todo = [];
    let scanned = 0, cursor = st.cursor, headFull = false;
    for (const row of q.head.iterate(headFrom)) {
      scanned++;
      if (isDone.get(row.id, row.id)) continue;
      todo.push(row);
      if (todo.length >= cfg.batch) { headFull = true; break; }
    }
    if (!headFull && cursor !== null) {
      const ub = cursor.t0 >= headFrom ? { t0: headFrom, id: -1 } : cursor;       // never re-read the head
      // LIMIT: with ORDER BY it lets SQLite keep only that many rows instead of sorting the whole window on every tick (memory and time); a tick that reaches it has not seen the end
      const limit = cfg.batch * 4;
      let broke = false, last = null, examined = 0;
      for (const row of q.back.iterate(floor, ub.t0, ub.t0, ub.id, limit)) {
        scanned++; examined++; last = { t0: row.t0_ts, id: row.id };
        if (isDone.get(row.id, row.id)) continue;
        todo.push(row);
        if (todo.length >= cfg.batch) { broke = true; break; }
      }
      cursor = broke || examined >= limit ? last : null;                         // null: the backlog is drained
    }
    const outRows = [], skips = [];
    for (const row of todo) {
      const miss = missingColumn(row);
      if (miss) { skips.push([row.id, `missing ${miss}`]); continue; }
      const s = modelScore(model, build(row));
      if (!Number.isFinite(s)) { skips.push([row.id, 'non-finite score']); continue; }
      outRows.push([row.id, row.base_mint, row.pool_address, row.dex, s, model.model_version, now, row.t0_ts, row.t0_liquidity_usd ?? null, row.t0_fdv_usd ?? null]);
    }
    const cyc = q.cycle.get();
    let scored = 0, skipped = 0, lagMax = 0;
    const batchIndex = batches++;
    sc.transaction(() => {
      for (const r of outRows) { scored += insScore.run(...r).changes; lagMax = Math.max(lagMax, now - r[7]); }
      for (const [id, reason] of skips) skipped += insSkip.run(id, reason, now).changes;
      if (hooks.beforeCommit) hooks.beforeCommit(batchIndex, outRows);
      bump('scored_total', scored); bump('skipped_total', skipped);
      setMeta('scan', { days: cfg.backfillDays, cursor, at: now });
      setMeta('last_tick_ts', String(now)); setMeta('last_tick_scored', String(scored)); setMeta('last_tick_skipped', String(skipped)); setMeta('last_tick_lag_max_s', String(lagMax));
      if (cyc && cyc.v !== undefined) { setMeta('ledger_last_cycle', String(cyc.v)); setMeta('ledger_seen_ts', String(now)); }
    })();
    const full = todo.length >= cfg.batch || cursor !== null;                  // a backlog is draining: come back at once
    if (scored || skipped) log({ ev: 'tick', scored, skipped, lag_max_s: lagMax, full, scanned, ms: Date.now() - began });
    return { scored, skipped, full, lagMax, scanned };
  }

  // any failure closes the launchledger handle, so the next tick opens it again (a migration, a restore or a replaced file does not wedge the process)
  const guarded = (fn) => (...a) => { try { return fn(...a); } catch (e) { dropLedger(); throw e; } };
  const tick = guarded(tickOnce);

  const cutsFor = (ver) => {
    const live = metaJson(`live:${ver}`);
    if (live && Array.isArray(live.cuts) && live.n >= cfg.liveCutsMin) return { cuts: live.cuts, basis: 'live-14d' };
    const fz = metaJson(`frozen:${ver}`);
    return fz && Array.isArray(fz.cuts) ? { cuts: fz.cuts, basis: 'frozen' } : null;
  };
  /** unix time from which pools are certainly out of sample for a model version (its training days end before this); null when the version's identity is unknown */
  const outOfSampleFrom = (ver) => { const m = metaJson(`model:${ver}`); return m && m.trained_through_day ? dayEnd(m.trained_through_day) : null; };

  /** the live decile boundaries: scores of pools scored at entry, after the model's training window, in the last 14 days; written once there are enough */
  function liveCuts(now) {
    const out = [];
    for (const { v: ver } of sc.prepare('SELECT DISTINCT model_version AS v FROM scores WHERE scored_ts >= ?').all(now - cfg.liveCutsDays * DAY)) {
      const from = outOfSampleFrom(ver);
      if (from === null) continue;
      const scores = sc.prepare('SELECT score FROM scores WHERE model_version = ? AND scored_ts >= ? AND t0_ts >= ? AND scored_ts - t0_ts <= ?').pluck().all(ver, now - cfg.liveCutsDays * DAY, from, cfg.entryLagSec);
      const cuts = scores.length >= cfg.liveCutsMin ? decileCuts(scores) : null;
      if (cuts) { setMeta(`live:${ver}`, { cuts, n: scores.length, computed_ts: now, window_days: cfg.liveCutsDays }); out.push({ ver, n: scores.length }); }
      else sc.prepare('DELETE FROM meta WHERE k = ?').run(`live:${ver}`);
    }
    return out;
  }

  /**
   * The daily job: per ISO week of t0_ts and per model version, the AUC and decile hit rates of the stored scores against the outcome found the way 0b_score.py found it:
   * the labels row of horizon 1 -> evidence.at_ts -> the checks row at that ts -> its price against t0_price_usd. A pool counts only if it was scored at entry
   * (within entryLagSec of t0_ts), entered after its model's training window, and its outcome check came AFTER it was scored. Under minResolved resolved pools, or with
   * no positive or no negative among them, auc is NULL. -> the rows written.
   */
  function weekly(now) {
    const lower = now - cfg.aucWeeks * 7 * DAY;
    const write = sc.prepare('INSERT INTO auc_weekly (week_start, model_version, n, positives, auc, deciles, computed_ts) VALUES (?,?,?,?,?,?,?) ON CONFLICT(week_start, model_version) DO UPDATE SET n = excluded.n, positives = excluded.positives, auc = excluded.auc, deciles = excluded.deciles, computed_ts = excluded.computed_ts');
    const written = [];
    ledger();
    for (const { v: ver } of sc.prepare('SELECT DISTINCT model_version AS v FROM scores WHERE t0_ts >= ?').all(lower)) {
      const from = outOfSampleFrom(ver);
      if (from === null) continue;                                      // cannot show these pools are out of sample: no claim
      const dec = cutsFor(ver);
      const weeks = new Set(sc.prepare('SELECT t0_ts FROM scores WHERE model_version = ? AND t0_ts >= ? AND t0_ts >= ? AND scored_ts - t0_ts <= ?').pluck().all(ver, lower, from, cfg.entryLagSec).map(weekStartOf));
      for (const wk of [...weeks].sort()) {
        const a = Date.parse(`${wk}T00:00:00Z`) / 1000, b = a + 7 * DAY;
        const rows = sc.prepare('SELECT pool_id, score, scored_ts FROM scores WHERE model_version = ? AND t0_ts >= ? AND t0_ts < ? AND t0_ts >= ? AND scored_ts - t0_ts <= ?').raw().all(ver, a, b, from, cfg.entryLagSec);
        const s = [], y = [];
        for (const [id, score, scoredTs] of rows) {
          const o = q.outcome.get(id);
          if (!o) continue;
          let atTs; try { atTs = Number(JSON.parse(o.evidence).at_ts); } catch { continue; }
          if (!Number.isFinite(atTs) || !(atTs > scoredTs)) continue;   // no 24 hour check, or the outcome already existed when the pool was scored
          const c = q.check.get(id, atTs);
          if (!c || c.price_usd === null || c.price_usd === undefined || !(Number(o.t0_price) > 0)) continue;
          s.push(score); y.push(c.price_usd / o.t0_price - 1 <= FALL ? 1 : 0);
        }
        const positives = y.reduce((p, v) => p + v, 0);
        const auc = s.length >= cfg.minResolved && positives > 0 && positives < s.length ? rocAuc(s, y) : null;
        const rowsD = Array.from({ length: 10 }, (_, i) => ({ decile: i + 1, n: 0, positives: 0 }));
        if (dec) s.forEach((v, i) => { const r = rowsD[decileOf(v, dec.cuts) - 1]; r.n++; r.positives += y[i]; });
        write.run(wk, ver, s.length, positives, auc, JSON.stringify({ basis: dec ? dec.basis : null, rows: dec ? rowsD : [] }), now);
        written.push({ week_start: wk, model_version: ver, n: s.length, positives, auc });
      }
    }
    return written;
  }

  /** the once-a-day work; runs when more than 24 hours passed since it last ran (and at the first call after a start) */
  const daily = guarded((now = clock(), force = false) => {
    if (!force && now - Number(meta('daily_ts') || 0) < DAY) return null;
    const live = liveCuts(now);                                         // first, so the weekly deciles use the boundaries of today
    const weeks = weekly(now);
    setMeta('daily_ts', String(now));
    log({ ev: 'daily', weeks: weeks.length, live_cuts: live });
    return { weeks, live };
  });

  function close() { dropLedger(); try { sc.close(); } catch { /* already closed */ } }
  return { tick, daily, weekly, liveCuts, close, cfg, model, sc, get ll() { return ll; }, meta, setMeta };
}

/** the process: tick, then schedule the next one; a failed tick is logged, recorded in meta and retried (the launchledger handle is reopened) */
function main() {
  const out = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
  const scorer = createScorer({ log: out });
  out({ ev: 'start', model_version: scorer.model.model_version, ledger_db: scorer.cfg.ledgerDb, score_db: scorer.cfg.scoreDb, batch: scorer.cfg.batch, interval_ms: scorer.cfg.intervalMs });
  let stopping = false, timer = null, lastBeat = 0;
  const run = () => {
    let next = scorer.cfg.intervalMs;
    try {
      const r = scorer.tick();
      if (r.full) next = scorer.cfg.catchUpMs;
      else scorer.daily();
    } catch (e) {
      out({ ev: 'error', message: String(e && e.message) });
      try { scorer.setMeta('last_error', String(e && e.message).slice(0, 300)); scorer.setMeta('last_error_ts', String(nowSec())); } catch { /* the score database itself failed: nothing more to record */ }
    }
    const t = Date.now();
    if (t - lastBeat > 600000) { lastBeat = t; out({ ev: 'beat', rss_mb: Math.round(process.memoryUsage().rss / 1048576), scored_total: Number(scorer.meta('scored_total') || 0), skipped_total: Number(scorer.meta('skipped_total') || 0) }); }
    if (!stopping) timer = setTimeout(run, next);
  };
  const stop = () => { stopping = true; clearTimeout(timer); scorer.close(); out({ ev: 'stop' }); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  run();
}

if (require.main === module) main();

module.exports = { createScorer, loadConfig, weekStartOf, openLedger, openScores };

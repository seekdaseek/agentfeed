// tools/r23/crash-risk.js: three routes over the scores the ledger-score service writes (R23 T1): get_crash_risk ($0.02), get_launch_radar ($0.10), get_crash_risk_record (free).
//
// SWITCHED OFF BY DEFAULT. The routes exist only while R23_CRASH_ROUTES=on (enabled() below, read at call time like PENSIO_NEWS in tools/briefs/config.js). expansion.js adds `entries`
// to its table only when enabled() is true, so with the flag off the routes are in no table, document, Bazaar entry or MCP list. The scorer itself runs either way.
//
// The routes read ONLY the score database (LEDGER_SCORE_DB, default /opt/launchledger-score/scores.db), through a read-only handle that is opened on first use and reopened after any error.
// They never open launchledger.db and never load the model: the model identity, the frozen decile boundaries and the live ones are in the score database's meta table (ledger-score writes them).
// A call that cannot be answered from fresh scores is a 503 "Not charged"; a valid request outside what is scored is a 404 "not covered, not charged"; the caller's wrong input is a 400 thrown
// before the database is touched. Nothing here fetches a URL, so lib/safe-fetch.js is not used.
'use strict';
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const Database = require('better-sqlite3');
const { unavailable, notCovered, bad } = require('./common');
const { BASE58_RE } = require('../../lib/solrpc');
const C = require('./crash-model/constants');
const { decileOf } = require('./crash-model/metrics');
const { ensureSchema } = require('./crash-model/schema');

const DAY = 86400;
const enabled = () => String(process.env.R23_CRASH_ROUTES || '').toLowerCase() === 'on';
const scoresPath = (env = process.env) => env.LEDGER_SCORE_DB || '/opt/launchledger-score/scores.db';
const round = (x, d = 6) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10 ** d) / 10 ** d);
const META_FILE = path.join(__dirname, 'crash-model', 'meta.json');

let STATIC_META = null;                       // the model's description without its trees (about 6 KB), read once and only when a text needs it
function staticMeta() {
  if (STATIC_META === null) { try { STATIC_META = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { STATIC_META = {}; } }
  return STATIC_META;
}

/** what the score is and what it is not; every number comes from the model's own description */
function methodText(m) {
  const trained = m && m.n_train && m.trained_through_day ? ` It was trained on ${m.n_train} labelled pools that entered through ${m.trained_through_day}.` : '';
  return `A gradient-boosted decision-tree model scores each new LaunchLedger pool once, at entry, from the numbers frozen when the pool joined the cohort: liquidity, 24 hour volume, price, fully diluted value, trade count, pool age, venue, quote token, pair name and the hour and weekday of entry. The score is the model's estimate of the ${C.MEANING}, measured as the price at the ${C.HORIZON_HOURS} hour check against the price at entry.${trained} The decile ranks the score among new pools, 1 the lowest and 10 the highest. It ranks new pools; it is not a recommendation.`;
}

/**
 * The handlers, over a database handle. deps (all optional, for tests): { env, now: () => ms, open: (file) => Database, db: an already open Database that is never closed here }.
 * The real server passes nothing: the file named by LEDGER_SCORE_DB is opened read-only on the first call.
 */
function makeHandlers(deps = {}) {
  const env = deps.env || process.env;
  const clockMs = () => (deps.now ? deps.now() : Date.now());
  let handle = null;

  function db() {
    if (deps.db) return deps.db;
    if (handle) return handle;
    const file = scoresPath(env);
    if (!fs.existsSync(file)) throw unavailable('the crash-risk scores are not available yet', 120);
    try {
      handle = (deps.open || ((f) => new Database(f, { readonly: true, fileMustExist: true })))(file);
      handle.pragma('query_only = ON'); handle.pragma('busy_timeout = 2000');
    } catch { handle = null; throw unavailable('the crash-risk scores could not be opened', 120); }
    return handle;
  }
  /** run `fn(db)`; a database error closes the handle (the next call reopens it) and becomes a 503; our own refusals pass through */
  function use(fn) {
    const d = db();
    try { return fn(d); } catch (e) {
      if (e && (e.status || e.kind)) throw e;
      if (!deps.db) { try { handle && handle.close(); } catch { /* already closed */ } handle = null; }
      throw unavailable('the crash-risk scores could not be read', 120);
    }
  }
  const metaOf = (d, keys) => {
    const out = {};
    for (const r of d.prepare(`SELECT k, v FROM meta WHERE k IN (${keys.map(() => '?').join(',')})`).all(...keys)) out[r.k] = r.v;
    return out;
  };

  /** -> { nowSec, newest, ledgerRunning } or throws the 503 when the scorer is not running, has nothing, or is behind a running LaunchLedger */
  function health(d, nowSec) {
    const m = metaOf(d, ['last_tick_ts', 'ledger_last_cycle']);
    const tick = Number(m.last_tick_ts);
    if (!m.last_tick_ts || !Number.isFinite(tick)) throw unavailable('the crash-risk scorer has not recorded a run yet', 120);
    if (nowSec - tick > C.TICK_STALE_SEC) throw unavailable(`the crash-risk scorer last ran ${Math.round((nowSec - tick) / 60)} minutes ago`, 120);
    const newest = d.prepare('SELECT MAX(scored_ts) AS t FROM scores').get().t;
    if (newest === null || newest === undefined) throw unavailable('no pool has been scored yet', 120);
    const ledgerRunning = m.ledger_last_cycle !== undefined && Number.isFinite(Number(m.ledger_last_cycle)) && nowSec - Number(m.ledger_last_cycle) <= C.LEDGER_RUNNING_SEC;
    if (ledgerRunning && nowSec - newest > C.STALE_NEWEST_SEC) throw unavailable(`the newest score is ${Math.round((nowSec - newest) / 60)} minutes old while LaunchLedger is running`, 120);
    return { newest, ledgerRunning };
  }

  /** the decile boundaries for a model version: its live ones when it has enough live scores, else the frozen ones in the score database */
  function cutsFor(d, ver) {
    const m = metaOf(d, [`live:${ver}`, `frozen:${ver}`]);
    const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    const live = m[`live:${ver}`] && parse(m[`live:${ver}`]);
    const minLive = Number(metaOf(d, ['live_cuts_min']).live_cuts_min) || C.LIVE_CUTS_MIN;
    if (live && Array.isArray(live.cuts) && live.cuts.length === 9 && live.n >= minLive) return { cuts: live.cuts, basis: 'live-14d' };
    const fz = m[`frozen:${ver}`] && parse(m[`frozen:${ver}`]);
    return fz && Array.isArray(fz.cuts) && fz.cuts.length === 9 ? { cuts: fz.cuts, basis: 'frozen' } : { cuts: null, basis: null };
  }
  const modelInfo = (d, ver) => { try { const r = d.prepare('SELECT v FROM meta WHERE k = ?').get(`model:${ver}`); return r ? JSON.parse(r.v) : null; } catch { return null; } };

  function latestAuc(d, ver, nowSec) {
    const r = d.prepare('SELECT week_start, model_version, n, positives, auc FROM auc_weekly WHERE auc IS NOT NULL AND model_version = ? ORDER BY week_start DESC LIMIT 1').get(ver);
    return r ? { week: r.week_start, n: r.n, positives: r.positives, auc: round(r.auc), partial_week: Date.parse(`${r.week_start}T00:00:00Z`) / 1000 + 8 * DAY > nowSec, model_version: r.model_version } : null;
  }

  function getCrashRisk(a = {}) {
    const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const hasMint = given(a.mint), hasPool = given(a.pool);
    if (hasMint === hasPool) throw bad('give exactly one of mint or pool');
    const key = hasMint ? 'mint' : 'pool';
    if (typeof a[key] !== 'string' || !BASE58_RE.test(a[key].trim())) throw bad(`${key} must be 32 to 44 base58 characters`);
    const value = a[key].trim();
    return use((d) => {
      const nowSec = Math.floor(clockMs() / 1000);
      const h = health(d, nowSec);
      const cover = nowSec - C.COVER_DAYS * DAY;
      const rows = d.prepare(`SELECT * FROM scores WHERE ${key} = ? AND scored_ts >= ? AND t0_ts >= ? ORDER BY scored_ts DESC, pool_id DESC`).all(value, cover, cover);
      if (!rows.length) {
        if (!h.ledgerRunning) throw unavailable('LaunchLedger has not completed a cycle recently, so a pool that is not scored may simply not be recorded yet', 300);
        throw notCovered(`${key} ${value} was not scored at entry in the last ${C.COVER_DAYS} days`);
      }
      const r = rows[0];
      const dec = cutsFor(d, r.model_version);
      const lag = Number(metaOf(d, ['entry_lag_sec']).entry_lag_sec) || C.ENTRY_LAG_SEC;
      const info = modelInfo(d, r.model_version) || (staticMeta().model_version === r.model_version ? staticMeta() : null);
      return {
        mint: r.mint, pool: r.pool, dex: r.dex,
        score: round(r.score), meaning: C.MEANING,
        decile: dec.cuts ? decileOf(r.score, dec.cuts) : null, decile_basis: dec.basis,
        model_version: r.model_version, scored_ts: r.scored_ts, entry_ts: r.t0_ts,
        scored_seconds_after_entry: r.scored_ts - r.t0_ts, scored_at_entry: r.scored_ts - r.t0_ts <= lag,
        liquidity_usd_at_entry: round(r.t0_liquidity_usd, 2), fdv_usd_at_entry: round(r.t0_fdv_usd, 2),
        pools_scored_for_mint: key === 'mint' ? rows.length : d.prepare('SELECT COUNT(*) AS n FROM scores WHERE mint = ? AND scored_ts >= ? AND t0_ts >= ?').get(r.mint, cover, cover).n,
        live_auc: latestAuc(d, r.model_version, nowSec),
        method: methodText(info),
      };
    });
  }

  function getLaunchRadar(a = {}) {
    let limit = C.RADAR_DEFAULT;
    if (a.limit !== undefined && a.limit !== null && a.limit !== '') {
      const n = Number(a.limit);
      if (!Number.isInteger(n) || n < 1 || n > C.RADAR_MAX) throw bad(`limit must be an integer from 1 to ${C.RADAR_MAX}`);
      limit = n;
    }
    return use((d) => {
      const nowSec = Math.floor(clockMs() / 1000);
      health(d, nowSec);
      const cover = nowSec - C.COVER_DAYS * DAY;
      const rows = d.prepare('SELECT * FROM scores WHERE scored_ts >= ? AND t0_ts >= ? ORDER BY scored_ts DESC, pool_id DESC LIMIT ?').all(cover, cover, limit);
      if (!rows.length) throw unavailable(`no pool has been scored in the last ${C.COVER_DAYS} days`, 120);
      const top = rows[0].model_version, byVer = new Map();
      const cuts = (v) => { if (!byVer.has(v)) byVer.set(v, cutsFor(d, v)); return byVer.get(v); };
      const info = modelInfo(d, top) || (staticMeta().model_version === top ? staticMeta() : null);
      return {
        as_of: nowSec, count: rows.length, limit, meaning: C.MEANING,
        model_version: top, decile_basis: cuts(top).basis,
        launches: rows.map((r) => {
          const dc = cuts(r.model_version);
          return {
            mint: r.mint, pool: r.pool, dex: r.dex, score: round(r.score), decile: dc.cuts ? decileOf(r.score, dc.cuts) : null,
            scored_ts: r.scored_ts, entry_ts: r.t0_ts, liquidity_usd_at_entry: round(r.t0_liquidity_usd, 2), fdv_usd_at_entry: round(r.t0_fdv_usd, 2),
            ...(r.model_version !== top ? { model_version: r.model_version, decile_basis: dc.basis } : {}),
          };
        }),
        method: methodText(info),
      };
    });
  }

  /** the free record: weekly live AUC and decile hit rates from the score database, the validation model's out-of-time test from the model description, and nothing invented when there is no data */
  function getCrashRiskRecord() {
    const nowSec = Math.floor(clockMs() / 1000);
    const sm = staticMeta();
    let weeks = [], models = [], current = null;
    try {
      const out = use((d) => ({
        rows: d.prepare('SELECT week_start, model_version, n, positives, auc, deciles, computed_ts FROM auc_weekly ORDER BY week_start DESC, model_version LIMIT 26').all(),
        models: d.prepare("SELECT k, v FROM meta WHERE k LIKE 'model:%' ORDER BY k").all(),
        current: (d.prepare("SELECT v FROM meta WHERE k = 'current_model'").get() || {}).v || null,
        minResolved: C.MIN_RESOLVED,
      }));
      current = out.current;
      weeks = out.rows.map((r) => {
        let dj = null; try { dj = JSON.parse(r.deciles); } catch { /* none */ }
        return {
          week: r.week_start, model_version: r.model_version, resolved_pools: r.n, positives: r.positives, base_rate: r.n ? round(r.positives / r.n) : null, auc: round(r.auc),
          partial_week: Date.parse(`${r.week_start}T00:00:00Z`) / 1000 + 8 * DAY > nowSec, computed_ts: r.computed_ts,
          decile_basis: dj ? dj.basis : null,
          deciles: dj && Array.isArray(dj.rows) ? dj.rows.map((x) => ({ decile: x.decile, resolved_pools: x.n, positives: x.positives, hit_rate: x.n ? round(x.positives / x.n) : null })) : [],
        };
      });
      models = out.models.map((r) => { try { const m = JSON.parse(r.v); return { model_version: m.model_version, trained_through_day: m.trained_through_day, n_train: m.n_train, model_type: m.model_type }; } catch { return null; } }).filter(Boolean);
    } catch (e) {
      if (!(e && e.status === 503)) throw e;                    // the record is free: with no database yet it says there is no record yet
    }
    if (!models.length && sm.model_version) models = [{ model_version: sm.model_version, trained_through_day: sm.trained_through_day, n_train: sm.n_train, model_type: sm.model_type }];
    const v = sm.validation;
    const backtest = v ? {
      what: 'ROC AUC of the validation model (the same recipe trained on an earlier window) on pools that entered after its training window and an embargo; measured once, before any live scoring.',
      measured_on_the_live_model: false,
      validation_model_trained_through_day: v.trained_through_day, validation_pools_trained_on: v.n_train, pools_tested: v.n_test, base_rate: round(v.base_rate_test),
      roc_auc: Object.entries(v.roc_auc || {}).map(([k, x]) => ({ window: k === 'pooled' ? 'all test weeks' : `test week ${k.replace(/^W/, '')}`, pools: (v.n_by_window || {})[k], roc_auc: round(x) })),
      decile_hit_rates: (v.decile_table || []).map((x) => ({ decile: x.d, pools: x.n, positives: x.positives, hit_rate: round(x.rate) })),
      note: v.note,
    } : null;
    return {
      as_of: nowSec,
      meaning: C.MEANING,
      current_model_version: current || sm.model_version || null,
      models,
      weeks,
      message: weeks.length ? undefined : `No week has a live record yet. A week is reported once its pools have outcomes that arrived after they were scored; its AUC needs ${C.MIN_RESOLVED} resolved pools, a positive and a negative.`,
      backtest,
      method: methodText(sm),
      week_note: 'week is the Monday (UTC) of the ISO week in which the pools entered.',
      note: 'AUC is the chance that a pool which fell 80 percent within 24 hours had a higher score than one that did not, 0.5 being no skill. Decile hit rates are the share of resolved pools in each decile that fell. The live weeks count only pools scored within minutes of entry, after the model\'s training window.',
    };
  }

  return { getCrashRisk, getLaunchRadar, getCrashRiskRecord, close() { try { handle && handle.close(); } catch { /* already closed */ } handle = null; } };
}

let DEFAULT = null;
const handlers = () => DEFAULT || (DEFAULT = makeHandlers());

// ---- the entries expansion.js adds while enabled()
const base58 = (desc) => z.string().min(32).max(44).regex(BASE58_RE, '32 to 44 base58 characters').optional().describe(desc);
const DESC = {
  get_crash_risk: `Use when an agent needs the crash-risk rank of a new Solana pool. Returns the ${C.MEANING}, its decile and the live weekly AUC, for a mint or pool scored in the last ${C.COVER_DAYS} days. A 404 or 503 is never charged.`,
  get_launch_radar: `Use when an agent needs the newest Solana launches ranked by crash risk. Returns up to ${C.RADAR_MAX} pools scored in the last ${C.COVER_DAYS} days, newest first, with score, decile, venue, and liquidity and fully diluted value at entry. A stale scorer answers 503, not charged.`,
  get_crash_risk_record: `Use when an agent needs the track record of the crash-risk score before relying on it. Returns the weekly AUC of live scores against later outcomes, decile hit rates, sample sizes and the model version. Free; empty until a week resolves.`,
};

let EXAMPLES = null;
/** the example `data` objects, made by running the real handlers on a synthetic score database built from crash-model/example-scores.json (made-up identifiers, scores of the real model on real feature rows) */
function buildExamples() {
  if (EXAMPLES) return EXAMPLES;
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'crash-model', 'example-scores.json'), 'utf8'));
  const sm = staticMeta();
  const d = new Database(':memory:');
  try {
    ensureSchema(d);
    const ins = d.prepare('INSERT INTO scores (pool_id, mint, pool, dex, score, model_version, scored_ts, t0_ts, t0_liquidity_usd, t0_fdv_usd) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const put = d.prepare('INSERT INTO meta (k, v) VALUES (?, ?)');
    d.transaction(() => {
      fx.pools.forEach((p, i) => ins.run(i + 1, p.mint, p.pool, p.dex, p.score, sm.model_version, fx.now - p.minutes_ago * 60 + 40, fx.now - p.minutes_ago * 60, p.t0_liquidity_usd, p.t0_fdv_usd));
      const { trees, baseline, feature_names, categories, tables, required_columns, ...pub } = sm;
      put.run('current_model', sm.model_version); put.run(`model:${sm.model_version}`, JSON.stringify(pub)); put.run(`frozen:${sm.model_version}`, JSON.stringify({ cuts: sm.decile_cuts, source: sm.decile_cuts_source }));
      put.run('last_tick_ts', String(fx.now)); put.run('ledger_last_cycle', String(fx.now)); put.run('entry_lag_sec', String(C.ENTRY_LAG_SEC));
    })();
    const h = makeHandlers({ db: d, now: () => fx.now * 1000 });
    EXAMPLES = { get_crash_risk: h.getCrashRisk({ mint: fx.pools[fx.example_mint_index].mint }), get_launch_radar: h.getLaunchRadar({ limit: String(fx.pools.length) }), get_crash_risk_record: h.getCrashRiskRecord() };
  } finally { d.close(); }
  return EXAMPLES;
}

const entries = [
  { name: 'get_crash_risk', route: 'GET /api/crash-risk', usd: 0.02,
    tags: ['solana', 'token', 'risk', 'new-pools', 'launches', 'pre-trade', 'exclusive'],
    desc: DESC.get_crash_risk,
    schema: { mint: base58('the base token mint of a pool scored at entry in the last 7 days; give exactly one of mint or pool'), pool: base58('the pool address of a pool scored at entry in the last 7 days; give exactly one of mint or pool') },
    title: 'Crash risk of a new pool', question: 'How likely is this new Solana pool to lose 80 percent of its price within 24 hours of entry?',
    get example() { return buildExamples().get_crash_risk; },
    run: async (a) => handlers().getCrashRisk(a || {}) },
  { name: 'get_launch_radar', route: 'GET /api/launch-radar', usd: 0.10,
    tags: ['solana', 'token', 'risk', 'new-pools', 'launches', 'screener', 'exclusive'],
    desc: DESC.get_launch_radar,
    schema: { limit: z.number().int().min(1).max(C.RADAR_MAX).optional().describe(`how many launches, 1 to ${C.RADAR_MAX}, default ${C.RADAR_DEFAULT}`) },
    title: 'New launch crash-risk radar', question: 'Which new Solana pools were just scored, and how do they rank by crash risk?',
    get example() { return buildExamples().get_launch_radar; },
    run: async (a) => handlers().getLaunchRadar(a || {}) },
  { name: 'get_crash_risk_record', route: 'GET /api/crash-risk-record', usd: 0, free: true,
    tags: ['solana', 'token', 'risk', 'track-record', 'calibration', 'exclusive'],
    desc: DESC.get_crash_risk_record,
    schema: {},
    title: 'Crash risk track record', question: 'How well have the live crash-risk scores ranked the pools that fell 80 percent within 24 hours?',
    get example() { return buildExamples().get_crash_risk_record; },
    run: async () => handlers().getCrashRiskRecord() },
];

module.exports = { enabled, entries, makeHandlers, methodText, buildExamples, DESC };

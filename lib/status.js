// lib/status.js: the free GET /api/status and /status (R25, 13 Nov 2026).
//
// What it answers, read live and cached at most 30 s: per venue of the liquidation tape the last event time, its age and the events of the last hour; per collector the
// box runs for the paid routes the last COMPLETED write and its age; the service name, version and uptime; and a top-level ok that is false when any venue or collector is
// older than its own limit, with the offenders named in problems[]. Nothing else: no wallet, payer, key, revenue, address, path or error text leaves this module. An
// unreadable source is reported as that entry's `error: "unreadable"` (ok false); it never becomes an HTTP 500. No discovery or self-check result is recorded on the box,
// so there is no field for one.
//
// THE LIMITS. Collectors: the watchdog's R6 table (/opt/watchdog.sh, "FRESHNESS OF THE AGENTFEED COLLECTORS"): the smaller of 3x the cron cadence and the route's own
// staleness cutoff. Venues have no cadence (a websocket feed), so each limit is about 2x the longest NORMAL gap between two rows over 14 days, measured on the box on
// 13 Nov 2026 (minute buckets; the 10 Nov outage, 256 min for binance and bybit and 39 min for okx, left out): binance 5 min, bybit 9 min, okx 15 min. A file snapshot is
// written tmp + rename at the end of a completed run, so its mtime is the last completed write; a database is read through its newest row (a WAL file's own mtime says
// nothing).
// The path and environment names below are the tools' own (test/status.test.js asserts each name appears in the tool that owns it).
'use strict';
const fs = require('fs');
const path = require('path');
const { MAX_AGE_S: jitoMaxAgeS } = require('./jito-age');

const ROOT = path.join(__dirname, '..');
const CACHE_MS = 30_000;
const HOUR_MS = 3_600_000;

const file = (env, def) => (e) => e[env] || def;
const fileMtime = (p) => fs.statSync(p).mtimeMs;
/** newest value of one column, in ms; `unit` is the factor to ms (1000 for epoch seconds, 1 for epoch ms) */
function dbNewestMs(p, table, col, unit) {
  const Database = require('better-sqlite3');
  const db = new Database(p, { readonly: true, fileMustExist: true });
  try {
    const r = db.prepare(`SELECT MAX(${col}) AS m FROM ${table}`).get();
    return r && Number.isFinite(Number(r.m)) && r.m !== null ? Number(r.m) * unit : null;
  } finally { db.close(); }
}

const LIQ_DB = (e) => e.LIQ_DB || '/opt/agentfeed/liquidations.db';
// venues: exchange column of liquidations.db, ts in ms
const VENUES = [
  { venue: 'binance', maxAgeS: 600 },    // longest normal gap 5 min
  { venue: 'bybit', maxAgeS: 1200 },     // longest normal gap 9 min
  { venue: 'okx', maxAgeS: 1800 },       // longest normal gap 15 min
];

// collectors: name, cadence text, limit in seconds (comment says where it comes from), how the last completed write is read
const COLLECTORS = [
  { name: 'funding-radar', cadence: '5 min', maxAgeS: 900, read: (e) => fileMtime(file('FUNDING_RADAR_SNAPSHOT', path.join(ROOT, 'funding-radar.json'))(e)) },      // 3x5 min = route cutoff STALE_AFTER_S 15 min
  { name: 'hl-oi', cadence: '5 min', maxAgeS: 900, read: (e) => dbNewestMs(file('HL_OI_DB', path.join(ROOT, 'hl-oi.db'))(e), 'hl_oi', 'ts', 1000) },                    // 3x5 min = lib/hl-oi.js FRESH_S
  { name: 'macro', cadence: 'daily', maxAgeS: 259200, read: (e) => fileMtime(file('MACRO_SNAPSHOT', path.join(ROOT, 'macro.json'))(e)) },                              // 3 x 24 h; the route's own cutoff is 35 days
  { name: 'base-launches', cadence: '1 min', maxAgeS: 180, read: (e) => fileMtime(file('BASE_LAUNCHES_SNAPSHOT', path.join(ROOT, 'base-launches.json'))(e)) },         // 3 x 1 min; route STALE_MS 5 min
  { name: 'hl-whales', cadence: '5 min', maxAgeS: 390, read: (e) => fileMtime(file('HL_WHALES_SNAPSHOT', path.join(ROOT, 'hl-whales.json'))(e)) },                      // route SNAPSHOT_MAX_MS 6.5 min (smaller than 3 x 5 min)
  { name: 'peg-collect', cadence: '5 min', maxAgeS: 900, read: (e) => dbNewestMs(file('PEG_ONCHAIN_DB', path.join(ROOT, 'peg-onchain.db'))(e), 'ticks', 'ts', 1000) }, // 3 x 5 min; route latest() maxAgeS 20 min
  { name: 'jito-tips', cadence: '15 min', maxAgeS: null, read: (e) => fileMtime(file('JITO_TIPS_FILE', path.join(ROOT, 'jito-tips.json'))(e)) },                       // 3 x 15 min = lib/jito-age.js MAX_AGE_S (45 min), read at request time
  { name: 'sanctions', cadence: 'daily', maxAgeS: 108000, read: (e) => fileMtime(file('SANCTIONS_FILE', path.join(ROOT, 'data', 'sanctions-ofac.json'))(e)) },         // 30 h; the route's own cutoff is 48 h
  { name: 'disposable', cadence: 'weekly', maxAgeS: 691200, read: (e) => fileMtime(file('DISPOSABLE_FILE', path.join(ROOT, 'data', 'disposable-domains.txt'))(e)) },  // 8 days; the route's own cutoff is 21 days
  { name: 'pegwatch', cadence: 'continuous', maxAgeS: 1800, read: (e) => dbNewestMs(e.PEGWATCH_DB || '/opt/pegwatch/pegwatch.db', 'ticks', 'ts', 1000) },              // 30 min, the watchdog's pegwatch limit
  { name: 'caliper-forecast', cadence: '15 min', maxAgeS: 2700, read: (e) => dbNewestMs(e.CALIPER_RECORD_DB || '/opt/caliper/record.db', 'forecasts', 'window_start', 1) }, // 3 x 15 min = the watchdog's 45 min
  { name: 'rwa-snapshots', cadence: 'daily', maxAgeS: 259200, read: (e) => dbNewestMs(e.R24_RWA_DB || path.join(path.dirname(path.resolve(e.AGENTFEED_DB || path.join(ROOT, 'agentfeed.db'))), 'rwa-snapshots.db'), 'rwa_snap', 'block_ts', 1000) }, // 3 x 24 h
];

const isoOrNull = (ms) => (ms === null ? null : new Date(ms).toISOString());

/**
 * deps (all optional, for tests): now(), env, uptimeS(), version, cacheMs, venues, collectors.
 * Returns { handler, snapshot(), _reset() }.
 */
function makeStatus({ now = Date.now, env = process.env, uptimeS = () => process.uptime(), version = 'unknown', cacheMs = CACHE_MS, venues = VENUES, collectors = COLLECTORS } = {}) {
  let cache = null;

  /** One read of every source. A failing source becomes null for that entry; nothing about the failure is kept. */
  function sample(t) {
    const out = { venues: [], collectors: [] };
    let tape = null;
    try { const Database = require('better-sqlite3'); tape = new Database(LIQ_DB(env), { readonly: true, fileMustExist: true }); } catch { tape = null; }
    try {
      for (const v of venues) {
        let last = null, hour = null, ok = false;
        if (tape) {
          try {
            const r = tape.prepare('SELECT MAX(ts) AS m FROM liquidations WHERE exchange = ?').get(v.venue);
            last = r && r.m !== null && Number.isFinite(Number(r.m)) ? Number(r.m) : null;
            hour = tape.prepare('SELECT COUNT(*) AS n FROM liquidations WHERE exchange = ? AND ts >= ?').get(v.venue, t - HOUR_MS).n;
            ok = true;
          } catch { last = null; hour = null; ok = false; }
        }
        out.venues.push({ venue: v.venue, maxAgeS: v.maxAgeS, lastMs: last, hour, readable: ok });
      }
    } finally { if (tape) { try { tape.close(); } catch { /* ignore */ } } }
    for (const c of collectors) {
      let last = null, readable = true;
      try { last = c.read(env); if (!Number.isFinite(last)) { last = null; } } catch { last = null; readable = false; }
      out.collectors.push({ name: c.name, cadence: c.cadence, maxAgeS: c.maxAgeS === null ? jitoMaxAgeS() : c.maxAgeS, lastMs: last, readable });
    }
    return out;
  }

  /** Render one sample against the clock of THIS response, so an age is never older than the sample it came from. */
  function render(raw, t) {
    const problems = [];
    const age = (ms) => (ms === null ? null : Math.max(0, Math.round((t - ms) / 1000)));
    const venuesOut = raw.venues.map((v) => {
      const a = age(v.lastMs);
      const ok = v.readable && a !== null && a <= v.maxAgeS;
      if (!ok) problems.push(!v.readable ? `venue ${v.venue}: unreadable` : a === null ? `venue ${v.venue}: no events` : `venue ${v.venue}: last event ${a} s ago, limit ${v.maxAgeS} s`);
      const o = { venue: v.venue, ok, last_event_at: isoOrNull(v.lastMs), age_s: a, max_age_s: v.maxAgeS, events_last_hour: v.hour };
      if (!v.readable) o.error = 'unreadable';
      return o;
    });
    const collectorsOut = raw.collectors.map((c) => {
      const a = age(c.lastMs);
      const ok = c.readable && a !== null && a <= c.maxAgeS;
      if (!ok) problems.push(!c.readable ? `collector ${c.name}: unreadable` : a === null ? `collector ${c.name}: no data` : `collector ${c.name}: last write ${a} s ago, limit ${c.maxAgeS} s`);
      const o = { name: c.name, ok, last_write_at: isoOrNull(c.lastMs), age_s: a, max_age_s: c.maxAgeS, cadence: c.cadence };
      if (!c.readable) o.error = 'unreadable';
      return o;
    });
    return {
      ok: problems.length === 0,
      as_of: new Date(t).toISOString(),
      service: { name: 'agentfeed', version, uptime_s: Math.round(uptimeS()) },
      venues: venuesOut,
      collectors: collectorsOut,
      problems,
    };
  }

  function snapshot() {
    const t = now();
    if (!cache || t - cache.at >= cacheMs || t < cache.at) cache = { at: t, raw: sample(t) };
    return render(cache.raw, t);
  }

  function handler(_req, res) {
    res.set('Cache-Control', 'no-store');
    try { res.json(snapshot()); } catch { res.status(503).json({ ok: false, error: 'status unavailable' }); }
  }

  return { handler, snapshot, _reset: () => { cache = null; } };
}

module.exports = { makeStatus, VENUES, COLLECTORS, CACHE_MS };

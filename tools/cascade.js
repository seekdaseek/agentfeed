// tools/cascade.js — liquidation cascade detector (paid: get_cascade_alert)
'use strict';
const Database = require('better-sqlite3');
const { CORE, isAll } = require('../universe.js');
const DB_PATH = '/opt/agentfeed/liquidations.db';
let db = null;
function getDb() {
  if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return db;
}
const TIERS = [
  { name: 'extreme', usd: 2000000 },
  { name: 'major', usd: 500000 },
  { name: 'minor', usd: 50000 },
];
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
function detectCascades(database, { windowSec = 90, minEvents = 4, minUsd = 50000, symbols = null } = {}) {
  const since = Date.now() - windowSec * 1000;
  // symbols=null => full recorded universe. Callers pass CORE to keep the curated product.
  const symSql = symbols && symbols.length ? `AND symbol IN (${symbols.map(() => '?').join(',')})` : '';
  const rows = database.prepare(`
    SELECT symbol, side, COUNT(*) AS events, SUM(usd) AS total_usd, MAX(usd) AS max_usd,
           MIN(ts) AS first_ts, MAX(ts) AS last_ts,
           MIN(price) AS price_min, MAX(price) AS price_max
    FROM liquidations WHERE ts >= ? ${symSql}
    GROUP BY symbol, side
    HAVING events >= ? AND total_usd >= ?
    ORDER BY total_usd DESC
  `).all(since, ...(symbols || []), minEvents, minUsd);
  return rows.map((r) => ({
    symbol: r.symbol,
    side_liquidated: r.side === 'Buy' ? 'longs' : 'shorts',
    events: r.events,
    total_usd: Math.round(r.total_usd * 100) / 100,
    max_single_usd: Math.round(r.max_usd * 100) / 100,
    duration_sec: Math.max(1, Math.round((r.last_ts - r.first_ts) / 1000)),
    price_range: [r.price_min, r.price_max],
    severity: (TIERS.find((t) => r.total_usd >= t.usd) || TIERS[TIERS.length - 1]).name,
  }));
}
function getCascadeAlert(req) {
  const q = (req && req.query) || {};
  const all = isAll(q);
  const params = {
    windowSec: clamp(q.window, 30, 300, 90),
    minEvents: clamp(q.min_events, 2, 50, 4),
    minUsd: clamp(q.min_usd, 10000, 10000000, 50000),
    symbols: all ? null : CORE,          // default = curated product; scope=all = full universe
  };
  const cascades = detectCascades(getDb(), params);
  return {
    active: cascades.length > 0,
    count: cascades.length,
    cascades,
    scope: all ? 'all' : 'core',
    params: { window_sec: params.windowSec, min_events: params.minEvents, min_usd: params.minUsd },
    checked_at: Date.now(),
  };
}
module.exports = { getCascadeAlert, detectCascades };

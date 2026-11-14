// Liquidation data from local collector DB — multi-exchange (Bybit complete + OKX sampled)
// side convention (verified live): 'Sell' = short liquidated, 'Buy' = long liquidated
const Database = require('better-sqlite3');
// R36 (14 Nov 2026): opened on the first request that needs it, not at require time (a missing file stopped the whole server from starting). A tape that cannot be opened is a 503
// "data source unavailable" on the routes that read it, never charged, retried on the next request; the handle and the queries are unchanged (read-only, fileMustExist).
const TAPE = '/opt/agentfeed/liquidations.db';
let _db = null;
const db = {
  prepare(sql) {
    if (!_db) { try { _db = new Database(TAPE, { readonly: true, fileMustExist: true }); } catch { _db = null; throw Object.assign(new Error('data source unavailable: the liquidation tape cannot be read right now. Not charged.'), { status: 503, retryAfter: 60 }); } }
    return _db.prepare(sql);
  },
};

const { CORE, isAll, inClause } = require('../universe.js');
const SYMBOLS = { SOL: 'SOLUSDT', BTC: 'BTCUSDT', ETH: 'ETHUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT' };

function label(side) { return side === 'Sell' ? 'short_liquidated' : 'long_liquidated'; }

// R7 R4: a route that reports "right now" from our own recording must prove the recording is live first. A collector
// that died would otherwise make a quiet hour and a dead feed look identical. Older than 30 minutes (the bound
// tools/entry.js uses for liq-pulse) is a 503 with Retry-After: the settlement is cancelled, nothing is billed.
const TAPE_STALE_S = 30 * 60;
function assertFresh() {
  const r = db.prepare('SELECT MAX(ts) AS t FROM liquidations').get();
  const age = r && r.t ? Math.round((Date.now() - r.t) / 1000) : null;
  if (age == null || age > TAPE_STALE_S) {
    throw Object.assign(new Error(age == null ? 'the liquidation tape is empty. Not charged.' : `the liquidation tape is ${age}s old, past the ${TAPE_STALE_S}s freshness bound. Not charged.`), { status: 503 });
  }
}

// v3: the collector records every USDT perp, so accept them. Aliases (SOL/BTC/...) still
// resolve; anything else must look like a USDT perp. Regex-validated (query is parameterized).
function resolveSymbol(s) {
  if (!s) return null;
  const u = String(s).toUpperCase();
  if (SYMBOLS[u]) return SYMBOLS[u];
  if (/^[A-Z0-9]{1,20}USDT$/.test(u)) return u;
  throw new Error('symbol must be an alias (SOL, BTC, ETH, XRP, DOGE) or a USDT perp symbol (e.g. SXTUSDT)');
}

function getRecentLiquidations(req) {
  assertFresh();
  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit) || 25, 1), 100);
  const minUsd = Math.max(parseFloat(q.min_usd) || 0, 0);
  const symbol = resolveSymbol(q.symbol);

  // v3: collector now records the full universe. Default to CORE so existing callers see
  // no change; scope=all opts into everything.
  const scopeSql  = symbol ? 'AND symbol = ?' : (isAll(q) ? '' : `AND symbol IN (${inClause(CORE)})`);
  const scopeArgs = symbol ? [symbol]         : (isAll(q) ? [] : CORE);

  const rows = db.prepare(`
    SELECT ts, symbol, side, size, price, usd, exchange FROM liquidations
    WHERE usd >= ? ${scopeSql}
    ORDER BY ts DESC LIMIT ?
  `).all(minUsd, ...scopeArgs, limit);

  return {
    source: 'multi_exchange_collector',
    exchanges: ['bybit', 'okx', 'binance'],
    count: rows.length,
    liquidations: rows.map(r => ({
      ts: r.ts, symbol: r.symbol, exchange: r.exchange, event: label(r.side),
      size: r.size, price: r.price, usd: Math.round(r.usd * 100) / 100,
    })),
  };
}

function statsRow(where, params) {
  const r = db.prepare(`
    SELECT
      COUNT(*) n,
      ROUND(COALESCE(SUM(usd),0),2) total_usd,
      ROUND(COALESCE(SUM(CASE WHEN side='Buy'  THEN usd END),0),2) longs_usd,
      ROUND(COALESCE(SUM(CASE WHEN side='Sell' THEN usd END),0),2) shorts_usd,
      ROUND(COALESCE(MAX(usd),0),2) biggest_usd
    FROM liquidations WHERE ${where}
  `).get(...params);
  return { events: r.n, total_usd: r.total_usd, longs_liquidated_usd: r.longs_usd,
           shorts_liquidated_usd: r.shorts_usd, biggest_print_usd: r.biggest_usd };
}

function windowStats(symbol, ms) {
  const since = Date.now() - ms;
  const agg = statsRow('symbol = ? AND ts >= ?', [symbol, since]);
  const by_exchange = {};
  for (const ex of db.prepare(
    'SELECT DISTINCT exchange FROM liquidations WHERE symbol = ? AND ts >= ?'
  ).all(symbol, since).map(r => r.exchange)) {
    by_exchange[ex] = statsRow('symbol = ? AND ts >= ? AND exchange = ?', [symbol, since, ex]);
  }
  return { ...agg, by_exchange };
}

function getLiquidationStats() {
  assertFresh();
  const oldest = db.prepare('SELECT MIN(ts) t FROM liquidations').get().t;
  const out = { source: 'multi_exchange_collector', exchanges: ['bybit', 'okx', 'binance'], collecting_since: oldest };
  for (const [k, sym] of Object.entries(SYMBOLS)) {
    out[k.toLowerCase()] = { '1h': windowStats(sym, 3600e3), '24h': windowStats(sym, 86400e3) };
  }
  return out;
}

function getLiquidationLeaders(req) {
  assertFresh();
  const q = (req && req.query) || {};
  const mins  = Math.min(Math.max(parseInt(q.window_min) || 60, 5), 1440);
  const limit = Math.min(Math.max(parseInt(q.limit) || 10, 1), 50);
  const since = Date.now() - mins * 60000;
  const rows = db.prepare(`
    SELECT symbol,
           COUNT(*) AS events,
           ROUND(SUM(usd), 2) AS total_usd,
           ROUND(COALESCE(SUM(CASE WHEN side = 'Buy'  THEN usd END), 0), 2) AS longs_usd,
           ROUND(COALESCE(SUM(CASE WHEN side = 'Sell' THEN usd END), 0), 2) AS shorts_usd,
           ROUND(MAX(usd), 2) AS biggest_usd,
           COUNT(DISTINCT exchange) AS venues
    FROM liquidations WHERE ts >= ?
    GROUP BY symbol
    ORDER BY total_usd DESC
    LIMIT ?
  `).all(since, limit);
  return {
    source: 'multi_exchange_collector',
    universe: 'all_usdt_perps',
    exchanges: ['bybit', 'okx', 'binance'],
    window_min: mins,
    count: rows.length,
    leaders: rows.map(r => ({ ...r, dominant_side: r.longs_usd >= r.shorts_usd ? 'longs' : 'shorts' })),
  };
}

module.exports = { getRecentLiquidations, getLiquidationStats, getLiquidationLeaders, assertFresh };

function getLastLiquidation() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  const last = {};
  for (const [k, sym] of Object.entries(SYMBOLS)) {
    const r = db.prepare(
      'SELECT ts, symbol, side, size, price, usd, exchange FROM liquidations WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1'
    ).get(sym, cutoff);
    last[k.toLowerCase()] = r ? {
      ts: r.ts, symbol: r.symbol, exchange: r.exchange, event: label(r.side),
      size: r.size, price: r.price, usd: Math.round(r.usd * 100) / 100,
    } : null;
  }
  return {
    source: 'multi_exchange_collector',
    delay_notice: 'Data delayed 15 minutes. Real-time via get_recent_liquidations ($0.005) or get_liquidation_stats ($0.01).',
    last,
  };
}
module.exports.getLastLiquidation = getLastLiquidation;

// Liquidation data from local collector DB — multi-exchange (Bybit complete + OKX sampled)
// side convention (verified live): 'Sell' = short liquidated, 'Buy' = long liquidated
const Database = require('better-sqlite3');
const db = new Database('/opt/agentfeed/liquidations.db', { readonly: true, fileMustExist: true });

const { CORE, isAll, inClause } = require('../universe.js');
const SYMBOLS = { SOL: 'SOLUSDT', BTC: 'BTCUSDT', ETH: 'ETHUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT' };

function label(side) { return side === 'Sell' ? 'short_liquidated' : 'long_liquidated'; }

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
  const oldest = db.prepare('SELECT MIN(ts) t FROM liquidations').get().t;
  const out = { source: 'multi_exchange_collector', exchanges: ['bybit', 'okx', 'binance'], collecting_since: oldest };
  for (const [k, sym] of Object.entries(SYMBOLS)) {
    out[k.toLowerCase()] = { '1h': windowStats(sym, 3600e3), '24h': windowStats(sym, 86400e3) };
  }
  return out;
}

function getLiquidationLeaders(req) {
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

module.exports = { getRecentLiquidations, getLiquidationStats, getLiquidationLeaders };

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
    delay_notice: 'Data delayed 15 minutes. Real-time via get_recent_liquidations ($0.003) or get_liquidation_stats ($0.004).',
    last,
  };
}
module.exports.getLastLiquidation = getLastLiquidation;

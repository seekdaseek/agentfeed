// Liquidation data from local collector DB (Bybit allLiquidation via liqcollector.js)
const Database = require('better-sqlite3');
const db = new Database('/opt/agentfeed/liquidations.db', { readonly: true, fileMustExist: true });

const SYMBOLS = { SOL: 'SOLUSDT', BTC: 'BTCUSDT' };

// side in DB: 'Sell' = short liquidated, 'Buy' = long liquidated (Bybit convention, verified live)
function label(side) { return side === 'Sell' ? 'short_liquidated' : 'long_liquidated'; }

function getRecentLiquidations(req) {
  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit) || 25, 1), 100);
  const minUsd = Math.max(parseFloat(q.min_usd) || 0, 0);
  const symbol = q.symbol ? SYMBOLS[String(q.symbol).toUpperCase()] : null;
  if (q.symbol && !symbol) throw new Error('symbol must be SOL or BTC');

  const rows = db.prepare(`
    SELECT ts, symbol, side, size, price, usd FROM liquidations
    WHERE usd >= ? ${symbol ? 'AND symbol = ?' : ''}
    ORDER BY ts DESC LIMIT ?
  `).all(...(symbol ? [minUsd, symbol, limit] : [minUsd, limit]));

  return {
    source: 'bybit_allLiquidation',
    count: rows.length,
    liquidations: rows.map(r => ({
      ts: r.ts, symbol: r.symbol, event: label(r.side),
      size: r.size, price: r.price, usd: Math.round(r.usd * 100) / 100,
    })),
  };
}

function windowStats(symbol, ms) {
  const since = Date.now() - ms;
  const r = db.prepare(`
    SELECT
      COUNT(*) n,
      ROUND(COALESCE(SUM(usd),0),2) total_usd,
      ROUND(COALESCE(SUM(CASE WHEN side='Buy'  THEN usd END),0),2) longs_usd,
      ROUND(COALESCE(SUM(CASE WHEN side='Sell' THEN usd END),0),2) shorts_usd,
      ROUND(COALESCE(MAX(usd),0),2) biggest_usd
    FROM liquidations WHERE symbol = ? AND ts >= ?
  `).get(symbol, since);
  return { events: r.n, total_usd: r.total_usd, longs_liquidated_usd: r.longs_usd,
           shorts_liquidated_usd: r.shorts_usd, biggest_print_usd: r.biggest_usd };
}

function getLiquidationStats() {
  const oldest = db.prepare('SELECT MIN(ts) t FROM liquidations').get().t;
  const out = { source: 'bybit_allLiquidation', collecting_since: oldest };
  for (const [k, sym] of Object.entries(SYMBOLS)) {
    out[k.toLowerCase()] = { '1h': windowStats(sym, 3600e3), '24h': windowStats(sym, 86400e3) };
  }
  return out;
}

module.exports = { getRecentLiquidations, getLiquidationStats };

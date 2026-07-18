// tools/micro.js — expansion: microstructure suite (4 tools).
// Bybit v5 public orderbook/trades + OKX ticker + Hyperliquid l2Book.
'use strict';
const { cached, fetchJson } = require('../lib/cache');
const { _normSym: normSym } = require('./derivs');

const BYBIT = () => process.env.BYBIT_REST || 'https://api.bybit.com';
const OKX = () => process.env.OKX_REST || 'https://www.okx.com';
const HL = () => process.env.HL_API || 'https://api.hyperliquid.xyz/info';
const okxInst = (sym) => sym.replace(/USDT$/, '') + '-USDT-SWAP';
const n = (v) => (v == null || v === '' ? null : Number(v));

async function bybit(path) {
  const j = await fetchJson(BYBIT() + path);
  if (j.retCode !== 0) throw new Error(`bybit: ${j.retMsg}`);
  return j.result;
}

const book = (sym, depth = 200) =>
  cached(`ob:${sym}`, 5_000, () => bybit(`/v5/market/orderbook?category=linear&symbol=${sym}&limit=${depth}`));

// ---- get_orderbook_imbalance ($0.01) — bid/ask notional within ±bps of mid
async function getOrderbookImbalance(p = {}) {
  const sym = normSym(p.symbol);
  const bps = Math.min(Math.max(Number(p.bps) || 50, 5), 500);
  const ob = await book(sym);
  const bestBid = parseFloat(ob.b[0][0]), bestAsk = parseFloat(ob.a[0][0]);
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid * (1 - bps / 10000), hi = mid * (1 + bps / 10000);
  const sum = (side, test) => side.reduce((s, [px, sz]) => (test(parseFloat(px)) ? s + parseFloat(px) * parseFloat(sz) : s), 0);
  const bidUsd = sum(ob.b, (px) => px >= lo);
  const askUsd = sum(ob.a, (px) => px <= hi);
  const ratio = askUsd > 0 ? bidUsd / askUsd : null;
  return {
    symbol: sym, mid_price: Number(mid.toFixed(6)), window_bps: bps,
    bid_usd: Math.round(bidUsd), ask_usd: Math.round(askUsd),
    imbalance_ratio: ratio != null ? Number(ratio.toFixed(3)) : null,
    skew: ratio == null ? null : ratio > 1.5 ? 'bid_heavy (support below)' : ratio < 0.67 ? 'ask_heavy (resistance above)' : 'balanced',
    note: 'visible resting liquidity only — spoofable, read as context not signal',
  };
}

// ---- get_orderbook_walls ($0.01) — largest resting levels per side
async function getOrderbookWalls(p = {}) {
  const sym = normSym(p.symbol);
  const top = Math.min(Math.max(parseInt(p.top) || 5, 1), 15);
  const ob = await book(sym);
  const mid = (parseFloat(ob.b[0][0]) + parseFloat(ob.a[0][0])) / 2;
  const walls = (side) =>
    side
      .map(([px, sz]) => ({ price: parseFloat(px), usd: Math.round(parseFloat(px) * parseFloat(sz)) }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, top)
      .map((w) => ({ ...w, distance_pct: Number((((w.price - mid) / mid) * 100).toFixed(3)) }));
  return { symbol: sym, mid_price: Number(mid.toFixed(6)), depth_levels: ob.b.length + ob.a.length, bid_walls: walls(ob.b), ask_walls: walls(ob.a) };
}

// ---- get_whale_trades ($0.02) — large prints from recent trade tape
async function getWhaleTrades(p = {}) {
  const sym = normSym(p.symbol);
  const minUsd = Math.max(Number(p.min_usd) || 100_000, 1_000);
  const limit = Math.min(Math.max(parseInt(p.limit) || 20, 1), 50);
  const r = await cached(`trades:${sym}`, 5_000, () => bybit(`/v5/market/recent-trade?category=linear&symbol=${sym}&limit=1000`));
  const whales = r.list
    .map((t) => ({ ts: parseInt(t.time), side: t.side, price: parseFloat(t.price), usd: Math.round(parseFloat(t.price) * parseFloat(t.size)) }))
    .filter((t) => t.usd >= minUsd);
  const buy = whales.filter((t) => t.side === 'Buy').reduce((s, t) => s + t.usd, 0);
  const sell = whales.filter((t) => t.side === 'Sell').reduce((s, t) => s + t.usd, 0);
  return {
    symbol: sym, tape_size: r.list.length, min_usd: minUsd,
    whale_count: whales.length, whale_buy_usd: buy, whale_sell_usd: sell,
    net_usd: buy - sell, dominant: buy > sell * 1.2 ? 'buyers' : sell > buy * 1.2 ? 'sellers' : 'mixed',
    trades: whales.slice(0, limit),
  };
}

// ---- get_spread_arb ($0.02) — best bid/ask across venues
async function getSpreadArb(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`spread:${sym}`, 5_000, async () => {
    const [by, ok, hl] = await Promise.all([
      bybit(`/v5/market/tickers?category=linear&symbol=${sym}`).then((r) => r.list[0]).catch(() => null),
      fetchJson(`${OKX()}/api/v5/market/ticker?instId=${okxInst(sym)}`).then((j) => (j.code === '0' ? j.data[0] : null)).catch(() => null),
      fetchJson(HL(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'l2Book', coin: sym.replace(/USDT$/, '') }) })
        .then((b) => ({ bid: n(b?.levels?.[0]?.[0]?.px), ask: n(b?.levels?.[1]?.[0]?.px) }))
        .catch(() => null),
    ]);
    const venues = {};
    if (by) venues.bybit = { bid: n(by.bid1Price), ask: n(by.ask1Price) };
    if (ok) venues.okx = { bid: n(ok.bidPx), ask: n(ok.askPx) };
    if (hl && hl.bid) venues.hyperliquid = hl;
    const names = Object.keys(venues).filter((v) => venues[v].bid && venues[v].ask);
    if (names.length < 2) throw new Error(`fewer than 2 venues quote ${sym}`);
    let best = null;
    for (const a of names) for (const b of names) {
      if (a === b) continue;
      const edge = venues[a].bid - venues[b].ask; // sell on a, buy on b
      if (!best || edge > best.edge) best = { sell_on: a, buy_on: b, edge };
    }
    const mid = (venues[names[0]].bid + venues[names[0]].ask) / 2;
    return {
      symbol: sym, venues,
      best_cross: { ...best, edge_usd_per_unit: Number(best.edge.toFixed(6)), edge_bps: Number(((best.edge / mid) * 10000).toFixed(2)) },
      note: 'gross edge, pre-fee — perp funding and fees usually eat sub-5bps gaps',
    };
  });
}

module.exports = { getOrderbookImbalance, getOrderbookWalls, getWhaleTrades, getSpreadArb };

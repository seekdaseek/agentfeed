// tools/derivs.js — expansion: derivatives suite (9 tools).
// Venues: Bybit v5 public REST (precedent: positioning.js), OKX public, Hyperliquid.
// NO Binance REST here — their ToS prohibits charging for their market data.
// All endpoints env-overridable for offline testing (same philosophy as liqcollector EP).
'use strict';
const { cached, fetchJson } = require('../lib/cache');

const BYBIT = () => process.env.BYBIT_REST || 'https://api.bybit.com';
const OKX = () => process.env.OKX_REST || 'https://www.okx.com';
const HL = () => process.env.HL_API || 'https://api.hyperliquid.xyz/info';

const SYM_RE = /^[A-Z0-9]{2,20}USDT$/;
function normSym(s) {
  const raw = String(s || 'SOLUSDT').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(raw)) throw new Error(`invalid symbol: ${s}`); // reject, never sanitize — '../etc' must not become ETCUSDT
  const sym = raw.endsWith('USDT') ? raw : raw + 'USDT';
  if (!SYM_RE.test(sym)) throw new Error(`invalid symbol: ${s}`);
  return sym;
}
const okxInst = (sym) => sym.replace(/USDT$/, '') + '-USDT-SWAP';
const baseCoin = (sym) => sym.replace(/USDT$/, '');

async function bybit(path) {
  const j = await fetchJson(BYBIT() + path);
  if (j.retCode !== 0) throw new Error(`bybit: ${j.retMsg}`);
  return j.result;
}
async function okx(path) {
  const j = await fetchJson(OKX() + path);
  if (j.code !== '0') throw new Error(`okx: ${j.msg}`);
  return j.data;
}

// all Bybit linear tickers in one call — funding, OI value, 24h change for ~600 perps
const allTickers = () =>
  cached('bybit:tickers', 30_000, async () =>
    (await bybit('/v5/market/tickers?category=linear')).list.filter((t) => /USDT$/.test(t.symbol)));

const pct = (now, then) => (then ? Math.round(((now - then) / then) * 10000) / 100 : null);
const n = (v) => (v == null || v === '' ? null : Number(v));

// ---- get_funding_cross ($0.01) — one symbol, funding across 3 venues
async function getFundingCross(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`fcross:${sym}`, 30_000, async () => {
    const [by, ok, hl] = await Promise.all([
      bybit(`/v5/market/tickers?category=linear&symbol=${sym}`).then((r) => r.list[0]).catch(() => null),
      okx(`/api/v5/public/funding-rate?instId=${okxInst(sym)}`).then((d) => d[0]).catch(() => null),
      cached('hl:ctxs', 60_000, () =>
        fetchJson(HL(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) }),
      ).then(([meta, ctxs]) => {
        const i = meta.universe.findIndex((u) => u.name === baseCoin(sym));
        return i >= 0 ? ctxs[i] : null;
      }).catch(() => null),
    ]);
    const venues = {};
    if (by) venues.bybit = { funding_rate_8h: n(by.fundingRate), next_funding_time: n(by.nextFundingTime), mark_price: n(by.markPrice) };
    if (ok) venues.okx = { funding_rate_8h: n(ok.fundingRate), next_funding_time: n(ok.nextFundingTime) };
    if (hl) venues.hyperliquid = { funding_rate_1h: n(hl.funding), funding_rate_8h_equiv: n(hl.funding) != null ? Number((n(hl.funding) * 8).toFixed(8)) : null, mark_price: n(hl.markPx) };
    if (!Object.keys(venues).length) throw new Error(`no venue lists ${sym}`);
    const rates = [venues.bybit?.funding_rate_8h, venues.okx?.funding_rate_8h, venues.hyperliquid?.funding_rate_8h_equiv].filter((x) => x != null);
    return {
      symbol: sym, venues,
      spread_8h: rates.length > 1 ? Number((Math.max(...rates) - Math.min(...rates)).toFixed(8)) : null,
      crowding: rates.length ? (rates.every((r) => r > 0) ? 'longs_pay_everywhere' : rates.every((r) => r < 0) ? 'shorts_pay_everywhere' : 'mixed') : null,
    };
  });
}

// ---- get_funding_extremes ($0.02) — most crowded trades across ~600 perps
async function getFundingExtremes(p = {}) {
  const limit = Math.min(Math.max(parseInt(p.limit) || 10, 1), 25);
  const minTurn = Number(p.min_turnover_usd) || 1_000_000;
  const list = (await allTickers())
    .filter((t) => n(t.turnover24h) >= minTurn && t.fundingRate !== '')
    .map((t) => ({
      symbol: t.symbol,
      funding_rate_8h: n(t.fundingRate),
      annualized_pct: Number((n(t.fundingRate) * 3 * 365 * 100).toFixed(2)),
      price_24h_pct: Number((n(t.price24hPcnt) * 100).toFixed(2)),
      oi_usd: Math.round(n(t.openInterestValue) || 0),
    }))
    .sort((a, b) => b.funding_rate_8h - a.funding_rate_8h);
  return {
    source: 'bybit_linear_universe', universe_size: list.length, min_turnover_usd: minTurn,
    most_positive: list.slice(0, limit),        // longs paying most — short-squeeze fuel is spent, long-flush risk
    most_negative: list.slice(-limit).reverse(), // shorts paying most — crowded shorts, squeeze candidates
  };
}

// ---- get_open_interest ($0.01) — any symbol, OI + deltas, Bybit + OKX
async function getOpenInterest(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`oi:${sym}`, 60_000, async () => {
    const [hist, tick, ok] = await Promise.all([
      bybit(`/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=1h&limit=25`),
      bybit(`/v5/market/tickers?category=linear&symbol=${sym}`).then((r) => r.list[0]),
      okx(`/api/v5/public/open-interest?instId=${okxInst(sym)}`).then((d) => d[0]).catch(() => null),
    ]);
    const o = hist.list.map((x) => parseFloat(x.openInterest));
    return {
      symbol: sym,
      bybit: { oi_base: o[0], oi_usd: Math.round(n(tick.openInterestValue)), change_1h_pct: pct(o[0], o[1]), change_24h_pct: pct(o[0], o[24]) },
      okx: ok ? { oi_base: n(ok.oiCcy), oi_usd: Math.round(n(ok.oiUsd)) } : null,
      mark_price: n(tick.markPrice),
    };
  });
}

// ---- get_oi_spike_scan ($0.02) — abnormal OI jumps across universe.
// Self-warming: snapshots recorded on use, no background load. First calls
// return warming:true until a >=30min-old snapshot exists.
const oiSnaps = []; // { at, map: symbol -> oiValueUsd }
async function getOiSpikeScan(p = {}) {
  const limit = Math.min(Math.max(parseInt(p.limit) || 10, 1), 25);
  const list = await allTickers();
  const nowMap = {};
  for (const t of list) if (n(t.openInterestValue) > 0) nowMap[t.symbol] = n(t.openInterestValue);
  const now = Date.now();
  if (!oiSnaps.length || now - oiSnaps[oiSnaps.length - 1].at > 5 * 60_000) oiSnaps.push({ at: now, map: nowMap });
  while (oiSnaps.length > 30) oiSnaps.shift();
  const base = oiSnaps.find((s) => now - s.at >= 30 * 60_000);
  if (!base) {
    const oldest = oiSnaps[0];
    return { warming: true, ready_in_min: Math.max(1, Math.ceil(30 - (now - oldest.at) / 60_000)), note: 'spike baseline builds from first call after boot; retry shortly' };
  }
  const rows = [];
  for (const [sym, oiNow] of Object.entries(nowMap)) {
    const oiThen = base.map[sym];
    if (!oiThen || oiNow < 3_000_000) continue; // ignore dust markets
    const chg = pct(oiNow, oiThen);
    if (chg != null) rows.push({ symbol: sym, oi_usd: Math.round(oiNow), oi_change_pct: chg });
  }
  rows.sort((a, b) => Math.abs(b.oi_change_pct) - Math.abs(a.oi_change_pct));
  const tickBySym = Object.fromEntries(list.map((t) => [t.symbol, t]));
  return {
    source: 'bybit_linear_universe',
    baseline_min_ago: Math.round((now - base.at) / 60_000),
    spikes: rows.slice(0, limit).map((r) => ({ ...r, funding_rate_8h: n(tickBySym[r.symbol]?.fundingRate), price_24h_pct: Number((n(tickBySym[r.symbol]?.price24hPcnt) * 100).toFixed(2)) })),
  };
}

// ---- get_long_short ($0.01) — any symbol account L/S ratio + trend
async function getLongShort(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`ls:${sym}`, 60_000, async () => {
    const r = await bybit(`/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&limit=25`);
    if (!r.list?.length) throw new Error(`no L/S data for ${sym}`);
    const at = (i) => (r.list[i] ? Math.round(parseFloat(r.list[i].buyRatio) * 10000) / 100 : null);
    return {
      symbol: sym, source: 'bybit_v5_public', period: '1h',
      long_pct: at(0), short_pct: r.list[0] ? Math.round(parseFloat(r.list[0].sellRatio) * 10000) / 100 : null,
      long_pct_1h_ago: at(1), long_pct_24h_ago: at(24),
      ts: parseInt(r.list[0].timestamp),
    };
  });
}

// ---- get_basis ($0.01) — perp premium/discount vs spot
async function getBasis(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`basis:${sym}`, 30_000, async () => {
    const [perp, spot] = await Promise.all([
      bybit(`/v5/market/tickers?category=linear&symbol=${sym}`).then((r) => r.list[0]),
      bybit(`/v5/market/tickers?category=spot&symbol=${sym}`).then((r) => r.list[0]).catch(() => null),
    ]);
    if (!spot) throw new Error(`no spot pair for ${sym} on bybit`);
    const mark = n(perp.markPrice), sp = n(spot.lastPrice);
    const basisPct = Number((((mark - sp) / sp) * 100).toFixed(4));
    return {
      symbol: sym, mark_price: mark, spot_price: sp,
      basis_pct: basisPct,
      state: basisPct > 0.05 ? 'contango (perp premium — longs aggressive)' : basisPct < -0.05 ? 'backwardation (perp discount — shorts aggressive)' : 'flat',
      funding_rate_8h: n(perp.fundingRate),
    };
  });
}

// ---- get_volatility ($0.01) — realized vol from daily klines
async function getVolatility(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`vol:${sym}`, 300_000, async () => {
    const r = await bybit(`/v5/market/kline?category=linear&symbol=${sym}&interval=D&limit=31`);
    const closes = r.list.map((k) => parseFloat(k[4])).reverse(); // API returns newest-first
    if (closes.length < 8) throw new Error(`not enough kline history for ${sym}`);
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const rv = (arr) => {
      const m = arr.reduce((s, x) => s + x, 0) / arr.length;
      const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
      return Number((Math.sqrt(v) * Math.sqrt(365) * 100).toFixed(2));
    };
    const last = r.list[0];
    return {
      symbol: sym, source: 'bybit_daily_klines',
      realized_vol_7d_ann_pct: rv(rets.slice(-7)),
      realized_vol_30d_ann_pct: rv(rets),
      today_range_pct: Number((((parseFloat(last[2]) - parseFloat(last[3])) / parseFloat(last[4])) * 100).toFixed(2)),
    };
  });
}

// ---- get_funding_history ($0.005) — funding trend for a symbol
async function getFundingHistory(p = {}) {
  const sym = normSym(p.symbol);
  const limit = Math.min(Math.max(parseInt(p.limit) || 30, 1), 200);
  return cached(`fhist:${sym}:${limit}`, 300_000, async () => {
    const r = await bybit(`/v5/market/funding/history?category=linear&symbol=${sym}&limit=${limit}`);
    const rows = r.list.map((x) => ({ ts: parseInt(x.fundingRateTimestamp), rate_8h: n(x.fundingRate) }));
    const avg = rows.length ? rows.reduce((s, x) => s + x.rate_8h, 0) / rows.length : null;
    return {
      symbol: sym, intervals: rows.length,
      avg_rate_8h: avg != null ? Number(avg.toFixed(8)) : null,
      avg_annualized_pct: avg != null ? Number((avg * 3 * 365 * 100).toFixed(2)) : null,
      positive_share_pct: rows.length ? Math.round((rows.filter((x) => x.rate_8h > 0).length / rows.length) * 100) : null,
      history: rows,
    };
  });
}

// ---- get_top_movers ($0.01) — 24h gainers/losers with liquidity floor
async function getTopMovers(p = {}) {
  const limit = Math.min(Math.max(parseInt(p.limit) || 10, 1), 25);
  const minTurn = Number(p.min_turnover_usd) || 1_000_000;
  const list = (await allTickers())
    .filter((t) => n(t.turnover24h) >= minTurn)
    .map((t) => ({
      symbol: t.symbol,
      price: n(t.lastPrice),
      change_24h_pct: Number((n(t.price24hPcnt) * 100).toFixed(2)),
      turnover_24h_usd: Math.round(n(t.turnover24h)),
      funding_rate_8h: n(t.fundingRate),
    }))
    .sort((a, b) => b.change_24h_pct - a.change_24h_pct);
  return {
    source: 'bybit_linear_universe', universe_size: list.length, min_turnover_usd: minTurn,
    gainers: list.slice(0, limit),
    losers: list.slice(-limit).reverse(),
  };
}

module.exports = {
  getFundingCross, getFundingExtremes, getOpenInterest, getOiSpikeScan,
  getLongShort, getBasis, getVolatility, getFundingHistory, getTopMovers,
  _normSym: normSym,
};

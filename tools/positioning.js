// Positioning data: long/short account ratio + open interest (Bybit v5 public REST)
const BASE = 'https://api.bybit.com';
const SYMBOLS = { SOL: 'SOLUSDT', BTC: 'BTCUSDT' };

async function bybit(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`bybit ${res.status}`);
  const j = await res.json();
  if (j.retCode !== 0) {
    const e = new Error(`bybit: ${j.retMsg}`);
    // retCode 10001 = Bybit rejected the PARAMETERS on an HTTP 200, i.e. the
    // caller named something Bybit does not list -> 400, not 502. Every other
    // retCode and every transport failure stays 502. Full rationale in
    // tools/derivs.js, which carries the measured retMsg variants.
    // getPositioning() takes no caller symbol today (it is pinned to SOL and
    // BTC), so this cannot fire from user input yet; it is tagged so the three
    // Bybit helpers classify identically if it ever does.
    if (j.retCode === 10001) e.upstreamParamError = true;
    throw e;
  }
  return j.result;
}

function pct(now, then) {
  if (!then) return null;
  return Math.round(((now - then) / then) * 10000) / 100;
}

async function onePair(sym) {
  const [ratio, oi, tick] = await Promise.all([
    bybit(`/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&limit=2`),
    bybit(`/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=1h&limit=25`),
    bybit(`/v5/market/tickers?category=linear&symbol=${sym}`),
  ]);

  const r0 = ratio.list[0], r1 = ratio.list[1];
  const o = oi.list.map(x => parseFloat(x.openInterest));
  const t = tick.list[0];

  return {
    long_short_ratio: {
      long_pct: Math.round(parseFloat(r0.buyRatio) * 10000) / 100,
      short_pct: Math.round(parseFloat(r0.sellRatio) * 10000) / 100,
      long_pct_prev_hour: r1 ? Math.round(parseFloat(r1.buyRatio) * 10000) / 100 : null,
      ts: parseInt(r0.timestamp),
    },
    open_interest: {
      base: o[0],
      usd: Math.round(parseFloat(t.openInterestValue)),
      change_1h_pct: pct(o[0], o[1]),
      change_24h_pct: pct(o[0], o[24]),
    },
  };
}

async function getPositioning() {
  const [sol, btc] = await Promise.all([onePair(SYMBOLS.SOL), onePair(SYMBOLS.BTC)]);
  return { source: 'bybit_v5_public', period: '1h', sol, btc };
}

module.exports = { getPositioning };

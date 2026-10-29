// test/helpers/brief-world.js: a synthetic, seeded market for the pensio briefs. Nothing here comes from agentfeed.db, the box or an exchange: every
// number is generated. makeWorld() returns a `deps` object shaped like tools/briefs/sources.js `real`, so a brief runs on it with no files and no network.
'use strict';

const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = (rng) => { const u = Math.max(rng(), 1e-12), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

const MAJORS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const START = { BTC: 70000, ETH: 3500, SOL: 160, HYPE: 40 };
const SIGMA = 0.0012;              // per 5-minute step: about 0.4% an hour

/**
 * opts: { now, seed, extra (n more coins), lagS (age of the newest sample), sampler: 'ok'|'stale'|'empty', gapAt: [offsetS], tape: 'ok'|'stale'|'missing',
 *   radar: 'ok'|'stale', radarMissing: ['SOL'], macro: 'ok'|'missing', events: [{type,title,utc}], fg: number|null, noClusters,
 *   shock: { COIN: { markPct, oiPct, steps } }   a step change spread over the newest `steps` samples (default 1)
 *   funding: { COIN: z }, liq: { COIN: { lastHourUsd, longsShare, eightHourUsd } }, spikes: [{ coin, oi_change_1h_pct, spike_z, ... }] }
 */
function makeWorld(opts = {}) {
  const o = { seed: 7, extra: 20, lagS: 60, sampler: 'ok', tape: 'ok', radar: 'ok', macro: 'ok', fg: 31, ...opts };
  if (!o.now) throw new Error('makeWorld needs now');
  const rng = mulberry32(o.seed);
  const names = [...MAJORS, ...Array.from({ length: o.extra }, (_, i) => `C${String(i).padStart(2, '0')}`)];
  const lastTs = Math.floor(o.now / 1000 / 300) * 300 - (o.sampler === 'stale' ? 3600 : 0) - Math.floor(o.lagS / 300) * 300;
  const N = 7 * 288;
  const series = new Map();
  for (const [ci, c] of names.entries()) {
    let mark = START[c] || 1 + ci, oi = 1e6 / mark * (1 + ci) * 50 + 2e6 / mark;
    const rows = [];
    const sh = (o.shock || {})[c];
    for (let i = N - 1; i >= 0; i--) {
      rows.push({ ts: lastTs - i * 300, oi, mark, funding: 0.0000125 * (1 + 0.3 * gauss(rng)) });
      mark *= 1 + SIGMA * gauss(rng); oi *= 1 + 0.0008 * gauss(rng);
    }
    if (sh) {
      const steps = sh.steps || 1;
      for (let k = 0; k < steps; k++) {
        const f = (k + 1) / steps;
        const row = rows[rows.length - steps + k];
        const m0 = rows[rows.length - steps - 1];
        row.mark = m0.mark * (1 + (sh.markPct || 0) / 100 * f);
        row.oi = m0.oi * (1 + (sh.oiPct || 0) / 100 * f);
      }
    }
    series.set(c, rows);
  }
  const rowAt = (c, ts) => { const rs = series.get(c); let best = null; for (let i = rs.length - 1; i >= 0; i--) { if (rs[i].ts <= ts) { best = rs[i]; break; } } return best; };
  const snap = (ts) => { const m = new Map(); for (const c of names) { const r = rowAt(c, ts); if (r) m.set(c, { coin: c, ...r }); } return m; };
  const gone = (what) => Object.assign(new Error(`${what} Not charged.`), { status: 503, retryAfter: 300 });

  const deps = {
    oiWindow(nowMs, offsets) {
      if (o.sampler === 'empty') throw gone('our Hyperliquid open-interest sampler has no data.');
      if (o.sampler === 'stale') throw gone('our Hyperliquid open-interest sampler has not written for 60 minutes (limit 15).');
      const back = {};
      for (const off of offsets) back[off] = (o.gapAt || []).includes(off) ? null : snap(lastTs - off);
      return { value: { last_ts: lastTs, cur: snap(lastTs), back, first_ts: lastTs - N * 300 }, as_of_ms: lastTs * 1000, name: 'AgentFeed Hyperliquid sampler (mark, open interest in coin units, funding, every 5 minutes)' };
    },
    oiSeries(coin, secs, nowMs) { const rs = series.get(coin) || []; const lo = Math.floor(nowMs / 1000) - secs; return rs.filter((r) => r.ts >= lo); },
    tapeAsOf() {
      if (o.tape === 'missing') throw new Error('the liquidation tape is not readable');
      return { value: o.tape === 'stale' ? o.now - 3 * 3600_000 : o.now - 40_000, as_of_ms: o.tape === 'stale' ? o.now - 3 * 3600_000 : o.now - 40_000, name: 'AgentFeed liquidation tape (Bybit, OKX, Binance prints; sums and extremes only)' };
    },
    liqBuckets(sym, hours, bucketMin) {
      const coin = sym.replace(/USDT$/, '');
      const cfg = (o.liq || {})[coin];
      const bms = bucketMin * 60_000;
      const out = [];
      const r2 = mulberry32(o.seed + coin.length * 131 + coin.charCodeAt(0));
      const first = Math.floor((o.now - hours * 3600_000) / bms) * bms;
      for (let t = first; t <= o.now; t += bms) {
        const base = (bucketMin / 60) * (o.bg ?? 20_000) * (0.5 + r2());       // about $20k an hour of liquidations, every hour (o.bg to change)
        let total = base, longsShare = 0.5;
        if (cfg && t >= o.now - (cfg.windowH || 1) * 3600_000) { total += (cfg.lastHourUsd * (bucketMin / 60)) * (cfg.windowH ? 1 / cfg.windowH : 1); longsShare = cfg.longsShare ?? 0.5; }
        out.push({ bucket: t, prints: 3, usd_total: Math.round(total), longs_usd: Math.round(total * longsShare), shorts_usd: Math.round(total * (1 - longsShare)), biggest_print: Math.round(total / 2) });
      }
      return out;
    },
    liqBaseline() { const m = new Map(); for (const c of names) m.set(`${c}USDT`, { median: o.baseline ?? 20_000, mad: 8_000 }); return m; },
    clusters(sym, mark) {
      if (o.noClusters) return { above: null, below: null };
      return { above: { price_low: mark * 1.016, price_high: mark * 1.02, usd: 4_200_000, longs_usd: 1e6, shorts_usd: 3.2e6, distance_pct: 1.8 }, below: { price_low: mark * 0.96, price_high: mark * 0.97, usd: 2_100_000, longs_usd: 2e6, shorts_usd: 1e5, distance_pct: -3.5 } };
    },
    macroDay(nowMs) {
      if (o.macro === 'missing') throw new Error('the macro calendar has not been built');
      const evs = (o.events || []).map((e) => ({ source_url: 'https://example.invalid/calendar', ...e }));
      return { value: { events: evs.filter((e) => e.utc.slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10)), all: evs }, as_of_ms: nowMs - 3600_000, name: 'AgentFeed macro calendar (Federal Reserve, BLS and BEA pages)' };
    },
    fearGreed() { if (o.fg == null) throw new Error('alternative.me 503'); return { value: { value: o.fg, classification: o.fg <= 25 ? 'Extreme Fear' : o.fg >= 75 ? 'Extreme Greed' : 'Fear' }, as_of_ms: o.now - 6 * 3600_000, name: 'alternative.me Fear & Greed Index' }; },
    radarRow(sym, nowMs) {
      const coin = sym.replace(/USDT$/, '');
      if (o.radar === 'stale') throw new Error('funding radar snapshot is 1900s old (limit 900s)');
      if ((o.radarMissing || []).includes(coin)) throw new Error(`${sym} is not in the funding radar`);
      const z = (o.funding || {})[coin] ?? 0.4;
      return { value: { symbol: sym, venues: { hyperliquid: { funding_rate_8h: 0.0001 * z, z_30d: z, samples: 90 } }, max_abs_z: Math.abs(z) }, as_of_ms: nowMs - 120_000, name: 'AgentFeed funding radar snapshot (30-day z-scores)' };
    },
    radarAll(nowMs) {
      if (o.radar === 'stale') throw new Error('funding radar snapshot is 1900s old (limit 900s)');
      const rows = Object.entries(o.funding || {}).map(([coin, z]) => ({ symbol: `${coin}USDT`, coin, oi_usd: 50_000_000, max_abs_z: Math.abs(z), venues: { hyperliquid: { funding_rate_8h: 0.0001 * z, z_30d: z, samples: 90 } } }));
      return { value: { rows, universe: { total: 337 }, matched: rows.length }, as_of_ms: nowMs - 120_000, name: 'AgentFeed funding radar snapshot (30-day z-scores)' };
    },
    spikes(nowMs) {
      if (o.spikes === 'warming') throw Object.assign(new Error('oi-spike-scan: our open-interest record covers 3.0 of the 24 hours it needs. Not charged.'), { status: 503 });
      const rows = (o.spikes || []).map((s) => ({ symbol: `${s.coin}USDT`, oi_usd: 40_000_000, oi_change_4h_pct: 0, oi_change_24h_pct: 0, price_change_1h_pct: 0.2, funding_rate_8h: 0.0001, ...s }));
      return { value: { spikes: rows, coins_scanned: 74, min_oi_usd: 3e6, as_of: new Date(lastTs * 1000).toISOString() }, as_of_ms: lastTs * 1000, name: 'AgentFeed open-interest spike scan' };
    },
  };
  return { deps, names, lastTs, series };
}

/** a calibration document with the shape bin/brief-calibrate.js writes, for the coins given */
function makeCalibration(now, coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'C00', 'C01'], over = {}) {
  const t = (n, nP, sP, eP) => ({ n, q_notable: 0.99, q_sharp: 0.998, extreme_basis: 'sample_max', notable_pct: nP, sharp_pct: sP, extreme_pct: eP, from: '2026-10-01T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z' });
  const doc = { source: 'Hyperliquid info API, candleSnapshot (https://api.hyperliquid.xyz/info)', docs: ['https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint'], fetched_at: new Date(now - 2 * 86400_000).toISOString(),
    min_exceedances: 10, coins: {}, errors: [] };
  for (const c of coins) doc.coins[c] = { '5m': t(4999, 0.4, 0.8, 3), '1h': t(4999, 1.5, 2.4, 6), '4h': t(4998, 3, 5, 12) };
  return { value: { ...doc, ...over }, as_of_ms: Date.parse((over.fetched_at) || doc.fetched_at), name: 'Hyperliquid candle tails (test)' };
}

module.exports = { makeWorld, makeCalibration, MAJORS, mulberry32 };

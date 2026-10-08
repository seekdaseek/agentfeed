// tools/options.js — the options desk: implied volatility, skew, max pain and
// gamma exposure per underlying, from Deribit's public market data.
//
// Same shape as tools/fundingradar.js:
//   collect()             cron, every 5 min (bin/options-collect.js). The only
//                         code here that calls Deribit. Writes iv history to
//                         options.db and an atomic snapshot to options.json.
//   getOptionsSummary()   the paid routes. Read the snapshot, never Deribit. A
//   getOptionsGex()       snapshot older than STALE_AFTER_S throws a 503, which
//                         lib/tool.js answers as 503, so the call never settles.
//
// Underlyings: BTC and ETH (inverse, currency=BTC / ETH) and every USDC-settled
// underlying with at least MIN_OI_USD of option open interest (currency=USDC:
// SOL_USDC, XRP_USDC, HYPE_USDC and others, measured 2026-10-08).
//
// Greeks are Black-76 on each instrument's own underlying_price (the forward
// Deribit quotes for that expiry) and Deribit's mark_iv, r = 0. Checked against
// Deribit's public/ticker greeks before first deploy (see the change log).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = () => process.env.OPTIONS_DB || path.join(ROOT, 'options.db');
const SNAP_PATH = () => process.env.OPTIONS_SNAPSHOT || path.join(ROOT, 'options.json');
const DERIBIT = () => process.env.DERIBIT_REST || 'https://www.deribit.com/api/v2/public/';

const YEAR_MS = 365 * 86_400_000;
const STALE_AFTER_S = 15 * 60;
const MIN_OI_USD = 25_000_000;          // a USDC underlying needs this much option OI to be listed
const GEX_BAND = 0.30;                  // strikes within ±30% of spot in the per-strike gamma table
const FLIP_RANGE = 0.20;                // flip level searched within ±20% of spot
const DVOL_CURRENCIES = ['BTC', 'ETH']; // Deribit publishes DVOL only for these (checked 2026-10-08)
const GEX_CONVENTION = 'dealer-sign convention: dealers are assumed long the calls and short the puts that customers hold the other side of, so call gamma counts positive and put gamma negative. Actual dealer positioning is not observable from public data; read net GEX as a structural estimate, not a measurement.';

// ---- math (pure, unit-tested) ------------------------------------------------
const SQRT2PI = Math.sqrt(2 * Math.PI);
const npdf = (x) => Math.exp(-0.5 * x * x) / SQRT2PI;
function ncdf(x) { // Abramowitz-Stegun 26.2.17 via erf, |error| < 7.5e-8
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = npdf(x);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
/** Black-76 delta and gamma on a forward F, strike K, vol sigma (decimal), T years, r = 0. */
function greeks(F, K, sigma, T, isCall) {
  if (!(F > 0 && K > 0 && sigma > 0 && T > 0)) return { delta: null, gamma: null };
  const sT = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sT;
  return { delta: isCall ? ncdf(d1) : ncdf(d1) - 1, gamma: npdf(d1) / (F * sT) };
}
/** Linear interpolation of y at x over points sorted by x; null outside the range. */
function interp(points, x) {
  const p = points.filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])).sort((a, b) => a[0] - b[0]);
  if (p.length < 2 || x < p[0][0] || x > p[p.length - 1][0]) return null;
  for (let i = 1; i < p.length; i++) {
    if (x <= p[i][0]) {
      const [x0, y0] = p[i - 1], [x1, y1] = p[i];
      return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return null;
}
/** Max pain: the settlement price (from the expiry's strikes) minimising total intrinsic value paid to holders. */
function maxPain(opts) {
  const strikes = [...new Set(opts.map((o) => o.strike))].sort((a, b) => a - b);
  let best = null;
  for (const S of strikes) {
    let pay = 0;
    for (const o of opts) pay += o.oi * (o.isCall ? Math.max(S - o.strike, 0) : Math.max(o.strike - S, 0));
    if (!best || pay < best.payout) best = { price: S, payout: pay };
  }
  return best;
}
/** Net GEX (USD per 1% move) at a hypothetical spot S', every forward shifted in proportion. */
function gexAt(opts, spot, S2) {
  let g = 0;
  for (const o of opts) {
    const F2 = o.forward * (S2 / spot);
    const { gamma } = greeks(F2, o.strike, o.iv, o.T, o.isCall);
    if (gamma == null) continue;
    g += (o.isCall ? 1 : -1) * gamma * o.oi * S2 * S2 * 0.01;
  }
  return g;
}
/** Zero crossing of net GEX nearest to spot within ±FLIP_RANGE, or null. */
function flipLevel(opts, spot, steps = 80) {
  let prev = null, best = null;
  for (let i = 0; i <= steps; i++) {
    const S2 = spot * (1 - FLIP_RANGE + (2 * FLIP_RANGE * i) / steps);
    const g = gexAt(opts, spot, S2);
    if (prev && Math.sign(prev.g) !== Math.sign(g) && g !== 0) {
      const x = prev.S + ((0 - prev.g) * (S2 - prev.S)) / (g - prev.g);
      if (!best || Math.abs(x - spot) < Math.abs(best - spot)) best = x;
    }
    prev = { S: S2, g };
  }
  return best;
}

// ---- per-underlying analytics (pure) ------------------------------------------
const round = (v, d) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/** opts: [{name, expiry(ms), strike, isCall, iv(decimal), forward, oi(coin), vol24(coin), markUsd}] */
function analyse(underlying, opts, spot, now) {
  const live = opts.filter((o) => o.expiry > now).map((o) => ({ ...o, T: (o.expiry - now) / YEAR_MS }));
  for (const o of live) Object.assign(o, greeks(o.forward, o.strike, o.iv, o.T, o.isCall));
  const byExp = new Map();
  for (const o of live) { if (!byExp.has(o.expiry)) byExp.set(o.expiry, []); byExp.get(o.expiry).push(o); }
  const expiries = [...byExp.keys()].sort((a, b) => a - b);

  // term structure: ATM IV at the forward (OTM side of each strike, interpolated in
  // log-moneyness), 25-delta risk reversal and butterfly from the delta smile
  const term = [];
  for (const e of expiries) {
    const os = byExp.get(e).filter((o) => o.iv > 0);
    const F = median(os.map((o) => o.forward));
    const otm = os.filter((o) => (o.isCall ? o.strike >= F : o.strike <= F)).map((o) => [Math.log(o.strike / F), o.iv]);
    const atm = interp(otm, 0);
    const calls = os.filter((o) => o.isCall && o.delta > 0.02 && o.delta < 0.98).map((o) => [o.delta, o.iv]);
    const puts = os.filter((o) => !o.isCall && o.delta < -0.02 && o.delta > -0.98).map((o) => [o.delta, o.iv]);
    const c25 = interp(calls, 0.25), p25 = interp(puts, -0.25);
    term.push({
      expiry: new Date(e).toISOString(), days: round((e - now) / 86_400_000, 2), forward: round(F, 6),
      atm_iv: round(atm != null ? atm * 100 : null, 2),
      rr25: round(c25 != null && p25 != null ? (c25 - p25) * 100 : null, 2),
      bf25: round(c25 != null && p25 != null && atm != null ? ((c25 + p25) / 2 - atm) * 100 : null, 2),
      iv25_call: round(c25 != null ? c25 * 100 : null, 2), iv25_put: round(p25 != null ? p25 * 100 : null, 2),
    });
  }
  // 30-day constant-maturity ATM IV: total variance interpolated linearly in time
  const pts = term.filter((t) => t.atm_iv != null).map((t) => [t.days / 365, (t.atm_iv / 100) ** 2 * (t.days / 365)]);
  const w30 = interp(pts, 30 / 365);
  const iv30 = w30 != null && w30 > 0 ? Math.sqrt(w30 / (30 / 365)) * 100 : null;

  let callOi = 0, putOi = 0, callVol = 0, putVol = 0;
  for (const o of live) { if (o.isCall) { callOi += o.oi; callVol += o.vol24; } else { putOi += o.oi; putVol += o.vol24; } }
  const pains = expiries.slice(0, 3).map((e) => { const mp = maxPain(byExp.get(e)); return { expiry: new Date(e).toISOString(), max_pain: mp ? mp.price : null, intrinsic_paid_at_max_pain_usd: mp ? Math.round(mp.payout) : null }; });

  const strikeAgg = new Map();
  for (const o of live) {
    const s = strikeAgg.get(o.strike) || { strike: o.strike, call_oi: 0, put_oi: 0, call_gex: 0, put_gex: 0 };
    const g = o.gamma == null ? 0 : o.gamma * o.oi * spot * spot * 0.01;
    if (o.isCall) { s.call_oi += o.oi; s.call_gex += g; } else { s.put_oi += o.oi; s.put_gex -= g; }
    strikeAgg.set(o.strike, s);
  }
  const strikes = [...strikeAgg.values()];
  const top = strikes.map((s) => ({ strike: s.strike, call_oi: round(s.call_oi, 4), put_oi: round(s.put_oi, 4), total_oi: round(s.call_oi + s.put_oi, 4), total_oi_usd: Math.round((s.call_oi + s.put_oi) * spot) }))
    .sort((a, b) => b.total_oi - a.total_oi).slice(0, 10);
  const band = strikes.filter((s) => Math.abs(s.strike / spot - 1) <= GEX_BAND).sort((a, b) => a.strike - b.strike)
    .map((s) => ({ strike: s.strike, call_gex_usd: Math.round(s.call_gex), put_gex_usd: Math.round(s.put_gex), net_gex_usd: Math.round(s.call_gex + s.put_gex) }));
  const callWall = strikes.reduce((a, s) => (s.call_gex > (a?.call_gex ?? 0) ? s : a), null);
  const putWall = strikes.reduce((a, s) => (s.put_gex < (a?.put_gex ?? 0) ? s : a), null);
  const netGex = strikes.reduce((t, s) => t + s.call_gex + s.put_gex, 0);

  return {
    summary: {
      term_structure: term,
      iv30_atm: round(iv30, 2),
      put_call_ratio: { by_open_interest: round(callOi ? putOi / callOi : null, 3), by_volume_24h: round(callVol ? putVol / callVol : null, 3) },
      open_interest: { calls: round(callOi, 4), puts: round(putOi, 4), total: round(callOi + putOi, 4), total_usd: Math.round((callOi + putOi) * spot), unit: underlying.coin },
      max_pain: pains,
      top_strikes_by_oi: top,
      instruments: live.length,
    },
    gex: {
      convention: GEX_CONVENTION,
      units: 'USD change in dealer delta for a 1% move in the underlying (gamma x open interest x spot^2 x 0.01), summed over every live expiry',
      net_gex_usd_per_1pct: Math.round(netGex),
      regime: netGex > 0 ? 'positive gamma (dealers dampen moves under the convention)' : 'negative gamma (dealers amplify moves under the convention)',
      flip_level: round(flipLevel(live, spot), 6),
      flip_note: `net GEX recomputed across spot ±${FLIP_RANGE * 100}% with each forward shifted in proportion and IV held; null means no sign change in that range`,
      call_wall: callWall ? { strike: callWall.strike, call_gex_usd: Math.round(callWall.call_gex) } : null,
      put_wall: putWall ? { strike: putWall.strike, put_gex_usd: Math.round(putWall.put_gex) } : null,
      by_strike: band,
      by_strike_band: `strikes within ±${GEX_BAND * 100}% of spot`,
    },
  };
}
function median(xs) { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }

// ---- Deribit (collector only) -----------------------------------------------------
async function deribit(method, params) {
  const url = DERIBIT() + method + '?' + new URLSearchParams(params).toString();
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'agentfeed-options/1.0 (+https://x402.ochinimus.app)' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`deribit ${method}: ${r.status} ${j.error ? j.error.code + ' ' + j.error.message : ''}`);
  return j.result;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function openDb() {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH());
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS iv_history (underlying TEXT NOT NULL, ts INTEGER NOT NULL, spot REAL, dvol REAL, iv30 REAL,
    total_oi_usd REAL, PRIMARY KEY (underlying, ts)) WITHOUT ROWID;`);
  return db;
}
function change24h(db, u, field, now, value) {
  if (value == null) return { change_24h: null, note: 'no current value' };
  const row = db.prepare(`SELECT ts, ${field} v FROM iv_history WHERE underlying = ? AND ts BETWEEN ? AND ? AND ${field} IS NOT NULL ORDER BY ABS(ts - ?) LIMIT 1`)
    .get(u, now - 86_400_000 - 1_800_000, now - 86_400_000 + 1_800_000, now - 86_400_000);
  if (!row) {
    const first = db.prepare('SELECT MIN(ts) t FROM iv_history WHERE underlying = ?').get(u).t;
    return { change_24h: null, note: `our history for this underlying starts ${first ? new Date(first).toISOString() : 'now'}; a 24h change needs a reading from 24h ago (±30 min)` };
  }
  return { change_24h: round(value - row.v, 2), compared_with: new Date(row.ts).toISOString() };
}

async function collect({ now = Date.now(), log = () => {} } = {}) {
  const t0 = Date.now();
  const db = openDb();
  const books = {}, insts = {};
  for (const cur of ['BTC', 'ETH', 'USDC']) {
    books[cur] = await deribit('get_book_summary_by_currency', { currency: cur, kind: 'option' });
    await pause(250);
    insts[cur] = await deribit('get_instruments', { currency: cur, kind: 'option', expired: 'false' });
    await pause(1200); // get_instruments costs 10,000 credits; ~1/s sustained
  }
  const meta = new Map();
  for (const cur of Object.keys(insts)) for (const i of insts[cur]) meta.set(i.instrument_name, i);
  // group by underlying: BTC, ETH, SOL_USDC -> SOL, ...
  const groups = new Map();
  for (const cur of Object.keys(books)) {
    for (const b of books[cur]) {
      const m = meta.get(b.instrument_name);
      if (!m || !(b.mark_iv > 0)) continue;
      const base = b.instrument_name.split('-')[0];
      const coin = base.replace(/_USDC$/, '');
      const g = groups.get(coin) || { coin, settlements: new Set(), opts: [] };
      g.settlements.add(cur === 'USDC' ? 'linear USDC-settled' : `inverse ${cur}-settled`);
      g.opts.push({
        name: b.instrument_name, expiry: m.expiration_timestamp, strike: m.strike, isCall: m.option_type === 'call',
        iv: b.mark_iv / 100, forward: b.underlying_price, oi: b.open_interest || 0, vol24: b.volume || 0,
      });
      groups.set(coin, g);
    }
  }
  const dvols = {};
  for (const c of DVOL_CURRENCIES) {
    const d = await deribit('get_volatility_index_data', { currency: c, start_timestamp: now - 26 * 3_600_000, end_timestamp: now, resolution: 3600 });
    const pts = (d && d.data) || [];
    dvols[c] = pts;
    await pause(250);
  }
  const out = [];
  for (const g of groups.values()) {
    // Spot is Deribit's own index for the underlying; the forwards carry each
    // expiry's basis, so their median is only the fallback, and says so.
    const indexName = ['BTC', 'ETH'].includes(g.coin) ? `${g.coin.toLowerCase()}_usd` : `${g.coin.toLowerCase()}_usdc`;
    let spot = null, spotNote;
    try { spot = (await deribit('get_index_price', { index_name: indexName })).index_price; spotNote = `Deribit index ${indexName}`; } catch (e) { log(`index ${indexName}: ${e.message}`); }
    if (!(spot > 0)) { spot = median(g.opts.map((o) => o.forward)); spotNote = `median of this underlying's option forwards (Deribit index ${indexName} unavailable)`; }
    await pause(120);
    if (!spot) continue;
    const oiUsd = g.opts.reduce((t, o) => t + o.oi * spot, 0);
    if (!['BTC', 'ETH'].includes(g.coin) && oiUsd < MIN_OI_USD) continue;
    const a = analyse({ coin: g.coin }, g.opts, spot, now);
    let vol;
    const pts = dvols[g.coin];
    if (pts && pts.length) {
      // "now" is Deribit's live DVOL index; the hourly series only supplies the
      // value 24h ago. (An hourly bar's close is its latest value while the bar
      // is open, so labelling it with the bar's start time would misdate it.)
      let nowVal = null, nowAt = now;
      try { nowVal = (await deribit('get_index_price', { index_name: `${g.coin.toLowerCase()}dvol_usdc` })).index_price; } catch (e) { log(`dvol index ${g.coin}: ${e.message}`); }
      if (!(nowVal > 0)) { const last = pts[pts.length - 1]; nowVal = last[4]; nowAt = last[0]; }
      const prev = pts.find((p) => Math.abs(p[0] - (now - 86_400_000)) <= 1_800_000);
      vol = { kind: 'deribit_dvol', value: nowVal, as_of: new Date(nowAt).toISOString(), change_24h: prev ? round(nowVal - prev[4], 2) : null, ...(prev ? { compared_with: new Date(prev[0]).toISOString() } : {}), source: `Deribit DVOL: live index ${g.coin.toLowerCase()}dvol_usdc, 24h change against public/get_volatility_index_data hourly` };
    } else {
      const ch = change24h(db, g.coin, 'iv30', now, a.summary.iv30_atm);
      vol = { kind: 'agentfeed_iv30', value: a.summary.iv30_atm, ...ch, source: 'computed by AgentFeed: 30-day constant-maturity ATM implied volatility from Deribit mark IV (Deribit publishes no DVOL for this underlying)' };
    }
    db.prepare('INSERT OR REPLACE INTO iv_history (underlying, ts, spot, dvol, iv30, total_oi_usd) VALUES (?, ?, ?, ?, ?, ?)')
      .run(g.coin, now, spot, vol.kind === 'deribit_dvol' ? vol.value : null, a.summary.iv30_atm, a.summary.open_interest.total_usd);
    out.push({ underlying: g.coin, venue: 'deribit', settlement: [...g.settlements].sort().join(' + '), spot: round(spot, 6), spot_note: spotNote, volatility_index: vol, ...a });
  }
  db.prepare('DELETE FROM iv_history WHERE ts < ?').run(now - 45 * 86_400_000);
  db.close();
  const snap = { version: 1, as_of: new Date(now).toISOString(), as_of_ms: now, source: 'Deribit public API (get_book_summary_by_currency, get_instruments, get_volatility_index_data)', underlyings: out };
  const tmp = SNAP_PATH() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snap));
  fs.renameSync(tmp, SNAP_PATH());
  return { underlyings: out.map((u) => u.underlying), ms: Date.now() - t0 };
}

// ---- the paid routes -------------------------------------------------------------------
let cache = { mtimeMs: 0, data: null };
function readSnapshot() {
  let st;
  try { st = fs.statSync(SNAP_PATH()); } catch { return null; }
  if (st.mtimeMs !== cache.mtimeMs) cache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(SNAP_PATH(), 'utf8')) };
  return cache.data;
}
function unavailable(msg) { const e = new Error(msg); e.status = 503; return e; }
function pick(p, now) {
  const snap = readSnapshot();
  if (!snap) throw unavailable('options snapshot not built yet; the collector writes it every 5 minutes');
  const age = Math.round((now - snap.as_of_ms) / 1000);
  if (age > STALE_AFTER_S) throw unavailable(`options snapshot is ${age}s old (limit ${STALE_AFTER_S}s); not served stale`);
  const want = String(p.currency || p.symbol || 'BTC').toUpperCase().replace(/(_USDC|USDT|USD)$/, '');
  const u = snap.underlyings.find((x) => x.underlying === want);
  if (!u) { const e = new Error(`no options data for ${want}; covered: ${snap.underlyings.map((x) => x.underlying).join(', ')}`); e.kind = 'bad_request'; throw e; }
  return { snap, u, age };
}
function getOptionsSummary(p = {}, { now = Date.now() } = {}) {
  const { snap, u, age } = pick(p, now);
  return {
    underlying: u.underlying, venue: u.venue, settlement: u.settlement, spot: u.spot, spot_note: u.spot_note,
    as_of: snap.as_of, age_s: age, volatility_index: u.volatility_index, ...u.summary,
    gex_headline: { net_gex_usd_per_1pct: u.gex.net_gex_usd_per_1pct, flip_level: u.gex.flip_level, detail: '/api/options-gex' },
    method: 'IV values are in vol points. atm_iv: implied vol at the forward, interpolated in log-moneyness across out-of-the-money strikes. rr25 = IV(25-delta call) - IV(25-delta put); bf25 = mean of the two minus atm_iv; deltas are Black-76 on Deribit mark IV. Max pain minimises intrinsic value paid at expiry over that expiry\'s strikes. put_call_ratio by open interest and by 24h volume, in contracts of the underlying.',
    source: snap.source,
  };
}
function getOptionsGex(p = {}, { now = Date.now() } = {}) {
  const { snap, u, age } = pick(p, now);
  return { underlying: u.underlying, venue: u.venue, spot: u.spot, as_of: snap.as_of, age_s: age, ...u.gex, source: snap.source };
}
function coverage() { const s = readSnapshot(); return s ? s.underlyings.map((u) => u.underlying) : []; }

module.exports = {
  collect, getOptionsSummary, getOptionsGex, readSnapshot, coverage,
  STALE_AFTER_S, GEX_CONVENTION,
  _greeks: greeks, _ncdf: ncdf, _interp: interp, _maxPain: maxPain, _flipLevel: flipLevel, _analyse: analyse,
};

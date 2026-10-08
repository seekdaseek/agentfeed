// tools/tradfi.js — stock, index, commodity and FX perps (Hyperliquid HIP-3), and an
// indicative 24/7 price for US stocks.
//
// collectTradfi() runs inside the funding-radar collector (bin/funding-radar-collect.js:
// same cron, same flock, same snapshot, same history DB), so a paid request never
// calls Hyperliquid. Per HIP-3 market: funding now and its 30-day z-score (hourly
// settlements, from fundingHistory), OI and its 24h change (our own OI samples),
// mark minus oracle basis, 24h volume.
//
// Asset classes come from data/tradfi-classes.json, built from each deployer's
// docs where they say, else from the ticker (each entry carries its evidence). A
// market missing from that file is listed as "unclassified", never guessed.
'use strict';
const fs = require('fs');
const path = require('path');

const MIN_TRACK_USD = 250_000;      // OI or 24h volume needed to keep a market's funding history
const STALE_AFTER_S = 15 * 60;
const WINDOW_DAYS = 30;
const HOUR = 3_600_000, DAY = 86_400_000;
const PEGWATCH_DB = () => process.env.PEGWATCH_DB || '/opt/pegwatch/pegwatch.db';
const SNAP_PATH = () => process.env.FUNDING_RADAR_SNAPSHOT || path.join(__dirname, '..', 'funding-radar.json');
let CLASSES = {};
try { CLASSES = require('../data/tradfi-classes.json').markets || {}; } catch { CLASSES = {}; }

const num = (v) => (v == null || v === '' ? null : Number(v));
const round = (v, d) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

// ---- exchanges with TradFi perps (current values; no z-score history yet) ---------------
// Only symbols the venue's own metadata marks as TradFi are taken, so tokenized gold
// (PAXG, XAUT) and look-alike crypto tickers (SPX = SPX6900) never get in:
//   Bybit    instruments-info symbolType: stock | ETF | commodity | forex
//   Binance  exchangeInfo contractType TRADIFI_PERPETUAL, underlyingType EQUITY* | COMMODITY | FX | PREMARKET
//   OKX      instruments instCategory 3 (stocks, ETFs, indices, pre-market) | 4 (commodities); the code
//            meanings are read from the instruments they contain, not from OKX documentation
const OKX_INDEX = new Set(['US500', 'US100', 'JP225', 'KR200']);
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'agentfeed-tradfi/1.0 (+https://x402.ochinimus.app)' } });
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function readCex(log) {
  const out = [], errors = [];
  try { // Bybit
    const inst = [];
    let cursor = '';
    for (let i = 0; i < 5; i++) { const j = await getJson(`https://api.bybit.com/v5/market/instruments-info?category=linear&status=Trading&limit=1000${cursor ? `&cursor=${cursor}` : ''}`); inst.push(...j.result.list); cursor = j.result.nextPageCursor; if (!cursor) break; await pause(200); }
    const typ = new Map(inst.filter((x) => ['stock', 'ETF', 'commodity', 'forex'].includes(x.symbolType)).map((x) => [x.symbol, x]));
    const tk = (await getJson('https://api.bybit.com/v5/market/tickers?category=linear')).result.list;
    for (const t of tk) {
      const m = typ.get(t.symbol); if (!m) continue;
      const ih = Number(m.fundingInterval) / 60 || null;
      out.push({ venue: 'bybit', symbol: t.symbol, ticker: t.symbol.replace(/USDT$/, ''), asset_class: { stock: 'stock', ETF: 'index', commodity: 'commodity', forex: 'fx' }[m.symbolType], class_evidence: `Bybit symbolType ${m.symbolType}`, mark: num(t.markPrice), funding_rate_raw: num(t.fundingRate), funding_interval_hours: ih, oi_usd: Math.round(num(t.openInterestValue) || 0), volume_24h_usd: Math.round(num(t.turnover24h) || 0) });
    }
  } catch (e) { errors.push(`bybit: ${e.message}`); }
  try { // Binance USD-M
    const info = await getJson('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const tf = new Map(info.symbols.filter((x) => x.contractType === 'TRADIFI_PERPETUAL' && x.status === 'TRADING').map((x) => [x.symbol, x]));
    const prem = await getJson('https://fapi.binance.com/fapi/v1/premiumIndex');
    const d24 = await getJson('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const fi = await getJson('https://fapi.binance.com/fapi/v1/fundingInfo');
    const vol = new Map(d24.map((x) => [x.symbol, num(x.quoteVolume)]));
    const ivl = new Map(fi.map((x) => [x.symbol, num(x.fundingIntervalHours)]));
    const cls = (u) => (/EQUITY$/.test(u) ? 'stock' : u === 'COMMODITY' ? 'commodity' : u === 'FX' ? 'fx' : u === 'PREMARKET' ? 'pre_ipo' : 'other');
    for (const pr of prem) {
      const m = tf.get(pr.symbol); if (!m) continue;
      out.push({ venue: 'binance', symbol: pr.symbol, ticker: pr.symbol.replace(/USDT$/, ''), asset_class: cls(m.underlyingType), class_evidence: `Binance contractType TRADIFI_PERPETUAL, underlyingType ${m.underlyingType}`, mark: num(pr.markPrice), funding_rate_raw: num(pr.lastFundingRate), funding_interval_hours: ivl.get(pr.symbol) || 8, oi_usd: null, oi_note: 'Binance publishes open interest per symbol only; not read', volume_24h_usd: Math.round(vol.get(pr.symbol) || 0) });
    }
  } catch (e) { errors.push(`binance: ${e.message}`); }
  try { // OKX
    const inst = (await getJson('https://www.okx.com/api/v5/public/instruments?instType=SWAP')).data.filter((x) => (x.instCategory === '3' || x.instCategory === '4') && x.settleCcy === 'USDT');
    await pause(250);
    const tk = await getJson('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
    const mk = await getJson('https://www.okx.com/api/v5/public/mark-price?instType=SWAP');
    const fr = await getJson('https://www.okx.com/api/v5/public/funding-rate?instId=ANY');
    const oi = await getJson('https://www.okx.com/api/v5/public/open-interest?instType=SWAP');
    const T = new Map(tk.data.map((x) => [x.instId, x])), M = new Map(mk.data.map((x) => [x.instId, x])), F = new Map(fr.data.map((x) => [x.instId, x])), O = new Map(oi.data.map((x) => [x.instId, x]));
    for (const i of inst) {
      const base = i.instId.split('-')[0], t = T.get(i.instId) || {}, f = F.get(i.instId) || {}, o = O.get(i.instId);
      const ih = (num(f.nextFundingTime) - num(f.fundingTime)) / HOUR;
      out.push({ venue: 'okx', symbol: i.instId, ticker: base, asset_class: i.instCategory === '4' ? 'commodity' : (OKX_INDEX.has(base) ? 'index' : i.ruleType === 'pre_market' ? 'pre_ipo' : 'stock'), class_evidence: `OKX instCategory ${i.instCategory}${i.ruleType === 'pre_market' ? ', ruleType pre_market' : ''} (code meaning inferred from listed instruments)`, mark: num((M.get(i.instId) || {}).markPx), funding_rate_raw: num(f.fundingRate), funding_interval_hours: Number.isFinite(ih) && ih > 0 ? ih : null, oi_usd: o ? Math.round(num(o.oiUsd) || 0) : null, ...(o ? {} : { oi_note: 'not in the OKX open-interest list' }), volume_24h_usd: t.volCcy24h && t.last ? Math.round(num(t.volCcy24h) * num(t.last)) : null });
    }
  } catch (e) { errors.push(`okx: ${e.message}`); }
  for (const r of out) r.funding_rate_8h = r.funding_rate_raw != null && r.funding_interval_hours ? round((r.funding_rate_raw * 8) / r.funding_interval_hours, 8) : null;
  if (errors.length) log(`tradfi cex: ${errors.join(' | ')}`);
  return { rows: out, errors };
}

// ---- collector part (called by tools/fundingradar.js collect) -------------------------
async function collectTradfi({ client, db, now, log = () => {}, fr }) {
  db.exec(`CREATE TABLE IF NOT EXISTS tradfi_oi (market TEXT NOT NULL, ts INTEGER NOT NULL, oi_usd REAL NOT NULL,
    PRIMARY KEY (market, ts)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS tradfi_dex (dex TEXT PRIMARY KEY, live_markets INTEGER NOT NULL, checked_at INTEGER NOT NULL);`);
  const dexes = (await client.hl({ type: 'perpDexs' })).filter(Boolean);
  const markets = [];
  // A dex whose every market is delisted (six wound down by Oct 2026) is
  // re-read every 6 hours, not every run: six calls a run saved for history.
  const dexState = db.prepare('SELECT live_markets, checked_at FROM tradfi_dex WHERE dex = ?');
  const putDex = db.prepare('INSERT OR REPLACE INTO tradfi_dex (dex, live_markets, checked_at) VALUES (?, ?, ?)');
  for (const d of dexes) {
    const st = dexState.get(d.name);
    if (st && st.live_markets === 0 && now - st.checked_at < 6 * HOUR) continue;
    let mc;
    try { mc = await client.hl({ type: 'metaAndAssetCtxs', dex: d.name }); } catch (e) { log(`hip3 ${d.name}: ${e.message}`); continue; }
    const [meta, ctxs] = mc;
    putDex.run(d.name, meta.universe.filter((u) => !u.isDelisted).length, now);
    meta.universe.forEach((u, i) => {
      if (u.isDelisted) return;
      const c = ctxs[i] || {};
      const mark = num(c.markPx), oracle = num(c.oraclePx);
      const oiUsd = (num(c.openInterest) || 0) * (mark || 0);
      markets.push({ dex: d.name, market: u.name, mark, oracle, funding1h: num(c.funding), oiUsd, vol: num(c.dayNtlVlm) || 0, prevDayPx: num(c.prevDayPx) });
    });
  }
  const insOi = db.prepare('INSERT OR REPLACE INTO tradfi_oi (market, ts, oi_usd) VALUES (?, ?, ?)');
  db.transaction(() => { for (const m of markets) insOi.run(m.market, now, m.oiUsd); })();
  db.prepare('DELETE FROM tradfi_oi WHERE ts < ?').run(now - 3 * DAY);

  // funding history for tracked markets: updates first, then backfill, inside the run's HL budget
  const tracked = markets.filter((m) => m.oiUsd >= MIN_TRACK_USD || m.vol >= MIN_TRACK_USD).sort((a, b) => b.oiUsd - a.oiUsd);
  const latest = db.prepare("SELECT MAX(ts) t FROM funding WHERE venue = 'hl-hip3' AND symbol = ?");
  const ins = db.prepare("INSERT OR IGNORE INTO funding (venue, symbol, ts, rate) VALUES ('hl-hip3', ?, ?, ?)");
  const keepFrom = now - (WINDOW_DAYS + 2) * DAY;
  const due = tracked.map((m) => ({ m, last: latest.get(m.market).t })).filter((x) => !x.last || now - x.last > HOUR + 5 * 60_000)
    .sort((a, b) => (a.last ? 0 : 1) - (b.last ? 0 : 1));
  let fetched = 0, skipped = 0, failed = 0;
  for (const { m, last } of due) {
    if (client.left('hyperliquid') <= 0) { skipped++; continue; }
    try {
      let start = (last || keepFrom) + 1;
      for (let page = 0; page < 4; page++) {
        const rows = await client.hl({ type: 'fundingHistory', coin: m.market, startTime: start });
        db.transaction(() => { for (const r of rows) ins.run(m.market, num(r.time), num(r.fundingRate)); })();
        if (rows.length < 500) break;
        start = num(rows[rows.length - 1].time) + 1;
      }
      fetched++;
    } catch (e) { if (e.budget) skipped++; else { failed++; log(`hip3 history ${m.market}: ${e.message}`); } }
  }
  db.prepare("DELETE FROM funding WHERE venue = 'hl-hip3' AND ts < ?").run(keepFrom);

  const hist = db.prepare("SELECT ts, rate FROM funding WHERE venue = 'hl-hip3' AND symbol = ? AND ts >= ? ORDER BY ts");
  const oiThen = db.prepare('SELECT ts, oi_usd FROM tradfi_oi WHERE market = ? AND ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) LIMIT 1');
  const out = [];
  for (const m of tracked) {
    const series = fr._to8hSeries(hist.all(m.market, keepFrom), { fixedIntervalH: 1 });
    const st = fr._windowStats(series, now - WINDOW_DAYS * DAY, now);
    const f8 = m.funding1h != null ? m.funding1h * 8 : null;
    const { z, z_note } = fr._zScore(f8, st);
    const then = oiThen.get(m.market, now - DAY - 1_800_000, now - DAY + 1_800_000, now - DAY);
    const cls = CLASSES[m.market] || { asset_class: 'unclassified', underlying: null, evidence: 'not in data/tradfi-classes.json' };
    out.push({
      market: m.market, dex: m.dex, ticker: m.market.split(':').pop(), asset_class: cls.asset_class, underlying: cls.underlying, class_evidence: cls.evidence,
      funding_rate_1h: m.funding1h, funding_rate_8h: round(f8, 8), funding_interval_hours: 1,
      z_30d: round(z, 2), ...(z_note ? { z_note } : {}), samples: st.samples, window_days: st.window_days,
      oi_usd: Math.round(m.oiUsd), oi_change_24h_pct: then && then.oi_usd > 0 ? round(((m.oiUsd - then.oi_usd) / then.oi_usd) * 100, 2) : null,
      ...(then ? {} : { oi_change_note: 'our OI samples for this market do not reach 24h back yet' }),
      mark: m.mark, oracle: m.oracle, basis_bps: m.mark && m.oracle ? round(((m.mark - m.oracle) / m.oracle) * 1e4, 1) : null,
      volume_24h_usd: Math.round(m.vol),
    });
  }
  const cex = await readCex(log);
  const hl = out.map((m) => ({ venue: 'hyperliquid', ...m }));
  return {
    summary: { dexes: dexes.length, markets: markets.length, tracked: tracked.length, history_fetched: fetched, history_skipped: skipped, history_failed: failed, cex_rows: cex.rows.length, cex_errors: cex.errors.length },
    section: {
      as_of: new Date(now).toISOString(), as_of_ms: now, min_track_usd: MIN_TRACK_USD,
      dexes: dexes.map((d) => ({ dex: d.name, full_name: d.fullName, deployer: d.deployer, oracle_updater: d.oracleUpdater || null, live_markets: markets.filter((m) => m.dex === d.name).length })),
      markets: hl.concat(cex.rows.map((r) => ({ ...r, z_30d: null, z_note: '30-day z-scores are kept for Hyperliquid HIP-3 markets only so far' }))),
      cex_errors: cex.errors,
    },
  };
}

// ---- readers -------------------------------------------------------------------------
let cache = { mtimeMs: 0, data: null };
function section() {
  let st; try { st = fs.statSync(SNAP_PATH()); } catch { return null; }
  if (st.mtimeMs !== cache.mtimeMs) cache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(SNAP_PATH(), 'utf8')) };
  return cache.data && cache.data.tradfi;
}
function unavailable(msg) { const e = new Error(msg); e.status = 503; return e; }
function fresh(now) {
  const s = section();
  if (!s) throw unavailable('tradfi snapshot not built yet');
  const age = Math.round((now - s.as_of_ms) / 1000);
  if (age > STALE_AFTER_S) throw unavailable(`tradfi snapshot is ${age}s old (limit ${STALE_AFTER_S}s); not served stale`);
  return { s, age };
}
const CLASS_NAMES = ['stock', 'index', 'commodity', 'fx', 'rates', 'pre_ipo', 'crypto_index', 'other', 'unclassified'];

function getTradfiRadar(p = {}, { now = Date.now() } = {}) {
  const { s, age } = fresh(now);
  const cls = p.class || p.asset_class ? String(p.class || p.asset_class).toLowerCase().split(',').map((x) => x.trim()) : null;
  if (cls && cls.some((c) => !CLASS_NAMES.includes(c))) { const e = new Error(`class must be one of ${CLASS_NAMES.join(', ')}`); e.kind = 'bad_request'; throw e; }
  const top = Math.min(Math.max(parseInt(p.top, 10) || 25, 1), 200);
  const minOi = Math.max(Number(p.min_oi_usd) || 0, 0);
  const venues = p.venue ? String(p.venue).toLowerCase().split(',').map((x) => x.trim()) : null;
  // a venue that publishes no OI (Binance) is kept unless a minimum OI is asked for
  const rows = s.markets.filter((m) => (!cls || cls.includes(m.asset_class)) && (!venues || venues.includes(m.venue)) && (minOi === 0 || (m.oi_usd ?? 0) >= minOi))
    .sort((a, b) => (Math.abs(b.funding_rate_8h || 0) - Math.abs(a.funding_rate_8h || 0)) || ((b.oi_usd || 0) - (a.oi_usd || 0)));
  const counts = {}; for (const m of s.markets) counts[m.asset_class] = (counts[m.asset_class] || 0) + 1;
  return {
    as_of: s.as_of, age_s: age, venues: ['hyperliquid (HIP-3 dexes)', 'bybit', 'binance', 'okx'],
    classes: counts, matched: rows.length, returned: Math.min(top, rows.length), markets: rows.slice(0, top),
    dexes: s.dexes,
    ...(s.cex_errors && s.cex_errors.length ? { venue_errors: s.cex_errors } : {}),
    method: `Ranked by |funding| at its 8h equivalent (each venue's own interval: Hyperliquid HIP-3 hourly, Bybit, Binance and OKX 4h or 8h), then by OI. z_30d (Hyperliquid HIP-3 only so far) compares funding with that market's own 30 days. basis_bps = (mark - oracle) / oracle. oi_change_24h_pct compares with our own OI sample from 24h ago. Markets need $${s.min_track_usd.toLocaleString('en-US')} of OI or 24h volume to be tracked. Each deployer sets its own oracle; see class_evidence and the dex list.`,
  };
}

/** New York wall-clock session label. Exchange holidays are not detected. */
function sessionLabel(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const mins = Number(p.hour) * 60 + Number(p.minute);
  // Friday 20:00 to Sunday 20:00 New York is the weekend; Sunday 20:00 opens the overnight session
  if (p.weekday === 'Sat' || (p.weekday === 'Sun' && mins < 20 * 60) || (p.weekday === 'Fri' && mins >= 20 * 60)) return 'weekend';
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return 'open';
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return 'pre';
  if (mins >= 16 * 60 && mins < 20 * 60) return 'after';
  return 'overnight';
}

let pegDb = null;
function peg() {
  if (pegDb) return pegDb;
  const Database = require('better-sqlite3');
  pegDb = new Database(PEGWATCH_DB(), { readonly: true, fileMustExist: true });
  return pegDb;
}

function getEquity24h(p = {}, { now = Date.now() } = {}) {
  const sym = String(p.symbol || '').toUpperCase().replace(/X$/, '').trim();
  if (!/^[A-Z0-9.]{1,12}$/.test(sym)) { const e = new Error('symbol required: a US stock or index ticker, e.g. TSLA, NVDA, SP500'); e.kind = 'bad_request'; throw e; }
  const { s, age } = fresh(now);
  const perps = s.markets.filter((m) => m.ticker === sym && m.asset_class !== 'crypto_index').map((m) => ({
    source: m.venue === 'hyperliquid' ? `Hyperliquid HIP-3 ${m.market} perp mark` : `${m.venue} ${m.symbol} perp mark`,
    price: m.mark, ...(m.oracle != null ? { oracle: m.oracle } : {}), funding_rate_8h: m.funding_rate_8h,
    liquidity: { open_interest_usd: m.oi_usd, volume_24h_usd: m.volume_24h_usd, ...(m.oi_note ? { note: m.oi_note } : {}) }, as_of: s.as_of,
  }));
  let dex = null, close = null;
  try {
    const t = peg().prepare('SELECT ts, onchain, liq_usd, dex FROM ticks WHERE symbol = ? ORDER BY ts DESC LIMIT 1').get(`${sym}x`);
    if (t && now - t.ts * 1000 < 30 * 60_000) dex = { source: `${sym}x tokenized stock on Solana (${t.dex || 'DEX'}), our pegwatch collector`, price: t.onchain, liquidity: { pool_liquidity_usd: Math.round(t.liq_usd) }, as_of: new Date(t.ts * 1000).toISOString() };
    const c = peg().prepare("SELECT ts, ref, ref_source FROM ticks WHERE symbol = ? AND session = 'open' ORDER BY ts DESC LIMIT 1").get(`${sym}x`);
    if (c) close = { price: c.ref, as_of: new Date(c.ts * 1000).toISOString(), source: `${c.ref_source} latest trade at our last regular-session sample (5-minute sampling; not the official closing auction print)` };
  } catch { /* no pegwatch for this symbol */ }
  const sources = [...perps, ...(dex ? [dex] : [])];
  const liquid = sources.filter((x) => (x.liquidity.open_interest_usd || 0) > 0 || (x.liquidity.pool_liquidity_usd || 0) > 0 || (x.liquidity.volume_24h_usd || 0) > 0);
  if (!liquid.length) throw unavailable(`no source with liquidity for ${sym}: ${sources.length ? 'every source has zero open interest or pool liquidity' : 'not listed as a HIP-3 perp and not a tokenized stock we track'}`);
  // deepest source first: OI plus pool liquidity; a venue without OI (Binance) counts a tenth of its 24h volume
  const depth = (x) => (x.liquidity.open_interest_usd || 0) + (x.liquidity.pool_liquidity_usd || 0) + (x.liquidity.open_interest_usd == null ? (x.liquidity.volume_24h_usd || 0) / 10 : 0);
  const best = liquid.slice().sort((a, b) => depth(b) - depth(a))[0];
  return {
    symbol: sym, indicative: true,
    notice: 'INDICATIVE price from 24/7 venues, not an exchange quote. US exchange holidays are not detected in the session label.',
    session: sessionLabel(now),
    indicative_price: best.price, indicative_source: best.source,
    last_regular_session: close || { price: null, reason: `we do not hold a regular-session price for ${sym} (only for the tokenized stocks our pegwatch collector tracks)` },
    implied_gap_pct: close && best.price ? round(((best.price - close.price) / close.price) * 100, 3) : null,
    sources, as_of: s.as_of, age_s: age,
  };
}

module.exports = { collectTradfi, getTradfiRadar, getEquity24h, sessionLabel, CLASS_NAMES, STALE_AFTER_S };

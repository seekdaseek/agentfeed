// tools/fundingradar.js — get_funding_radar ($0.02): every perp's funding on
// Bybit, OKX and Hyperliquid next to its own 30-day history.
//
// A funding rate on its own says little: 0.01% per 8h is ordinary on BTC and a
// screaming outlier on a coin that has sat at -0.002% for a month. So per venue
// this returns the current rate at its 8h equivalent, where that rate sits
// against the venue's own settled history for the symbol (a 30-day z-score),
// and the spread between the venues, sorted by how extreme the reading is.
//
// TWO HALVES, ON PURPOSE.
//   collect()          run by cron (bin/funding-radar-collect.js) every 5 min.
//                      The only code here that talks to a venue. It stores
//                      settled funding history in fundingradar.db and writes a
//                      precomputed snapshot to funding-radar.json.
//   getFundingRadar()  the paid route. Reads the snapshot and nothing else, so a
//                      paid request never waits on, or fails because of, three
//                      exchanges' rate limits. A snapshot older than
//                      STALE_AFTER_S says so in the answer (stale: true + age).
//
// Never fabricated. A venue that does not list a symbol is null, not zero. A
// rate whose interval cannot be read gets no 8h figure and no z-score. A
// venue with fewer than MIN_SAMPLES settlements in the window gets no z-score,
// and every z-score carries the samples and the window it was actually computed
// over -- 30 days is the target, a younger listing returns what it has.
//
// Intervals follow tools/derivs.js (see the funding-intervals block there):
// a venue quotes funding for its own interval, and a settled rate's interval
// is the spacing to the settlement before it, because Bybit moves symbols
// between intervals.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = () => process.env.FUNDING_RADAR_DB || path.join(ROOT, 'fundingradar.db');
const SNAP_PATH = () => process.env.FUNDING_RADAR_SNAPSHOT || path.join(ROOT, 'funding-radar.json');
const BYBIT = () => process.env.BYBIT_REST || 'https://api.bybit.com';
const OKX = () => process.env.OKX_REST || 'https://www.okx.com';
const HL = () => process.env.HL_API || 'https://api.hyperliquid.xyz/info';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WINDOW_DAYS = 30;
// The tracked universe: listed on at least two of the three venues, with this
// much combined open interest. Measured 2026-10-08: 184 symbols at $5M, 368 at
// $1M. The floor bounds the collector's history calls, so min_oi_usd below it
// cannot return symbols that were never tracked -- it is clamped and says so.
const UNIVERSE_MIN_OI_USD = 5_000_000;
const MIN_VENUES = 2;
const Z_FLAG = 2;
const MIN_SAMPLES = 10;
const STALE_AFTER_S = 15 * 60;
const DEFAULT_TOP = 20;
const DEFAULT_MIN_OI_USD = 10_000_000;
const VENUES = ['bybit', 'okx', 'hyperliquid'];

const num = (v) => (v == null || v === '' ? null : Number(v));
const finite = (v) => (Number.isFinite(v) ? v : null);
const round = (v, d) => (v == null ? null : Number(v.toFixed(d)));

// ---- statistics (pure, unit-tested) -----------------------------------------

/**
 * Settled rows [{ts, rate}] ascending -> 8h-equivalent series. Each row's
 * interval is the spacing to the row before it; the first row has none and is
 * only used as that predecessor. A gap wider than 8.5h is a halt or a listing
 * gap, not an interval, so it falls back to the symbol's current interval.
 * Hyperliquid settles hourly by protocol, so fixedIntervalH = 1 there.
 */
function to8hSeries(rows, { fixedIntervalH = null, fallbackIntervalH = null } = {}) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    let ih = fixedIntervalH;
    if (ih == null) {
      if (i === 0) continue;
      ih = (rows[i].ts - rows[i - 1].ts) / HOUR;
      if (ih > 8.5) ih = fallbackIntervalH;
      else if (ih < 0.9) ih = 1;
    }
    if (ih == null || !Number.isFinite(rows[i].rate)) continue;
    out.push({ ts: rows[i].ts, r8: (rows[i].rate * 8) / ih });
  }
  return out;
}

/** mean, sample std, n and the window actually covered, over series rows inside [since, now]. */
function windowStats(series, since, now) {
  const xs = series.filter((p) => p.ts >= since && p.ts <= now);
  const n = xs.length;
  if (!n) return { samples: 0, mean_8h: null, std_8h: null, window_days: 0 };
  const mean = xs.reduce((s, p) => s + p.r8, 0) / n;
  const std = n > 1 ? Math.sqrt(xs.reduce((s, p) => s + (p.r8 - mean) ** 2, 0) / (n - 1)) : null;
  const oldest = xs.reduce((m, p) => Math.min(m, p.ts), Infinity);
  return { samples: n, mean_8h: mean, std_8h: std, window_days: round((now - oldest) / DAY, 1) };
}

/** z of the current 8h rate against the window, or null with the reason. */
function zScore(current8h, st) {
  if (current8h == null) return { z: null, z_note: 'no current 8h-equivalent rate (interval unknown)' };
  if (st.samples < MIN_SAMPLES) return { z: null, z_note: `only ${st.samples} settled rates in the window; ${MIN_SAMPLES} needed for a z-score` };
  if (!st.std_8h) return { z: null, z_note: 'the settled rate did not vary over the window, so a z-score is undefined' };
  return { z: (current8h - st.mean_8h) / st.std_8h };
}

/** One symbol's radar row from its venue readings. Pure. */
function radarRow(symbol, venues, oi) {
  const out = { symbol, oi_usd: oi, venues: {} };
  const rated = [];
  let maxAbsZ = null, extremeVenue = null;
  const flagged = [];
  for (const v of VENUES) {
    const r = venues[v];
    out.venues[v] = r || null;
    if (!r) continue;
    if (r.funding_rate_8h != null) rated.push([v, r.funding_rate_8h]);
    if (r.z_30d != null) {
      const a = Math.abs(r.z_30d);
      if (maxAbsZ == null || a > maxAbsZ) { maxAbsZ = a; extremeVenue = v; }
      if (a >= Z_FLAG) flagged.push(v);
    }
  }
  if (rated.length > 1) {
    rated.sort((a, b) => b[1] - a[1]);
    out.spread_8h = round(rated[0][1] - rated[rated.length - 1][1], 8);
    out.spread_high_venue = rated[0][0];
    out.spread_low_venue = rated[rated.length - 1][0];
  } else {
    out.spread_8h = null;
  }
  out.max_abs_z = round(maxAbsZ, 2);
  out.extreme_venue = extremeVenue;
  out.flag = flagged.length > 0;
  out.flagged_venues = flagged;
  return out;
}

/** Most extreme first: largest |z| on any venue, then the widest spread. Rows with no z go last. */
function byExtremity(a, b) {
  const za = a.max_abs_z, zb = b.max_abs_z;
  if (za == null && zb != null) return 1;
  if (zb == null && za != null) return -1;
  if (za != null && zb != null && zb !== za) return zb - za;
  return Math.abs(b.spread_8h || 0) - Math.abs(a.spread_8h || 0);
}

// ---- venue access (collector only) -----------------------------------------

// Spacing between calls per venue, well inside each published limit and shared
// with every other reader on this box: OKX funding-rate-history allows 10 per
// 2 s, Hyperliquid info is 1200 weight a minute and fundingHistory weighs 20+.
function pacer(gapMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
}

// A 500-row fundingHistory page weighs about 45 (20 + 1 per 20 items); at 3.5 s
// between calls the collector stays under ~780 of Hyperliquid's 1200 a minute even
// when every call is a full backfill page.
//
// RUN LENGTH. The cron fires every 5 minutes under flock -n, so a run that outlives
// 5 minutes silently swallows the next one. With the crypto radar (30) and the
// HIP-3 markets (32) both at their Hyperliquid budgets, 62 calls x 3.5 s = 217 s;
// `deadline` is the hard backstop on top: past it a client starts no new call, so
// a slow venue can never stretch a run past ~270 s. Measured 2026-10-08: 45 + 40
// calls at 4 s would have been ~340 s at the top of each hour during backfill.
function venueClient({ fetchImpl = fetch, budget = { bybit: 150, okx: 60, hyperliquid: 30 }, gaps = { bybit: 150, okx: 400, hyperliquid: 3500 }, sharedPace = null, deadline = Infinity } = {}) {
  // sharedPace: a second client with its own budget but the SAME pacers, so two
  // budgets never add up to a faster request rate against one venue.
  const pace = sharedPace || Object.fromEntries(VENUES.map((v) => [v, pacer(gaps[v])]));
  const used = { bybit: 0, okx: 0, hyperliquid: 0 };
  const left = (v) => (Date.now() >= deadline ? 0 : budget[v] - used[v]);
  async function get(v, url, opts) {
    if (left(v) <= 0) { const e = new Error(`${v}: call budget for this run spent`); e.budget = true; throw e; }
    used[v]++;
    await pace[v]();
    const r = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`${v} HTTP ${r.status}`);
    return r.json();
  }
  const bybit = async (p) => { const j = await get('bybit', BYBIT() + p); if (j.retCode !== 0) throw new Error(`bybit: ${j.retMsg}`); return j.result; };
  const okx = async (p) => { const j = await get('okx', OKX() + p); if (j.code !== '0') { const e = new Error(`okx: ${j.msg}`); e.okxCode = j.code; throw e; } return j.data; };
  const hl = (body) => get('hyperliquid', HL(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { bybit, okx, hl, used, left, pace };
}

const okxInst = (sym) => sym.replace(/USDT$/, '') + '-USDT-SWAP';
const coinOf = (sym) => sym.replace(/USDT$/, '');

/** Current funding, interval and OI on all three venues: six bulk calls. */
async function readCurrent(c) {
  const byIv = {};
  for (const status of ['Trading', 'PreLaunch', 'Delivering']) {
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const r = await c.bybit(`/v5/market/instruments-info?category=linear&status=${status}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      for (const i of r.list) if (Number(i.fundingInterval) > 0) byIv[i.symbol] = Number(i.fundingInterval) / 60;
      cursor = r.nextPageCursor;
      if (!cursor) break;
    }
  }
  const bybit = {};
  for (const t of (await c.bybit('/v5/market/tickers?category=linear')).list) {
    if (!/USDT$/.test(t.symbol) || t.fundingRate === '') continue;
    const raw = num(t.fundingRate), ih = byIv[t.symbol] ?? null;
    bybit[t.symbol] = { raw, ih, next: num(t.nextFundingTime), oi: num(t.openInterestValue) || 0 };
  }
  const okx = {};
  for (const d of await c.okx('/api/v5/public/funding-rate?instId=ANY')) {
    if (!/-USDT-SWAP$/.test(d.instId)) continue;
    const ih = (num(d.nextFundingTime) - num(d.fundingTime)) / HOUR;
    // fundingTime is OKX's NEXT settlement (measured 2026-09-28, see derivs.js)
    okx[d.instId.replace('-USDT-SWAP', 'USDT')] = { raw: num(d.fundingRate), ih: Number.isFinite(ih) && ih > 0 ? ih : null, next: num(d.fundingTime), oi: 0 };
  }
  // OKX's SWAP open-interest list is not complete (500 rows against 737
  // funding rows on 2026-10-08), so a missing figure is 0 toward the total,
  // never a guess.
  try {
    for (const d of await c.okx('/api/v5/public/open-interest?instType=SWAP')) {
      const s = d.instId.replace('-USDT-SWAP', 'USDT');
      if (okx[s] && /-USDT-SWAP$/.test(d.instId)) okx[s].oi = num(d.oiUsd) || 0;
    }
  } catch { /* OI only filters; funding stands without it */ }
  const hyperliquid = {};
  const [meta, ctxs] = await c.hl({ type: 'metaAndAssetCtxs' });
  meta.universe.forEach((u, i) => {
    if (u.isDelisted) return;
    const x = ctxs[i];
    hyperliquid[u.name + 'USDT'] = { raw: num(x.funding), ih: 1, next: null, oi: (num(x.openInterest) || 0) * (num(x.markPx) || 0) };
  });
  return { bybit, okx, hyperliquid };
}

// ---- history store ---------------------------------------------------------

function openDb() {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH());
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS funding (venue TEXT NOT NULL, symbol TEXT NOT NULL, ts INTEGER NOT NULL, rate REAL NOT NULL,
      PRIMARY KEY (venue, symbol, ts)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS series (venue TEXT NOT NULL, symbol TEXT NOT NULL, backfilled INTEGER NOT NULL DEFAULT 0,
      checked_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (venue, symbol)) WITHOUT ROWID;`);
  return db;
}

/** Settled rows newer than `since` for one venue series, ascending, from the venue. */
async function fetchHistory(c, venue, symbol, since) {
  const rows = [];
  if (venue === 'bybit') {
    let end = Date.now();
    for (let page = 0; page < 6; page++) {
      const r = await c.bybit(`/v5/market/funding/history?category=linear&symbol=${symbol}&startTime=${since}&endTime=${end}&limit=200`);
      for (const x of r.list) rows.push({ ts: num(x.fundingRateTimestamp), rate: num(x.fundingRate) });
      if (r.list.length < 200) break;
      end = Math.min(...r.list.map((x) => num(x.fundingRateTimestamp))) - 1;
    }
  } else if (venue === 'okx') {
    // realizedRate is what settled; fundingRate in history is the prediction.
    let after = '';
    for (let page = 0; page < 3; page++) {
      const d = await c.okx(`/api/v5/public/funding-rate-history?instId=${okxInst(symbol)}&limit=400${after ? `&after=${after}` : ''}`);
      for (const x of d) {
        const ts = num(x.fundingTime);
        if (ts > since) rows.push({ ts, rate: num(x.realizedRate !== '' && x.realizedRate != null ? x.realizedRate : x.fundingRate) });
      }
      if (d.length < 400 || Math.min(...d.map((x) => num(x.fundingTime))) <= since) break;
      after = String(Math.min(...d.map((x) => num(x.fundingTime))));
    }
  } else {
    let start = since + 1;
    for (let page = 0; page < 4; page++) {
      const d = await c.hl({ type: 'fundingHistory', coin: coinOf(symbol), startTime: start });
      for (const x of d) rows.push({ ts: num(x.time), rate: num(x.fundingRate) });
      if (d.length < 500) break;
      start = num(d[d.length - 1].time) + 1;
    }
  }
  return rows.filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.rate));
}

// ---- collector ---------------------------------------------------------------

/**
 * One collector run: read current funding, pick the universe, bring as many
 * history series up to date as this run's call budget allows (largest open
 * interest first, updates before backfill), then write the snapshot from
 * whatever history is stored. Returns a summary for the cron log.
 */
async function collect({ now = Date.now(), client = null, log = () => {} } = {}) {
  const t0 = Date.now();
  client = client || venueClient({ deadline: t0 + 200_000 });
  const db = openDb();
  const cur = await readCurrent(client);
  const symbols = new Set([...Object.keys(cur.bybit), ...Object.keys(cur.okx), ...Object.keys(cur.hyperliquid)]);
  const universe = [];
  for (const s of symbols) {
    const listed = VENUES.filter((v) => cur[v][s]);
    const oi = Object.fromEntries(VENUES.map((v) => [v, cur[v][s] ? Math.round(cur[v][s].oi) : null]));
    const total = VENUES.reduce((t, v) => t + (oi[v] || 0), 0);
    if (listed.length >= MIN_VENUES && total >= UNIVERSE_MIN_OI_USD) universe.push({ symbol: s, listed, oi: { ...oi, total } });
  }
  universe.sort((a, b) => b.oi.total - a.oi.total);

  const since30 = now - WINDOW_DAYS * DAY;
  const keepFrom = now - (WINDOW_DAYS + 2) * DAY;
  const latest = db.prepare('SELECT MAX(ts) t FROM funding WHERE venue = ? AND symbol = ?');
  const getSeries = db.prepare('SELECT backfilled, checked_at FROM series WHERE venue = ? AND symbol = ?');
  const putSeries = db.prepare('INSERT INTO series (venue, symbol, backfilled, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(venue, symbol) DO UPDATE SET backfilled = MAX(backfilled, excluded.backfilled), checked_at = excluded.checked_at');
  const ins = db.prepare('INSERT OR IGNORE INTO funding (venue, symbol, ts, rate) VALUES (?, ?, ?, ?)');

  // updates (series already backfilled, a settlement due) first, then backfill
  const due = [];
  for (const u of universe) {
    for (const v of u.listed) {
      const st = getSeries.get(v, u.symbol) || { backfilled: 0, checked_at: 0 };
      const last = latest.get(v, u.symbol).t;
      const ih = cur[v][u.symbol].ih || 8;
      if (!st.backfilled) due.push({ v, s: u.symbol, since: keepFrom, backfill: true, prio: 1 });
      else if (now - (last || 0) > ih * HOUR + 5 * 60_000 && now - st.checked_at > 10 * 60_000) due.push({ v, s: u.symbol, since: last || keepFrom, backfill: false, prio: 0 });
    }
  }
  due.sort((a, b) => a.prio - b.prio);
  let fetched = 0, failed = 0, skipped = 0;
  // One loop per venue, run side by side: each is paced by its own limit, so
  // running them in sequence would only add the three waits together.
  await Promise.all(VENUES.map(async (venue) => {
    for (const d of due.filter((x) => x.v === venue)) {
      if (client.left(d.v) <= 0) { skipped++; continue; }
      try {
        const rows = await fetchHistory(client, d.v, d.s, d.since);
        db.transaction(() => {
          for (const r of rows) ins.run(d.v, d.s, r.ts, r.rate);
          putSeries.run(d.v, d.s, d.backfill ? 1 : 0, now);
        })();
        fetched++;
      } catch (e) {
        if (e.budget) { skipped++; continue; }
        failed++;
        log(`history ${d.v} ${d.s}: ${e.message}`);
      }
    }
  }));
  db.prepare('DELETE FROM funding WHERE ts < ?').run(keepFrom);

  // snapshot from stored history
  const hist = db.prepare('SELECT ts, rate FROM funding WHERE venue = ? AND symbol = ? AND ts >= ? ORDER BY ts');
  const rows = [];
  let seriesWithHistory = 0, seriesTotal = 0, seriesFull = 0;
  for (const u of universe) {
    const venues = {};
    for (const v of u.listed) {
      seriesTotal++;
      const c = cur[v][u.symbol];
      const current8h = c.ih ? (c.raw * 8) / c.ih : null;
      const stored = hist.all(v, u.symbol, keepFrom);
      const series = to8hSeries(stored, { fixedIntervalH: v === 'hyperliquid' ? 1 : null, fallbackIntervalH: c.ih });
      const st = windowStats(series, since30, now);
      if (st.samples) seriesWithHistory++;
      if (st.window_days >= WINDOW_DAYS - 0.5) seriesFull++;
      const pending = !(getSeries.get(v, u.symbol) || {}).backfilled;
      let { z, z_note } = zScore(current8h, st);
      // "only 0 settled rates" would read as a fact about the venue when it is
      // a fact about our collector: this series has not been fetched yet.
      if (pending && z == null) z_note = 'history for this venue has not been collected yet (new to the radar); it fills within the hour';
      venues[v] = {
        funding_rate_8h: round(finite(current8h), 8),
        funding_rate_raw: c.raw,
        funding_interval_hours: c.ih,
        ...(c.next ? { next_funding_time: c.next } : {}),
        z_30d: round(z, 2),
        ...(z_note ? { z_note } : {}),
        mean_8h_30d: round(st.mean_8h, 8),
        std_8h_30d: round(st.std_8h, 8),
        samples: st.samples,
        window_days: st.window_days,
      };
    }
    rows.push(radarRow(u.symbol, venues, u.oi));
  }
  rows.sort(byExtremity);
  // Stock, index, commodity and FX perps (HIP-3) ride the same run, budget and
  // snapshot; a failure there never costs the crypto radar its snapshot.
  let tradfi = null, tradfiSummary = null;
  try {
    // its own call budget, the crypto client's pacers: the crypto radar's hourly
    // Hyperliquid updates can no longer starve the HIP-3 markets of calls
    const tradfiClient = venueClient({ budget: { bybit: 0, okx: 0, hyperliquid: 32 }, sharedPace: client.pace, deadline: t0 + 235_000 });
    const t = await require('./tradfi').collectTradfi({ client: tradfiClient, db, now, log, fr: module.exports });
    tradfi = t.section; tradfiSummary = t.summary;
  } catch (e) { log(`tradfi: ${e.message}`); }
  const snapshot = {
    version: 1,
    as_of: new Date(now).toISOString(),
    as_of_ms: now,
    universe_floor_oi_usd: UNIVERSE_MIN_OI_USD,
    min_venues: MIN_VENUES,
    window_target_days: WINDOW_DAYS,
    coverage: { series_total: seriesTotal, series_with_history: seriesWithHistory, series_full_window: seriesFull },
    symbols: rows,
    ...(tradfi ? { tradfi } : {}),
  };
  const tmp = SNAP_PATH() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
  fs.renameSync(tmp, SNAP_PATH());
  db.close();
  return { universe: universe.length, due: due.length, fetched, failed, skipped, calls: { ...client.used }, coverage: snapshot.coverage, tradfi: tradfiSummary, ms: Date.now() - t0 };
}

// ---- the paid route ------------------------------------------------------------

let snapCache = { mtimeMs: 0, data: null };
function readSnapshot() {
  const p = SNAP_PATH();
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (st.mtimeMs !== snapCache.mtimeMs) snapCache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  return snapCache.data;
}

function clampInt(v, lo, hi, d) {
  const x = parseInt(v, 10);
  return Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : d;
}

function getFundingRadar(p = {}, { now = Date.now() } = {}) {
  const snap = readSnapshot();
  if (!snap) throw new Error('funding radar cache has not been built yet; the collector writes it every 5 minutes');
  const top = clampInt(p.top ?? p.limit, 1, 100, DEFAULT_TOP);
  const asked = p.min_oi_usd == null || p.min_oi_usd === '' ? DEFAULT_MIN_OI_USD : Number(p.min_oi_usd);
  if (!Number.isFinite(asked) || asked < 0) {
    const e = new Error(`invalid min_oi_usd: ${p.min_oi_usd}`);
    e.kind = 'bad_request';
    throw e;
  }
  const minOi = Math.max(asked, snap.universe_floor_oi_usd);
  const matched = snap.symbols.filter((r) => r.oi_usd.total >= minOi);
  const age = Math.max(0, Math.round((now - snap.as_of_ms) / 1000));
  const stale = age > STALE_AFTER_S;
  return {
    as_of: snap.as_of,
    age_s: age,
    stale,
    ...(stale ? { stale_note: `the precomputed radar is ${age}s old (fresh means under ${STALE_AFTER_S}s); the readings are as of as_of, not now` } : {}),
    venues: VENUES,
    window_target_days: snap.window_target_days,
    z_flag_abs: Z_FLAG,
    min_oi_usd: minOi,
    ...(asked < snap.universe_floor_oi_usd ? { min_oi_note: `the radar tracks symbols with at least $${snap.universe_floor_oi_usd.toLocaleString('en-US')} combined open interest on at least ${snap.min_venues} venues; lower values return that floor` } : {}),
    universe_size: snap.symbols.length,
    matched: matched.length,
    returned: Math.min(top, matched.length),
    coverage: snap.coverage,
    symbols: matched.slice(0, top),
    method: 'funding_rate_8h is each venue\'s current rate at its own interval scaled to 8h. z_30d compares it with that venue\'s settled 8h-equivalent rates for the symbol over the last 30 days (samples and window_days are what was actually used; under 10 settlements there is no z). spread_8h is the widest gap between venues. Sorted by the largest |z| on any venue. Venue absent = not listed there.',
  };
}

/** One symbol's radar row straight from the snapshot (not limited to the top N), with its as_of and staleness. */
function getRadarRow(symbol, { now = Date.now() } = {}) {
  const snap = readSnapshot();
  if (!snap) return null;
  const row = snap.symbols.find((r) => r.symbol === symbol);
  const age = Math.max(0, Math.round((now - snap.as_of_ms) / 1000));
  return row ? { row, as_of: snap.as_of, age_s: age, stale: age > STALE_AFTER_S } : { row: null, as_of: snap.as_of, age_s: age, stale: age > STALE_AFTER_S };
}

module.exports = {
  collect, getFundingRadar, getRadarRow,
  _to8hSeries: to8hSeries, _windowStats: windowStats, _zScore: zScore, _radarRow: radarRow, _byExtremity: byExtremity,
  _venueClient: venueClient, _readCurrent: readCurrent, _fetchHistory: fetchHistory,
  STALE_AFTER_S, UNIVERSE_MIN_OI_USD, DEFAULT_MIN_OI_USD, DEFAULT_TOP,
};

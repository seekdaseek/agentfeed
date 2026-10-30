#!/usr/bin/env node
// bin/brief-calibrate.js: builds tools/briefs/calibration.json, the per-coin price-move tails get_move_alert measures a move against.
//
// Source: Hyperliquid's public info API, request type candleSnapshot (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint).
// Documented limits (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits): REST requests per IP share a weight
// of 1200 a minute; candleSnapshot weighs 20 plus 1 per 60 candles returned (5000 candles = 104); only the most recent 5000 candles of an interval exist.
// So: ONE request at a time, 6.5 s apart (about 9 requests, 960 weight, a minute), and a 429 backs off 30 s before one retry.
//
// For each of the top coins by open interest and for 5m, 1h and 4h: the last (up to) 5000 COMPLETE candles, the absolute close-to-close change of every
// candle, and three thresholds from that sample. The nominal tiers are p99 (notable), p99.9 (sharp) and p99.99 (extreme), but a quantile is only used when
// the sample holds at least MIN_EXCEEDANCES (10) windows beyond it: 5000 windows put p99.9 on 5 points. So notable is p99, sharp is the highest supported
// quantile up to p99.9 (p99.8 at n = 5000), and extreme is "larger than every window in the sample" while p99.99 is unsupported (it needs n >= 100,000).
// Windows are candle returns, not rolling windows: they do not overlap, so n is the number of independent windows.
//
//   node bin/brief-calibrate.js --out brief-calibration.json [--coins 30] [--gap-ms 6500] [--closes-out file]
// Needs the network and nothing else. It is a weekly job (the table is refused after 45 days, so without it /api/move-alert turns into a 503); the server never calls it.
//
// THE WEEKLY JOB (root cron on the box, part of the deploy; Mondays 04:10 UTC, about 25 minutes; the gap is 15 s, not 6.5, because the box's other Hyperliquid
// collectors share the same IP and the documented 1200 weight a minute: this run uses about 420 of it):
//   10 4 * * 1 cd /opt/agentfeed && /usr/bin/flock -n /var/lock/brief-calibrate.lock /usr/bin/timeout 3600 /usr/bin/node --max-old-space-size=192 bin/brief-calibrate.js --out brief-calibration.json --gap-ms 15000 >> /opt/agentfeed/brief-calibrate.log 2>&1
// It writes brief-calibration.json (git-ignored runtime data beside the code); tools/briefs/move.js reads the newer of that file and the shipped tools/briefs/calibration.json.
//
// A BAD FETCH NEVER REPLACES A GOOD TABLE. The new table is accepted only when accept() says so: at least 80% of the requested coins complete (5m and 1h with at least
// 4,000 windows each, 4h with at least 1,000), no more than 20% of the requests failed, and, when a table already exists, at least 80% of its coins are still covered.
// Otherwise the old file is left exactly as it was, the reasons are printed, and the exit status is 2 (the log and the daily alert in ops/af-digest.js show it).
// An accepted table is written to a temp file in the same directory and renamed over the old one, so a reader sees the whole old table or the whole new one.
'use strict';
const fs = require('fs');
const path = require('path');

const INFO = process.env.HL_API || 'https://api.hyperliquid.xyz/info';
const NOMINAL = { notable: 0.99, sharp: 0.999, extreme: 0.9999 };
const MIN_EXCEEDANCES = 10;
const MIN_WINDOWS = 1000;                   // a horizon with fewer complete candles than this is left out: p99 would sit on under 10 points
const INTERVALS = { '5m': 300_000, '1h': 3_600_000, '4h': 14_400_000 };
const WEIGHT_PER_REQ = (n) => 20 + Math.ceil(n / 60);
// what a complete coin needs (windows per horizon): 5,000 candles are requested, so far fewer means the API truncated the answer
const MIN_N = { '5m': 4000, '1h': 4000, '4h': 1000 };
const MIN_COIN_SHARE = 0.8;       // of the requested coins, and of the coins an existing table already covers
const MAX_ERROR_SHARE = 0.2;      // of the requests

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };

/** Pure: thresholds (in percent) from absolute candle changes (fractions). null when the sample is too short. */
function tiers(absChanges) {
  const n = absChanges.length;
  if (n < MIN_WINDOWS) return null;
  const s = [...absChanges].sort((a, b) => a - b);
  const at = (q) => s[Math.min(n - 1, Math.floor(q * n))];
  const cap = 1 - MIN_EXCEEDANCES / n;                      // the highest quantile with MIN_EXCEEDANCES points beyond it
  const qN = Math.min(NOMINAL.notable, cap);
  const qS = Math.min(NOMINAL.sharp, cap);
  const supportedExtreme = NOMINAL.extreme <= cap;
  const notable = at(qN), sharp = Math.max(at(qS), notable);
  const extreme = supportedExtreme ? Math.max(at(NOMINAL.extreme), sharp) : Math.max(s[n - 1], sharp);
  const pct = (x) => Number((x * 100).toPrecision(4));
  return {
    n, q_notable: Number(qN.toFixed(5)), q_sharp: Number(qS.toFixed(5)),
    extreme_basis: supportedExtreme ? 'p99.99' : 'sample_max',
    notable_pct: pct(notable), sharp_pct: pct(sharp), extreme_pct: pct(extreme),
  };
}

/** Pure: complete candles -> { closes, abs changes }. The candle still open (T after now) is dropped. */
function windowsOf(candles, nowMs) {
  const done = candles.filter((c) => Number(c.T) <= nowMs).sort((a, b) => a.t - b.t);
  const closes = done.map((c) => Number(c.c));
  const abs = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0 && Number.isFinite(closes[i])) abs.push(Math.abs(closes[i] / closes[i - 1] - 1));
  return { done, closes, abs };
}

/** a coin is complete when every horizon is present with at least MIN_N windows */
const complete = (c) => Object.entries(MIN_N).every(([h, n]) => c && c[h] && c[h].n >= n);

/**
 * Pure: may `doc` replace `existing` (null when there is no table yet)? -> { ok, reasons[] }.
 * wanted = the coins the run asked for; requests = how many candle requests it made.
 */
function accept(doc, { wanted, requests, existing = null }) {
  const reasons = [];
  const coins = Object.keys(doc.coins || {});
  const good = coins.filter((c) => complete(doc.coins[c]));
  if (good.length < Math.ceil(wanted * MIN_COIN_SHARE)) reasons.push(`only ${good.length} of ${wanted} requested coins are complete (5m and 1h at least ${MIN_N['5m']} windows, 4h at least ${MIN_N['4h']}); at least ${Math.ceil(wanted * MIN_COIN_SHARE)} needed`);
  const errs = (doc.errors || []).length;
  if (requests > 0 && errs > requests * MAX_ERROR_SHARE) reasons.push(`${errs} of ${requests} requests failed (more than ${MAX_ERROR_SHARE * 100}%)`);
  if (existing && existing.coins) {
    const had = Object.keys(existing.coins);
    const kept = had.filter((c) => doc.coins && doc.coins[c]);
    if (had.length && kept.length < Math.ceil(had.length * MIN_COIN_SHARE)) reasons.push(`the new table covers only ${kept.length} of the ${had.length} coins the current one covers (at least ${Math.ceil(had.length * MIN_COIN_SHARE)} needed)`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** write `text` to `file` through a temp file in the same directory, then rename; the temp file never survives a failure */
function writeAtomic(file, text, fsImpl = fs) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fsImpl.writeFileSync(tmp, text); fsImpl.renameSync(tmp, file); }
  catch (e) { try { fsImpl.unlinkSync(tmp); } catch { /* nothing was written */ } throw e; }
}

async function post(body, fetchImpl = fetch) {
  const r = await fetchImpl(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (r.status === 429) { const e = new Error('429'); e.status = 429; throw e; }
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return r.json();
}

async function run({ coinsN = 30, gapMs = 6500, out, closesOut, log = console.error, fetchImpl = fetch, nowMs = Date.now(), sleepFn = sleep, fsImpl = fs, shipped = path.join(__dirname, '..', 'tools', 'briefs', 'calibration.json') } = {}) {
  const [meta, ctxs] = await post({ type: 'metaAndAssetCtxs' }, fetchImpl);
  const ranked = meta.universe.map((u, i) => ({ coin: u.name, oi_usd: Number(ctxs[i] && ctxs[i].openInterest) * Number(ctxs[i] && ctxs[i].markPx), delisted: u.isDelisted }))
    .filter((r) => !r.delisted && Number.isFinite(r.oi_usd)).sort((a, b) => b.oi_usd - a.oi_usd).slice(0, coinsN);
  const result = { coins: {}, errors: [] };
  const closesFile = {};
  let weight = WEIGHT_PER_REQ(1);
  let requests = 0;
  for (const { coin } of ranked) {
    for (const [iv, ms] of Object.entries(INTERVALS)) {
      await sleepFn(gapMs);
      let candles = null;
      requests++;
      for (let attempt = 0; attempt < 2 && !candles; attempt++) {
        try { candles = await post({ type: 'candleSnapshot', req: { coin, interval: iv, startTime: nowMs - 5000 * ms, endTime: nowMs } }, fetchImpl); }
        catch (e) { if (e.status === 429 && attempt === 0) { log(`429 on ${coin} ${iv}, waiting 30 s`); await sleepFn(30000); } else { result.errors.push({ coin, interval: iv, error: e.message }); break; } }
      }
      if (!candles) continue;
      weight += WEIGHT_PER_REQ(candles.length);
      const w = windowsOf(candles, nowMs);
      const t = tiers(w.abs);
      if (!t) { result.errors.push({ coin, interval: iv, error: `only ${w.abs.length} complete windows (need ${MIN_WINDOWS})` }); continue; }
      (result.coins[coin] ||= {})[iv] = { ...t, from: new Date(w.done[0].t).toISOString(), to: new Date(w.done[w.done.length - 1].T).toISOString() };
      if (iv === '5m') closesFile[coin] = { t0: w.done[0].t, step_ms: ms, closes: w.closes.map((x) => Number(x.toPrecision(7))) };
      log(`${coin} ${iv} n=${t.n} notable ${t.notable_pct}% sharp ${t.sharp_pct}% extreme ${t.extreme_pct}%`);
    }
  }
  const doc = {
    source: 'Hyperliquid info API, candleSnapshot (https://api.hyperliquid.xyz/info)',
    docs: ['https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint', 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits'],
    fetched_at: new Date(nowMs).toISOString(),
    coins_by: 'open interest in USD at fetch time, top ' + coinsN + ' of the default dex',
    window_kind: 'close-to-close change of one complete candle of the interval (non-overlapping windows)',
    nominal_quantiles: NOMINAL, min_exceedances: MIN_EXCEEDANCES, min_windows: MIN_WINDOWS,
    request_weight_total: weight, requests_gap_ms: gapMs,
    coins: result.coins, errors: result.errors,
  };
  let existing = null;
  // the table to protect: the file being replaced, or, on the first run, the table that ships with the code
  if (out) for (const f of [out, shipped]) { try { existing = JSON.parse(fsImpl.readFileSync(f, 'utf8')); break; } catch { existing = null; } }
  const verdict = accept(doc, { wanted: coinsN, requests, existing });
  doc.accepted = verdict.ok;
  if (out) {
    if (verdict.ok) { writeAtomic(out, JSON.stringify(doc, null, 1), fsImpl); log(`wrote ${out}: ${Object.keys(doc.coins).length} coins`); }
    else log(`NOT written (${out} keeps its current table): ${verdict.reasons.join('; ')}`);
  }
  if (closesOut && verdict.ok) fsImpl.writeFileSync(closesOut, JSON.stringify({ source: doc.source, fetched_at: doc.fetched_at, coins: closesFile }));
  return Object.assign(doc, { rejected: verdict.ok ? undefined : verdict.reasons });
}

if (require.main === module) {
  run({ coinsN: Number(arg('--coins', 30)), gapMs: Number(arg('--gap-ms', 6500)), out: arg('--out'), closesOut: arg('--closes-out') })
    .then((d) => { console.error(`done: ${Object.keys(d.coins).length} coins, ${d.errors.length} errors, weight ${d.request_weight_total}`); if (d.rejected) process.exit(2); })
    .catch((e) => { console.error('failed:', e.message); process.exit(1); });
}
module.exports = { tiers, windowsOf, accept, writeAtomic, run, NOMINAL, MIN_EXCEEDANCES, MIN_WINDOWS, MIN_N, INTERVALS };

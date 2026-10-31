#!/usr/bin/env node
// ops/r23-kline-warm.mjs: fill (and keep filling) the 15-minute candle cache of get_cascade_backtest from Hyperliquid's public candleSnapshot (R23, T2).
//
//   node ops/r23-kline-warm.mjs <symbols|top:N|rows:N> --from 2026-07-08 [--cache DIR] [--liq-db PATH] [--gap-ms 6500] [--stale-min 60] [--dry-run]
//
//   symbols   comma list of tape symbols or bases (BTC,ETHUSDT,kPEPE)
//   top:N     the N tape symbols with the most liquidation USD that Hyperliquid also lists (the default universe: top:20)
//   rows:N    the N tape symbols with the most tape prints that Hyperliquid also lists (the heaviest to compute: the speed bench uses this too)
//   --from    earliest day wanted. Hyperliquid keeps only the latest 5,000 candles of an interval (52 days at 15 minutes), so an earlier date gets whatever it still has and the
//             script says how much that was; days already in the cache are never deleted, so running it daily lets the history grow past 52 days.
//   --cache   default $R23_CANDLE_CACHE, else /opt/agentfeed/r23-cache/candles
//   --liq-db  default $LIQ_DB, else /opt/agentfeed/liquidations.db (opened READ-ONLY; only top:N / rows:N read it)
//   --gap-ms  pause between Hyperliquid calls (default 6500: the documented weight limit is 1200 a minute per IP and one 5,000-candle call weighs 104; on the box use 15000, as the
//             weekly calibration job does, because the other Hyperliquid collectors share the address)
//   --stale-min  a symbol whose newest cached candle is younger than this and whose days are all present makes NO call (default 60): re-running is free
//   --dry-run list what would be fetched, call nothing
// One call per symbol: a 5,000-candle answer holds the whole 52 days. Resumable and idempotent: a day already cached is merged, never lost; an interrupted run is simply run again.
// Exit status 0 when every chosen symbol is cached, 2 when any failed.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = require(path.join(root, 'tools/r23/cascade-backtest/config.js'));
const K = require(path.join(root, 'tools/r23/cascade-backtest/candles.js'));
const HLP = require(path.join(root, 'tools/hlperp.js'));

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const spec = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
if (!spec) { console.error('usage: node ops/r23-kline-warm.mjs <symbols|top:N|rows:N> --from YYYY-MM-DD [--cache DIR] [--liq-db PATH] [--gap-ms 6500] [--stale-min 60] [--dry-run]'); process.exit(64); }
const dir = flag('--cache', C.cacheDir());
const liqDb = flag('--liq-db', process.env.LIQ_DB || '/opt/agentfeed/liquidations.db');
const gapMs = Number(flag('--gap-ms', 6500));
const staleMs = Number(flag('--stale-min', 60)) * C.MIN;
const dry = argv.includes('--dry-run');
const fromArg = flag('--from', null);
const fromMs = fromArg ? Date.parse(`${fromArg}T00:00:00Z`) : Date.now() - C.SOURCE_RETENTION_CANDLES * C.STEP_MS;
if (!Number.isFinite(fromMs)) { console.error(`--from must be YYYY-MM-DD, got ${fromArg}`); process.exit(64); }
if (!Number.isFinite(gapMs) || gapMs < 0) { console.error('--gap-ms must be a number of milliseconds'); process.exit(64); }

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INFO = C.HL_INFO();

async function post(body) {
  const r = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(C.FETCH_TIMEOUT_MS * 3) });
  if (!r.ok) throw new Error(`Hyperliquid answered HTTP ${r.status}`);
  return r.json();
}

// the main-dex perps Hyperliquid lists (name -> name), so tools/hlperp.js's own mapping (1000PEPE -> kPEPE, case) decides the coin
const meta = await post({ type: 'meta' });
const listed = new Map(meta.universe.filter((u) => !u.isDelisted).map((u) => [u.name, u.name]));
const coinOf = (symbol) => HLP._canonical(listed, symbol.replace(/USDT$/, ''));
log(`Hyperliquid lists ${listed.size} perps`);

// ---- which symbols
let symbols = [];
const rank = /^(top|rows):(\d+)$/.exec(spec);
if (rank) {
  const n = Math.min(Math.max(Number(rank[2]), 1), 200);
  const Database = require('better-sqlite3');
  const db = new Database(liqDb, { readonly: true, fileMustExist: true });
  const order = rank[1] === 'top' ? 'u' : 'c';
  const rows = db.prepare(`SELECT symbol, SUM(usd) AS u, COUNT(*) AS c FROM liquidations GROUP BY symbol ORDER BY ${order} DESC`).all();
  db.close();
  for (const r of rows) {
    if (symbols.length >= n) break;
    if (/^[A-Z0-9]{2,20}USDT$/.test(r.symbol) && coinOf(r.symbol)) symbols.push(r.symbol);
  }
  log(`${spec}: ${symbols.join(',')}`);
} else {
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^k([A-Z0-9]{2,16}?)(?:USDT)?$/.exec(raw);
    const up = m ? `1000${m[1]}USDT` : raw.toUpperCase().endsWith('USDT') ? raw.toUpperCase() : `${raw.toUpperCase()}USDT`;
    if (!/^[A-Z0-9]{2,20}USDT$/.test(up)) { console.error(`not a symbol: ${raw}`); process.exit(64); }
    symbols.push(up);
  }
}

// ---- fetch
let calls = 0, failed = 0;
const nowMs = Date.now();
const nowGrid = Math.floor(nowMs / C.STEP_MS) * C.STEP_MS;
const retentionStart = K.dayStartOf(nowGrid - C.SOURCE_RETENTION_CANDLES * C.STEP_MS);
for (const symbol of symbols) {
  const coin = coinOf(symbol);
  if (!coin) { log(`${symbol}: Hyperliquid lists no perp for it, skipped`); failed++; continue; }
  const series = K.loadSeries(dir, symbol);
  const wantFrom = Math.max(K.dayStartOf(fromMs), retentionStart);
  // complete enough? the newest candle is fresh and no day between the wanted start and now is missing or damaged
  let holes = [];
  if (series) holes = [...series.corruptDays, ...series.holes()].filter((d) => d >= Math.max(wantFrom, series.base));
  const missingHead = !series || series.base > wantFrom + C.DAY_MS;   // days before the oldest cached day that Hyperliquid may still have
  const fresh = series && series.lastThrough >= nowGrid - staleMs;
  if (series && fresh && !holes.length && !missingHead) { log(`${symbol} (${coin}): cache is complete, ${series.nDays} days to ${new Date(series.lastThrough).toISOString()}, no call`); continue; }
  if (series && fresh && !holes.length && missingHead && series.base <= retentionStart + C.DAY_MS) { log(`${symbol} (${coin}): cache is complete (oldest day ${new Date(series.base).toISOString().slice(0, 10)} is Hyperliquid's own limit), no call`); continue; }
  if (dry) { log(`${symbol} (${coin}): would fetch from ${new Date(wantFrom).toISOString().slice(0, 10)}`); continue; }
  if (calls > 0) await sleep(gapMs);
  calls++;
  let candles = null;
  for (let attempt = 0; attempt < 2 && !candles; attempt++) {
    try { candles = await K.fetchCandlesHL({ coin, startMs: wantFrom, endMs: nowMs }); } catch (e) {
      if (/rate limiting/.test(e.message) && attempt === 0) { log(`${symbol}: 429, waiting 30 s`); await sleep(30000); } else { log(`${symbol}: FAILED ${e.message}`); failed++; break; }
    }
  }
  if (!candles) continue;
  if (!candles.length) { log(`${symbol} (${coin}): Hyperliquid returned no candles`); failed++; continue; }
  K.writeMeta(dir, symbol, coin);
  const written = K.ingest(dir, symbol, candles, wantFrom, nowMs);
  const after = K.loadSeries(dir, symbol);
  log(`${symbol} (${coin}): ${candles.length} candles from ${new Date(candles[0].t).toISOString()}, ${written} day files written; cache now ${after ? after.nDays : 0} days, first candle ${after ? new Date(after.firstCandle).toISOString() : '-'}${candles[0].t > fromMs + C.DAY_MS ? ` (asked for ${new Date(fromMs).toISOString().slice(0, 10)}: Hyperliquid keeps only the latest ${C.SOURCE_RETENTION_CANDLES} candles)` : ''}`);
}
log(`done: ${symbols.length} symbols, ${calls} Hyperliquid calls, ${failed} failed`);
process.exit(failed ? 2 : 0);

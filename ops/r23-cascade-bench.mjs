#!/usr/bin/env node
// ops/r23-cascade-bench.mjs: the speed gate of get_cascade_backtest (R23, T2). READ-ONLY: opens the tape with readonly:true, reads the candle cache, never refreshes it, writes nothing.
//
//   node ops/r23-cascade-bench.mjs --db /opt/agentfeed/liquidations.db --cache /opt/agentfeed/r23-cache/candles [--symbols top:20|rows:20|all|BTC,ETH] [--n 12] [--max-p95-ms 8000]
//
// For each symbol it runs N queries with varied side, threshold, window and cooldown (a fixed schedule, so two runs are comparable) through the module's own backtest(), in
// ROUND-ROBIN order over the symbols (query 1 of every symbol, then query 2 of every symbol ...), which is the cold, interleaved pattern of real traffic: no symbol's pages stay warm
// between two of its own queries. Prints p50 / p95 / max per symbol and overall, the resident memory before, after and at its peak, and PASS or FAIL against --max-p95-ms.
// top:N / rows:N rank the symbols that are in the cache by liquidation USD / by tape prints. A query refused with a 400 (more than the event cap at that threshold) is timed and
// counted as `refused`: the scan ran, so its cost is real.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = require(path.join(root, 'tools/r23/cascade-backtest/config.js'));
const K = require(path.join(root, 'tools/r23/cascade-backtest/candles.js'));
const { backtest, openTape } = require(path.join(root, 'tools/r23/cascade-backtest/backtest.js'));

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const dbPath = flag('--db', process.env.LIQ_DB || '/opt/agentfeed/liquidations.db');
const cacheDir = flag('--cache', C.cacheDir());
const spec = flag('--symbols', 'top:20');
const N = Math.min(Math.max(Number(flag('--n', 12)), 1), 200);
const maxP95 = Number(flag('--max-p95-ms', 8000));

const rssMB = () => Math.round(process.memoryUsage().rss / 1048576 * 10) / 10;
const rss0 = rssMB();
const db = openTape(dbPath);
const supported = K.listSupported(cacheDir);
if (!supported.length) { console.error(`no cached symbols in ${cacheDir}: run ops/r23-kline-warm.mjs first`); process.exit(3); }

let chosen;
const rank = /^(top|rows):(\d+)$/.exec(spec);
if (rank) {
  const stat = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(usd), 0) AS u FROM liquidations WHERE symbol = ?');
  const rows = supported.map((s) => ({ ...s, ...stat.get(s.symbol) }));
  rows.sort((a, b) => (rank[1] === 'top' ? b.u - a.u : b.c - a.c));
  chosen = rows.slice(0, Number(rank[2]));
} else if (spec === 'all') chosen = supported;
else {
  const want = spec.split(',').map((s) => s.trim().toUpperCase()).map((s) => (s.endsWith('USDT') ? s : `${s}USDT`));
  chosen = want.map((w) => supported.find((s) => s.symbol === w)).filter(Boolean);
}
if (!chosen.length) { console.error('no symbol chosen'); process.exit(3); }

// the schedule: deterministic, varied on every axis, thresholds from small to large
const SIDES = ['both', 'long', 'short'];
const MINS = [50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000];
const WINS = [1, 5, 15, 30, 60];
const COOLS = [60, 15, 240, 1440, 120];
const query = (i) => ({ sideMode: SIDES[i % 3], minUsd: MINS[(i * 5 + 1) % MINS.length], windowMin: WINS[(i * 3) % WINS.length], cooldownMin: COOLS[(i * 7) % COOLS.length] });

const pq = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : null; };
const times = new Map(chosen.map((c) => [c.symbol, []]));
const outcome = { ok: 0, refused: 0, notCovered: 0, other: 0 };
let peak = rss0;
for (let i = 0; i < N; i++) {
  for (const c of chosen) {
    const q = query(i);
    const t0 = process.hrtime.bigint();
    try { await backtest({ symbol: c.symbol, coin: c.coin, ...q }, { db, cacheDir, offline: true }); outcome.ok++; } catch (e) {
      if (e.kind === 'bad_request') outcome.refused++; else if (e.status === 404) outcome.notCovered++; else { outcome.other++; console.error(`${c.symbol} query ${i}: ${e.message}`); }
    }
    times.get(c.symbol).push(Number(process.hrtime.bigint() - t0) / 1e6);
    peak = Math.max(peak, rssMB());
  }
}
const all = [...times.values()].flat();
const f = (x) => (x == null ? '-' : x.toFixed(0).padStart(6));
console.log(`tape ${dbPath}\ncache ${cacheDir}\nsymbols ${chosen.length} (${spec}), ${N} queries each, ${all.length} queries, outcomes ${JSON.stringify(outcome)}\n`);
console.log('symbol            p50ms  p95ms  maxms');
for (const c of chosen) { const t = times.get(c.symbol); console.log(`${c.symbol.padEnd(16)} ${f(pq(t, 0.5))} ${f(pq(t, 0.95))} ${f(Math.max(...t))}`); }
const p95 = pq(all, 0.95);
console.log(`\nALL              ${f(pq(all, 0.5))} ${f(p95)} ${f(Math.max(...all))}   (p50 / p95 / max over ${all.length} queries)`);
console.log(`resident memory: start ${rss0} MB, end ${rssMB()} MB, peak ${peak} MB`);
console.log(`GATE speed: ${p95 < maxP95 ? 'PASS' : 'FAIL'} (p95 ${p95.toFixed(0)} ms, limit ${maxP95} ms)`);
process.exit(p95 < maxP95 ? 0 : 1);

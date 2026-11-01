#!/usr/bin/env node
// ops/r24-company-check-mem.js: resident-memory growth of tools/r24/company-check (R24 item 5): 3 fresh processes, 20 calls each, from the disk cache with the network off (0 calls).
// The 20 calls: 10 whole companyCheck() calls (the ten companies of the gate case list: two documents each, a fresh result cache so every document is read and tested; the SEC company list is held for 24 hours as in production, so it is parsed once) and 10 readFiling() calls on the
// largest annual report this work read that is under the 5 MB limit (Xcel Energy's 10-K for 2025, 4.98 MiB), also uncached. The insider function and the site read are stubs (their memory is not this module's).
// rss is read before the module is required, after it is required, after each call, and after a forced garbage collection; the peak is the largest value seen, sampled every 2 ms during the calls.
// usage: node ops/r24-company-check-mem.js [--cache DIR]      (the parent starts the three children with --expose-gc)
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const CACHE = arg('--cache', '/Volumes/D/r24/cache/company-check');
const MB = (b) => Math.round((b / 1048576) * 10) / 10;

if (process.env.R24_MEM_CHILD !== '1') {
  const runs = [];
  for (let i = 1; i <= 3; i++) {
    const r = spawnSync(process.execPath, ['--expose-gc', __filename, '--cache', CACHE], { env: { ...process.env, R24_MEM_CHILD: '1' }, encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
    runs.push(JSON.parse(r.stdout.trim().split('\n').pop())); console.log(`process ${i}: ${JSON.stringify(runs[i - 1])}`);
  }
  const g = runs.map((r) => r.growth_mb);
  console.log(`\nrss growth over the 20 calls (after the calls minus before the module was required), MB: ${g.join(', ')}  | after a forced GC: ${runs.map((r) => r.growth_after_gc_mb).join(', ')}  | peak above baseline: ${runs.map((r) => r.peak_mb).join(', ')}  | module load: ${runs.map((r) => r.load_mb).join(', ')}`);
  process.exit(0);
}

(async () => {
  const rss = () => process.memoryUsage().rss;
  const before = rss();
  const CC = require('../tools/r24/company-check');
  const E = require('../tools/r24/company-check/edgar');
  const { makeDiskFetch } = require('./r24-company-check-cache');
  const loaded = rss();
  const fetch = makeDiskFetch({ dir: CACHE, inner: E.defaultEdgarFetch, offline: true });
  const stubDeps = { fetch, getInsiderTrades: async () => ({ window_days: 90, filings_capped: false, form4_filings: 0, transactions: 0, open_market_buys_usd: 0, open_market_sales_usd: 0, trades: [] }), getSiteSignals: async () => { throw new Error('stub'); } };
  const tickers = ['MU', 'AMD', 'V', 'JNJ', 'MA', 'AWHL', 'MDCX', 'CVR', 'BISA', 'SCKT'];
  const big = { row: { form: '10-K', accession: '0000072903-26-000009', primary_document: 'xel-20251231.htm' }, cik: '0000072903' };
  let peak = rss(); const timer = setInterval(() => { peak = Math.max(peak, rss()); }, 2);
  const none = { get: () => undefined, set: () => {} };
  let bigChars = 0;
  const CALLS = Number(process.env.R24_MEM_CALLS || 20); const series = [];
  for (let i = 0; i < CALLS; i++) {
    if (i % 2 === 0) { await CC.companyCheck({ q: tickers[(i / 2) % tickers.length] }, { ...stubDeps, gate: CC.makeGate(), lane: CC.makeLane(), cache: CC.makeCache() }); }
    else { const r = await CC.readFiling(big.row, big.cik, { ...stubDeps, now: Date.now, cache: none, maxDocBytes: E.MAX_DOC }); bigChars = r.chars; }
    peak = Math.max(peak, rss()); if ((i + 1) % 10 === 0) series.push(MB(rss() - before));
  }
  clearInterval(timer);
  const after = rss();
  global.gc(); global.gc();
  const afterGc = rss();
  console.log(JSON.stringify({ before_mb: MB(before), loaded_mb: MB(loaded), load_mb: MB(loaded - before), after_mb: MB(after), growth_mb: MB(after - before), growth_after_gc_mb: MB(afterGc - before), peak_mb: MB(peak - before), largest_document_chars: bigChars, calls: CALLS, rss_growth_every_10_calls_mb: series, heap_used_after_gc_mb: MB(process.memoryUsage().heapUsed) }));
})().catch((e) => { console.error(e); process.exit(1); });

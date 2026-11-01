#!/usr/bin/env node
// ops/r24-company-check-mem2.js: the v2 memory measurement (GATES-r24-5-v2.md rule 3): ONE fresh process runs the 10 companies in sequence, with a garbage collection forced before each document is read
// (the tool's `beforeRead` hook), and the resident set is compared from the very start of the process (before the tool, zod, site-signals ... are required) to the end of the tenth company.
// Reported: start, end, growth, growth after one more forced GC, the peak seen (sampled every 2 ms), and the same growth measured from after the shared dependencies were loaded (what the server adds).
// The documents, filing lists and insider results come from the disk cache with the network off (0 calls); site reads are not made (a stub: their memory is site-signals', not this tool's).
// usage: node --expose-gc ops/r24-company-check-mem2.js --tickers MU,AMD,V,... [--cache DIR]       (run it without --expose-gc and it starts a child that has it)
'use strict';
const startRss = process.memoryUsage().rss;           // before any module of the tool is loaded
const path = require('path');
const { spawnSync } = require('child_process');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const MB = (b) => Math.round((b / 1048576) * 10) / 10;

if (typeof global.gc !== 'function') {
  const runs = [];
  const n = Number(arg('--runs', '3'));
  for (let i = 1; i <= n; i++) {
    const r = spawnSync(process.execPath, ['--expose-gc', __filename, ...process.argv.slice(2)], { encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
    runs.push(JSON.parse(r.stdout.trim().split('\n').pop())); console.log(`process ${i}: ${JSON.stringify(runs[i - 1])}`);
  }
  console.log(`\ngrowth from process start to the end of the ${runs[0].companies} companies, MB: ${runs.map((r) => r.growth_mb).join(', ')}  | after a forced GC: ${runs.map((r) => r.growth_after_gc_mb).join(', ')}  | peak above start: ${runs.map((r) => r.peak_mb).join(', ')}  | from after the shared dependencies: ${runs.map((r) => r.growth_from_deps_mb).join(', ')}`);
  process.exit(0);
}

(async () => {
  const CACHE = arg('--cache', '/Volumes/D/r24/cache/company-check');
  const tickers = arg('--tickers', 'MU,AMD,V,JNJ,MA,AWHL,MDCX,CVR,BISA,SCKT').split(',');
  // the dependencies the server has loaded anyway (zod and site-signals are not among them here: the tool loads zod only to build its route entry and site-signals only when a site is read)
  require('../lib/safe-fetch'); require('../tools/sec'); require('../tools/r23/claim-check/text'); require('../tools/r23/common');
  const afterDeps = process.memoryUsage().rss;
  const CC = require('../tools/r24/company-check');
  const E = require('../tools/r24/company-check/edgar');
  const { makeDiskFetch, makeDiskStream } = require('./r24-company-check-cache');
  const fs = require('fs');
  const insiderDir = path.join(CACHE, 'insider');
  const insider = async (a) => { const f = fs.readdirSync(insiderDir).filter((x) => x.startsWith(`${a.ticker}-${a.days}-`)).sort().pop(); if (!f) return { window_days: a.days, filings_capped: false, form4_filings: 0, transactions: 0, open_market_buys_usd: 0, open_market_sales_usd: 0, trades: [] }; return JSON.parse(fs.readFileSync(path.join(insiderDir, f), 'utf8')); };
  const deps = { fetch: makeDiskFetch({ dir: CACHE, inner: E.defaultEdgarFetch, offline: true }), stream: makeDiskStream({ dir: CACHE, inner: E.streamDocument, offline: true }),
    getInsiderTrades: insider, getSiteSignals: async () => { throw new Error('stub'); }, beforeRead: () => global.gc() };
  let peak = process.memoryUsage().rss; const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
  let docs = 0; const inner = deps.stream; deps.stream = (u, o, cb) => { docs++; return inner(u, o, cb); };
  const sizes = [];
  for (const t of tickers) { const a = await CC.companyCheck({ q: t }, deps); sizes.push(`${t}:${a.latest_10k.chars_read || 0}`); peak = Math.max(peak, process.memoryUsage().rss); }
  clearInterval(timer);
  const end = process.memoryUsage().rss; global.gc(); global.gc(); const endGc = process.memoryUsage().rss;
  console.log(JSON.stringify({ companies: tickers.length, documents_read: docs, start_mb: MB(startRss), end_mb: MB(end), growth_mb: MB(end - startRss), growth_after_gc_mb: MB(endGc - startRss), peak_mb: MB(peak - startRss), growth_from_deps_mb: MB(end - afterDeps), deps_load_mb: MB(afterDeps - startRss) }));
})().catch((e) => { console.error(e); process.exit(1); });

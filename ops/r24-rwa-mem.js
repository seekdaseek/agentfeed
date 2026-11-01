#!/usr/bin/env node
// ops/r24-rwa-mem.js: resident-memory growth of get_rwa_yields (R24, item 3). Three fresh processes; each takes rss, requires the route module, makes 20 calls (alternating all products and one
// product, the head moving 6 hours per call so the history cache keeps turning over, answer cache off), takes rss again, and reports the growth. The synthetic chain of the tests answers
// (no network). The growth includes the code, the fixture chain used to answer, the 4 MB or so of JSON the calls build and drop, and whatever the allocator has not returned yet.
//   node ops/r24-rwa-mem.js
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

if (process.argv[2] === 'child') {
  // 'server' mode: what the real server has already loaded before this route's first call (zod, better-sqlite3, the R23 refusals, and the fetch machinery that other routes warmed up)
  if (process.argv[3] === 'server') {
    require('zod'); require('better-sqlite3'); require('../tools/r23/common');
    const http = require('http'); const srv = http.createServer((q, r) => r.end('{}')); srv.listen(0, '127.0.0.1', async () => { await (await fetch(`http://127.0.0.1:${srv.address().port}/`)).text(); srv.close(); measure(); });
  } else measure();
}
function measure() {
  const before = process.memoryUsage().rss;
  const C = require('../test/fixtures/r24/rwa/chain');
  const R = require('../tools/r24/rwa/rpc');
  const M = require('../tools/r24/rwa');
  const E = require('../tools/r24/rwa/evaluate');
  const afterLoad = process.memoryUsage().rss;
  (async () => {
    let peak = afterLoad; const ids = E.servedIds();
    for (let i = 0; i < 20; i++) {
      const chain = C.makeChain({ headTs: C.HEAD_TS + i * 21600 });
      const endpoints = { 'https://rpc-a.example': { mode: 'ok' } };
      const rpc = R.makeRpc({ endpoints: Object.keys(endpoints), fetchImpl: chain.fetchFor(endpoints), now: chain.clock, budget: 400 });
      await M.getRwaYields(i % 2 ? { product: ids[i % ids.length] } : {}, { rpc, now: chain.clock, snapshotDb: null });
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    if (global.gc) global.gc();
    const after = process.memoryUsage().rss;
    console.log(JSON.stringify({ before, afterLoad, after, peak, heap: process.memoryUsage().heapUsed, stores: { history: E.SHARED.history.size(), blocks: E.SHARED.blocks.size(), answers: E.SHARED.answers.size() } }));
  })();
}
if (process.argv[2] !== 'child') {
  const mb = (n) => (n / 1048576).toFixed(2);
  for (const mode of ['cold', 'server']) {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const r = spawnSync(process.execPath, ['--expose-gc', __filename, 'child', mode], { encoding: 'utf8', cwd: path.resolve(__dirname, '..') });
      if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
      rows.push(JSON.parse(r.stdout.trim().split('\n').pop()));
    }
    console.log(`== ${mode === 'cold' ? 'fresh process, nothing preloaded' : 'server-like: zod, better-sqlite3, the R23 refusals and the fetch machinery already loaded'}`);
    rows.forEach((x, i) => console.log(`run ${i + 1}: before ${mb(x.before)} MB, after require ${mb(x.afterLoad)} MB (+${mb(x.afterLoad - x.before)}), after 20 calls ${mb(x.after)} MB (+${mb(x.after - x.before)} vs before), peak ${mb(x.peak)} MB, heap ${mb(x.heap)} MB; stores ${JSON.stringify(x.stores)}`));
    const g = rows.map((x) => x.after - x.before).sort((a, b) => a - b);
    console.log(`growth (before -> after 20 calls): min ${mb(g[0])} MB, median ${mb(g[1])} MB, max ${mb(g[2])} MB`);
  }
}

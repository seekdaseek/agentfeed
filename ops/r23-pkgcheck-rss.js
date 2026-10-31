#!/usr/bin/env node
// ops/r23-pkgcheck-rss.js: resident-memory cost of tools/r23/pkg-check*.js, measured in a fresh process (R23 T5).
//   node [--expose-gc] ops/r23-pkgcheck-rss.js [--small] [exploreDir]      (--small: lodash 0.25 MB and requests 0.19 MB instead of express and numpy)
// Baseline = the process after requiring what the real server has loaded anyway (zod, lib/safe-fetch). Then: require the module; run 20 checks over REAL registry documents
// (express 0.8 MB and numpy 3.7 MB, the cache folder's copies of the live responses, plus a 24 KB OSV answer) with the answer cache effectively off so every call parses its document.
// No network call is made. Prints JSON: rss in MB at each step.
'use strict';
const fs = require('fs');
const path = require('path');
const dir = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) || '/Volumes/D/r23/cache/pkgcheck/explore';
const mb = () => Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;

require('zod'); require('../lib/safe-fetch');
// (the documents are loaded before the baseline is taken: they are the harness's data, not the tool's)

// the documents are read ONCE and handed out as the same Buffer every time: copying a 3.7 MB buffer per fake response would measure the harness (on macOS freed large buffers
// stay in the process: 20 copies alone were 45 MB of resident memory), not the tool. In production the body is the Buffer lib/safe-fetch.js built (its chunks plus one concat).
const small = process.argv.includes('--small');
const NPM = small ? 'lodash' : 'express', PY = small ? 'requests' : 'numpy';
const docs = {
  [`https://registry.npmjs.org/${NPM}`]: fs.readFileSync(path.join(dir, `https___registry_npmjs_org_${NPM}.json`)),
  [`https://pypi.org/pypi/${PY}/json`]: fs.readFileSync(path.join(dir, `https___pypi_org_pypi_${PY}_json.json`)),
};
const osv = fs.readFileSync(path.join(dir, 'osv_lodash_4.17.15.json'));
const notFound = Buffer.from('{}');
const deps = {
  now: Date.now,
  get: async (url) => (docs[url] ? { status: 200, headers: {}, body: docs[url] } : { status: 404, headers: {}, body: notFound }),
  post: async () => ({ status: 200, headers: {}, body: osv }),
  cacheMax: 1,
};
const base = mb();
const heapBefore = Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10;
const P = require('../tools/r23/pkg-check');
const afterRequire = mb();
const { check } = P.makeCheck(deps);
(async () => {
  let peak = 0;
  for (let i = 0; i < 20; i++) {
    await check(i % 2 ? { name: PY, ecosystem: 'pypi' } : { name: NPM, ecosystem: 'npm' });
    peak = Math.max(peak, mb());
  }
  const after20 = mb();
  let afterGc = null, heapAfterGc = null;
  if (global.gc) { global.gc(); afterGc = mb(); heapAfterGc = Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10; }
  const r1 = (x) => Math.round(x * 10) / 10;
  console.log(JSON.stringify({ docs: small ? 'lodash+requests' : 'express+numpy', baseline_mb: base, after_require_mb: afterRequire, after_20_calls_mb: after20, peak_during_calls_mb: peak, growth_after_20_calls_mb: r1(after20 - base), after_gc_mb: afterGc, heap_used_after_gc_mb: heapAfterGc, heap_used_before_mb: heapBefore, heap_retained_growth_mb: heapAfterGc == null ? null : r1(heapAfterGc - heapBefore) }));
})();

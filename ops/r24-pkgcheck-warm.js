#!/usr/bin/env node
// ops/r24-pkgcheck-warm.js: pre-fills the response cache of ops/r24-pkgcheck-select.js (same cache folder, same key) with the first page of the package-level OSV query
// for the first 4,300 names of each pool in the selection's hash order, 6 requests in flight. It changes nothing about the selection: the selection script still decides everything
// and reads these files exactly as it would have fetched them. It never requires the tool.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SEED = 'r24-pkgcheck-1';
const CACHE = '/Volumes/D/r24/cache/pkgcheck/select/http';
const UA = 'agentfeed-r24-case-selection/1.0 (+https://x402.ochinimus.app)';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const npm = [...fs.readFileSync('/Volumes/D/r23/cache/pkgcheck/src/wooorm.top-download.js', 'utf8').matchAll(/^\s*'([^']+)',?\s*$/gm)].map((m) => m[1]);
const py = JSON.parse(fs.readFileSync('/Volumes/D/r24/cache/pkgcheck/select/top-pypi.min.json', 'utf8')).rows.map((r) => r.project);
const jobs = [];
for (const [eco, pool] of [['npm', npm], ['PyPI', py]]) {
  const ordered = [...pool].sort((a, b) => (sha(`${SEED}:${a}`) < sha(`${SEED}:${b}`) ? -1 : 1)).slice(0, 4300);
  for (const name of ordered) jobs.push({ body: { package: { name, ecosystem: eco } } });
}
let i = 0, live = 0, cached = 0, failed = 0;
async function worker() {
  while (i < jobs.length) {
    const { body } = jobs[i++];
    const file = path.join(CACHE, `${sha(`POST\nhttps://api.osv.dev/v1/query\n${JSON.stringify(body)}`)}.json`);
    if (fs.existsSync(file)) { cached++; continue; }
    try {
      const res = await fetch('https://api.osv.dev/v1/query', { method: 'POST', headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      if (res.status !== 200) { failed++; continue; }
      fs.writeFileSync(file, JSON.stringify({ method: 'POST', url: 'https://api.osv.dev/v1/query', at: new Date().toISOString(), status: res.status, text }));
      live++;
    } catch { failed++; }
    await new Promise((r) => setTimeout(r, 300));
    if ((live + cached + failed) % 200 === 0) console.log(`${live + cached + failed}/${jobs.length} live ${live} cached ${cached} failed ${failed}`);
  }
}
Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]).then(() => console.log(`done: live ${live}, cached ${cached}, failed ${failed} of ${jobs.length}`));

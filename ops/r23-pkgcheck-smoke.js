#!/usr/bin/env node
// ops/r23-pkgcheck-smoke.js: a handful of live calls for the URL forms the gate does not touch (scoped npm names, a registry document over the 5 MB cap, PyPI version spellings),
// through the production HTTP code with the same disk cache as the gate (folder smoke/ next to gate/), so a re-run makes zero calls. Not part of the gate.
//   node ops/r23-pkgcheck-smoke.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../tools/r23/pkg-check');
const H = require('../tools/r23/pkg-check-http');

const CACHE = '/Volumes/D/r23/cache/pkgcheck/smoke';
fs.mkdirSync(CACHE, { recursive: true });
let last = 0, live = 0, hit = 0;
async function cached(method, url, body, call) {
  const file = path.join(CACHE, `${crypto.createHash('sha256').update(`${method}\n${url}\n${body ? JSON.stringify(body) : ''}`).digest('hex')}.json`);
  if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); hit++; return { url, status: j.status, headers: j.headers, body: Buffer.from(j.body, 'base64') }; }
  const wait = last + 400 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  let res;
  try { res = await call(); } catch (e) { last = Date.now(); live++; fs.writeFileSync(file, JSON.stringify({ thrown: e.message })); throw e; }
  last = Date.now(); live++;
  fs.writeFileSync(file, JSON.stringify({ method, url, fetched_at: new Date().toISOString(), status: res.status, headers: { 'retry-after': res.headers && res.headers['retry-after'] }, body: res.body.toString('base64') }));
  return res;
}
const deps = { now: Date.now, cacheMax: 1,
  get: async (url, o) => { const file = path.join(CACHE, `${crypto.createHash('sha256').update(`GET\n${url}\n`).digest('hex')}.json`); if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j.thrown) { hit++; throw new Error(j.thrown); } } return cached('GET', url, null, () => H.get(url, o)); },
  post: (url, b, o) => cached('POST', url, b, () => H.post(url, b, o)) };

const CASES = [['npm', '@types/node', null], ['npm', '@babel/core', null], ['npm', 'left-pad', null], ['npm', '@types/node', '22.0.0'], ['pypi', 'numpy', '2.5.4'], ['pypi', 'numpy', '2.5.4.0'], ['pypi', 'django', '2.2.0'], ['pypi', 'django', '2.2'], ['pypi', 'botocore', null], ['pypi', 'botocore', '1.35.0'], ['pypi', 'jellyfish', null]];
(async () => {
  for (const [eco, name, version] of CASES) {
    const { check } = P.makeCheck(deps);
    try {
      const r = await check({ name, ecosystem: eco, ...(version ? { version } : {}) });
      console.log(`${eco} ${name}${version ? '@' + version : ''}: v${r.version} adv=${r.advisory_count} malicious=${r.malicious} flags=[${r.flags.map((f) => `${f.id}:${f.severity}`).join(' ')}] downloads=${r.downloads ? r.downloads.count : 'null'} typo=${r.typosquat.is_top_package ? 'top#' + r.typosquat.rank : r.typosquat.nearest.map((n) => n.name).join(',') || 'none'} owners=${r.maintainers.available ? r.maintainers.count : 'n/a'} age_d=${r.release.age_days} first_d=${r.release.package_age_days}${r.data_gaps ? ' gaps=' + r.data_gaps.map((g) => g.part).join('|') : ''}`);
    } catch (e) { console.log(`${eco} ${name}${version ? '@' + version : ''}: ${e.status || e.kind}: ${e.message}`); }
  }
  console.log(`HTTP: ${live} live, ${hit} from cache`);
})();

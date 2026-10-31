#!/usr/bin/env node
// ops/r23-pkgcheck-build-pypi-data.js: builds tools/r23/data/pkgcheck-top-pypi.json from ops/r23-pkgcheck-pypi-names.txt (R23 T5).
//
// WHY THIS LIST IS HAND-CURATED: hugovk/top-pypi-packages (the usual ranked list) carries NO licence: no LICENSE file at any commit of its history, no licence
// statement in its README or index.html, and the GitHub API reports licence null (checked 2026-10-31). The task said "MIT/CC0"; that could not be verified, so
// the file is NOT bundled. The names below were written by the build agent from general knowledge of widely used PyPI projects (names are facts, no third-party
// list was copied), then each one is checked to exist on PyPI with one polite HEAD request (cached under the cache folder, so a re-run makes no call).
// A name PyPI does not know is dropped and listed in _meta.dropped_unknown. The list is UNRANKED: it is a set of well-known projects, not a download ranking.
//   node ops/r23-pkgcheck-build-pypi-data.js [cacheDir]
'use strict';
const fs = require('fs');
const path = require('path');

const CACHE = process.argv[2] || '/Volumes/D/r23/cache/pkgcheck';
const OUT = path.join(__dirname, '..', 'tools', 'r23', 'data', 'pkgcheck-top-pypi.json');
const EXISTS = path.join(CACHE, 'pypi-exists.json');
const UA = 'agentfeed-pkgcheck-build/1.0 (+https://x402.ochinimus.app)';

const pep503 = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');
const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
if (!NAME.test('python-dateutil') || NAME.test('Bad_Name') || NAME.test('-x')) throw new Error('name pattern fails its positive/negative control');

const raw = fs.readFileSync(path.join(__dirname, 'r23-pkgcheck-pypi-names.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const names = [...new Set(raw.map(pep503))];
for (const n of names) if (!NAME.test(n)) throw new Error(`bad name in the source file: ${n}`);

let known = {};
try { known = JSON.parse(fs.readFileSync(EXISTS, 'utf8')); } catch { /* first run */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let calls = 0;
  for (const n of names) {
    if (known[n] != null) continue;
    let st;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(n)}/json`, { method: 'HEAD', headers: { 'user-agent': UA }, redirect: 'manual' });
      calls++;
      st = res.status;
      if (st === 429 || st >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      break;
    }
    if (st === 301 || st === 308) st = 200;                  // PyPI redirects a non-canonical spelling to the canonical project: it exists
    if (st !== 200 && st !== 404) throw new Error(`unexpected HTTP ${st} for ${n}; re-run later (progress is cached)`);
    known[n] = st;
    fs.writeFileSync(EXISTS, JSON.stringify(known));
    await sleep(250);
  }
  const keep = names.filter((n) => known[n] === 200);
  const dropped = names.filter((n) => known[n] !== 200);
  const doc = {
    _meta: {
      ecosystem: 'pypi',
      source: 'hand-curated by the build agent from general knowledge of widely used PyPI projects; no third-party list was copied',
      source_url: null,
      commit: null,
      commit_date: null,
      retrieved: '2026-10-31',
      selection: `${names.length} candidate names (PEP 503 normalised, duplicates removed); each was checked to exist on PyPI with a HEAD request on 2026-10-31`,
      ranked: false,
      licence: 'original work of the build agent (no third-party licence applies)',
      licence_text: null,
      caveat: 'unranked and not exhaustive: a set of well-known projects, not a download ranking. hugovk/top-pypi-packages was NOT used because it has no licence file, README statement or GitHub licence field',
      dropped_unknown: dropped,
      count: keep.length,
    },
    names: keep,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc) + '\n');
  console.log(`wrote ${OUT}: ${keep.length} names kept, ${dropped.length} dropped (${dropped.join(', ') || 'none'}), ${calls} HTTP calls this run, ${fs.statSync(OUT).size} bytes`);
})().catch((e) => { console.error(e.message); process.exit(1); });

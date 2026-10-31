// ops/r23-x402-live-proof.js: the ONE live proof of the lint (R23 T3): GET https://x402.ochinimus.app/api/time, unpaid and free, through the real lib/safe-fetch.js.
//   node ops/r23-x402-live-proof.js [url]     prints the answer (without the long challenge) and caches the full answer in /Volumes/D/r23/cache/x402/live-lint.json
// A re-run reads the cache and makes 0 calls; delete the file to run it again. The lint sends four requests (the GET, a HEAD and two spellings of the path), none of them paid.
'use strict';
const fs = require('fs');
const path = require('path');
const URL_ = process.argv[2] || 'https://x402.ochinimus.app/api/time';
const CACHE = '/Volumes/D/r23/cache/x402/live-lint.json';
(async () => {
  let out;
  if (fs.existsSync(CACHE)) { out = JSON.parse(fs.readFileSync(CACHE, 'utf8')); console.error(`(from the cache ${CACHE}: 0 calls made)`); } else {
    out = await require(path.join(__dirname, '..', 'tools/r23/x402/lint.js')).lintEndpoint({ url: URL_ }, {});
    fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(out, null, 1));
  }
  const short = { ...out, raw: { ...out.raw, challenge: `(${JSON.stringify(out.raw.challenge).length} characters, in the cache file)` } };
  console.log(JSON.stringify(short, null, 1));
})().catch((e) => { console.error('live proof failed:', e.status || '', e.message); process.exit(1); });

// ops/r23-claimcheck-rss.js: resident-memory cost of the claim-check module (R23 T4), measured in THIS fresh process.
//   1. everything server.js has loaded before this module exists is loaded first (zod, better-sqlite3, the language-model client, webmd, sec, wiki, safe-fetch, the spend ledger),
//      then the baseline rss is taken;
//   2. the module is required: "require adds";
//   3. 20 real claimCheck() calls, with a stand-in model and sources as below, in 4 batches of 5: rss after each batch, and after a forced garbage collection (needs --expose-gc).
// Run it three times for three fresh processes:
//   RSS_WARM=1 in front of either takes the baseline after the young generation of V8 has grown, as in a server that has been up for a while (see the note below).
//   for i in 1 2 3; do node --expose-gc ops/r23-claimcheck-rss.js web; done        sources are ordinary pages of about 30,000 characters (the representative call)
//   for i in 1 2 3; do node --expose-gc ops/r23-claimcheck-rss.js filings; done     sources are the four cached SEC filings of 1.5 to 4.3 MB of HTML (the heavy call; the files are
//                                                                                    in $CLAIMCHECK_GATE_CACHE or ./claimcheck-gate-cache)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const mode = process.argv[2] === 'filings' || process.argv[2] === 'filings+download' ? process.argv[2] : 'web';
const download = mode === 'filings+download';
const ROOT = path.resolve(__dirname, '..');
process.env.GEMINI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrss-'));
const mb = (n) => (n / 1048576).toFixed(1);
require('zod'); require('better-sqlite3');
for (const m of ['tools/llm/gemini', 'tools/llm/page', 'tools/llm/injection-rules', 'tools/webmd', 'tools/sec', 'tools/wiki', 'lib/safe-fetch', 'tools/r23/spend']) require(path.join(ROOT, m));
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/r23/claimcheck/claims.json'), 'utf8'));
const CACHE = process.env.CLAIMCHECK_GATE_CACHE || path.join(ROOT, 'claimcheck-gate-cache');
const bodies = {};                                   // 'filings': the downloads have already happened when the baseline is taken
if (mode === 'filings') for (const f of Object.values(doc.filings)) bodies[f.file] = fs.readFileSync(path.join(CACHE, f.file));
(async () => {
// the server has long since used fetch (undici and the web streams behind Response.json() load lazily on first use, several MB) and URL
await new Response('{"a":1}').clone().json(); void new URL('https://example.org/'); void AbortSignal.timeout(1000);
// RSS_WARM=1: a server that has been serving traffic has long since grown its young generation to the maximum; a fresh process has not, and the first heavy burst grows it
// (tens of MB of RSS that are V8's headroom, not memory of this module). RSS_WARM=1 churns small objects first so the baseline is taken after that growth.
if (process.env.RSS_WARM) { for (let r = 0; r < 400; r++) { const junk = []; for (let i = 0; i < 20000; i++) junk.push({ i, s: `warm-${i}` }); } }
if (global.gc) global.gc();
const base = process.memoryUsage();
const CC = require(path.join(ROOT, 'tools/r23/claim-check'));
const S = require(path.join(ROOT, 'tools/r23/claim-check/sources'));
const { makeSpend } = require(path.join(ROOT, 'tools/r23/spend'));
if (global.gc) global.gc();
const required = process.memoryUsage();
{
  const caps = { perCall: 0.06, perDay: 1000 };
  const spend = makeSpend({ file: ':memory:', caps: { claimcheck: caps } });
  const para = (i) => `Paragraph ${i} of the Harbour Tunnel report discusses the tunnel and its length in kilometres, reference ${i * 7919}, with nothing else to report in this paragraph of the page.`;
  const page = (n) => Array.from({ length: n }, (_, i) => para(i)).join('\n') + '\nThe tunnel is 12.4 kilometres long and carries two rail tracks and one service lane.';
  // the model's answer is canned: reading the prompt back (what the stand-in of the tests does) would put the test double's own allocations into the measure
  const canned = (claim) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ verdict: 'SUPPORTED', quotes: [{ source: 1, text: mode !== 'web' ? doc.claims.find((c) => c.claim === claim).passage : 'The tunnel is 12.4 kilometres long and carries two rail tracks and one service lane.' }] }) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10000, candidatesTokenCount: 80 } });
  const deps = { key: 'synthetic-test-key', fetchImpl: async (u, o) => new Response(JSON.stringify(canned(/CLAIM:\n<<<UNTRUSTED_DATA_BEGIN>>>\n([^\n]*)\n/.exec(JSON.parse(o.body).contents[0].parts[0].text)[1])), { status: 200 }), spend, caps, getWebMarkdown() {}, getPdfMarkdown() {},
    getPageText: async (url) => { const t = page(180); return { kind: 'html', url, final_url: url, title: 't', text: t, chars_total: t.length }; },
    // 'filings': the four bodies exist before the baseline is taken (the download is not counted); 'filings+download': every call receives its body the way lib/safe-fetch hands it
    // over, as chunks of 64 KB that are each their own allocation and are then joined into one Buffer (an allocation pattern this module cannot change)
    fetchSecDoc: async (href) => {
      const f = Object.values(doc.filings).find((x) => x.url === href);
      if (!download) return { url: href, contentType: 'text/html', body: bodies[f.file] };
      const raw = fs.readFileSync(path.join(CACHE, f.file)); const chunks = [];
      if (process.env.RSS_PLAIN_READ) return { url: href, contentType: 'text/html', body: raw };           // the body as one readFileSync Buffer (how the first measurement of this module fed it)
      for (let i = 0; i < raw.length; i += 65536) chunks.push(Buffer.from(raw.subarray(i, i + 65536)));
      return { url: href, contentType: 'text/html', body: Buffer.concat(chunks) };
    } };
  const out = { mode, rss_baseline_mb: mb(base.rss), require_adds_mb: mb(required.rss - base.rss), batches: [] };
  let n = 0; const t0 = Date.now();
  for (let b = 0; b < Number(process.env.CC_BATCHES || 4); b++) {
    for (let i = 0; i < 5; i++, n++) {
      if (mode !== 'web') { const c = doc.claims[n]; await CC.claimCheck({ claim: c.claim, urls: doc.filings[c.filing].url }, { ...deps, cache: S.makeCache({ max: 1 }) }); }
      else await CC.claimCheck({ claim: `The Harbour Tunnel is 12.4 kilometres long. variant ${n}`, urls: `https://www.example.org/page-${n}` }, { ...deps, cache: S.makeCache() });
    }
    const m = process.memoryUsage(); if (global.gc) global.gc(); const g = process.memoryUsage();
    out.batches.push({ calls: n, rss_adds_mb: mb(m.rss - base.rss), after_gc_rss_adds_mb: global.gc ? mb(g.rss - base.rss) : null, after_gc_heap_adds_mb: global.gc ? mb(g.heapUsed - base.heapUsed) : null });
  }
  out.ms = Date.now() - t0;
  console.log(JSON.stringify(out));
  spend.close();
}
})();

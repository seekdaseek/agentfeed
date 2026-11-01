#!/usr/bin/env node
// ops/r24-company-check-gate3.js: the SCORING RUN of the v3 gate (GATES-r24-5-v3.md; the v2 runner, gate2.js, stays as it was). ONE fresh process runs the ten companies of the registered case list in sequence, once, and applies the v2 pass rule:
//   - the flags equal the expected flags (going_concern, delisting_notice_8k) for all 10;  - every verdict line agrees with its flags;  - every fact's source URL is a STATIC EDGAR object (rule 1: a filing document or index under /Archives/edgar/data/..., the data.sec.gov
//     submissions JSON or the XBRL API; no browse-edgar, cgi-bin, search or query-string URL) and resolves (rule 2);
//   - no answer is a size 404 (every company answers);  - memory: the resident set of this process grows by under 60 MB from the start of the process (before the tool is required) to the end of the tenth
//     company, with a garbage collection forced before each document is read (the tool's `beforeRead` hook).
// Rule 2 (the v2 rule 1), "resolves": an HTTP GET with the declared User-Agent, paced under 8 requests/s (7), returns 200; on 403, 429, a 5xx or a socket error it is retried ONCE after 2 s; HEAD is never used. The response body is
// not read (the connection is closed after the status line, so a 40 MB filing costs one status line). A URL that still fails is a failure. Controls: a known-good URL must give 200 and a known-bad one 404.
// The case list is read from GATES-r24-5v3-cases.md after its sha256 is checked against GATES-r24-5v3-cases.sha256, and this runner REFUSES to score twice (a raw output next to the case list means the run has
// happened). `--replay` re-reads the same results from the disk caches with the network off (0 calls) and compares; the memory figure of a replay is of the replay.
// usage: node ops/r24-company-check-gate3.js --cases <dir> [--cache DIR] [--replay] [--skip-urls (dry runs only: the URL phase is not run and the result cannot pass)]        (starts itself again with --expose-gc)
'use strict';
const START_RSS = process.memoryUsage().rss;          // before any module of the tool, of zod or of the runner's own helpers is loaded
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (typeof global.gc !== 'function') {
  const r = spawnSync(process.execPath, ['--expose-gc', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status === null ? 3 : r.status);
}
const crypto = require('crypto');
const https = require('https');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(arg('--cases', '/Volumes/D/agentfeed-briefs/r24-20261101'));
const CACHE = arg('--cache', '/Volumes/D/r24/cache/company-check');
const REPLAY = process.argv.includes('--replay');
const SKIP_URLS = process.argv.includes('--skip-urls');
const CASES_MD = path.join(DIR, 'GATES-r24-5v3-cases.md');
const RAW = path.join(DIR, REPLAY ? 'GATES-r24-5v3-replay.json' : 'GATES-r24-5v3-raw.json');
const MB = (b) => Math.round((b / 1048576) * 10) / 10;

const md = fs.readFileSync(CASES_MD);
const want = fs.readFileSync(path.join(DIR, 'GATES-r24-5v3-cases.sha256'), 'utf8').trim().split(/\s+/)[0];
const have = crypto.createHash('sha256').update(md).digest('hex');
if (want !== have) { console.error(`the case list does not match its registered hash\n  registered ${want}\n  file       ${have}`); process.exit(2); }
const block = /CASES-JSON-BEGIN\s*```json\s*([\s\S]*?)```\s*CASES-JSON-END/.exec(md.toString('utf8'));
if (!block) { console.error('no CASES-JSON block in the case list'); process.exit(2); }
const cases = JSON.parse(block[1]);
if (!REPLAY && fs.existsSync(RAW)) { console.error(`${RAW} exists: this case list has been scored once and may not be scored again (use --replay to re-read it from the cache)`); process.exit(2); }

const E = require('../tools/r24/company-check/edgar');
const CC = require('../tools/r24/company-check');
const H = require('../tools/r24/company-check/html-stream');
const { makeDiskFetch, makeDiskStream } = require('./r24-company-check-cache');

const diskFetch = makeDiskFetch({ dir: CACHE, inner: E.defaultEdgarFetch, offline: REPLAY });
const diskStream = makeDiskStream({ dir: CACHE, inner: E.streamDocument, offline: REPLAY });
// the Form 4 section uses the tool's own reader (insider.js) over the same disk-cached fetcher, so a replay of the Form 4 filings makes 0 calls too

// ---- rule 1: GET, paced under 8/s, one retry after 2 s on 403, 429, 5xx or a socket error, never HEAD, the body is not read ----
const urlDir = path.join(CACHE, 'urlcheck3'); fs.mkdirSync(urlDir, { recursive: true });
const urlStats = { requests: 0 };
const take = E.makeLimiter(7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getOnce(url) {
  return new Promise((resolve) => {
    urlStats.requests++;
    let u; try { u = new URL(url); } catch { resolve(0); return; }
    const req = https.request({ host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'user-agent': E.UA, accept: '*/*', 'accept-encoding': 'identity' }, timeout: 20000 }, (res) => { const s = res.statusCode; res.destroy(); resolve(s); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', () => resolve(0)); req.end();
  });
}
async function resolves(url) {
  const f = path.join(urlDir, crypto.createHash('sha256').update(url).digest('hex') + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  if (REPLAY) return { url, status: null, attempts: 0 };
  await take(); let status = await getOnce(url); let attempts = 1;
  if (status === 403 || status === 429 || status >= 500 || status === 0) { await sleep(2000); await take(); status = await getOnce(url); attempts = 2; }
  const rec = { url, status, attempts, at: new Date().toISOString() }; fs.writeFileSync(f, JSON.stringify(rec)); return rec;
}
const URL_KEYS = /^(source|index_url|document_url|quote_url)$/;
function sourcesOf(answer) {
  const out = []; const missing = [];
  const walk = (o, key) => {
    if (Array.isArray(o)) o.forEach((x) => walk(x, key));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'website') continue; walk(v, k); }
    else if (typeof o === 'string' && URL_KEYS.test(key) && o) out.push(o);
  };
  walk(answer, '');
  for (const s of ['company', 'going_concern', 'latest_10k', 'latest_10q', 'delisting_notice_8k', 'staleness', 'insider_form4']) { const v = answer[s]; if (!v || typeof v.source !== 'string' || !v.source) missing.push(s); }
  answer.recent_8k.forEach((r, i) => { if (!r.source) missing.push(`recent_8k[${i}]`); });
  return { out, missing };
}
// the verdict must agree with the flags: derived here from the flags alone, with different code than verdict.js
function verdictAgrees(a) {
  const v = a.verdict; const f = a.flags;
  const hasGc = /^Going-concern language in /.test(v);
  const hasDe = /delisting notice 8-K \(Item 3\.01\) on \d{4}-\d{2}-\d{2}/.test(v);
  const bothNo = /^No going-concern language and no delisting notice found in the filings read/.test(v);
  const noDe = /no delisting notice 8-K \(Item 3\.01\) in the last 24 months/.test(v);
  const noGc = /^No going-concern language in the /.test(v);
  const gcOk = f.going_concern === true ? hasGc : f.going_concern === false ? (bothNo || noGc) : /could not be checked/.test(v);
  const deOk = f.delisting_notice_8k === true ? hasDe : f.delisting_notice_8k === false ? (bothNo || noDe) : /could not be checked for the full 24 months/.test(v);
  return gcOk && deOk && !(f.going_concern === true && f.delisting_notice_8k === false && bothNo) && /\.$/.test(v);
}
// the quote is a substring of the cited document: the document is streamed again (from the cache) through the scanner and each line, and each pair of neighbouring lines, is searched
async function quoteVerbatim(url, quote) {
  const q = quote.replace(/\s+/g, ' '); let prev = ''; let found = false;
  const sc = H.makeHtmlScanner((l) => { if (found) return; const s = l.replace(/\s+/g, ' '); if (s.includes(q) || (prev + ' ' + s).includes(q)) found = true; prev = s; });
  await diskStream(url, { maxBytes: E.MAX_DOC }, (c) => sc.push(c)); sc.end();
  return found;
}

(async () => {
  const started = new Date().toISOString();
  global.gc(); const afterLoad = process.memoryUsage().rss;
  const bytesRead = { cur: 0 };
  const stream = (u, o, cb) => diskStream(u, o, (c) => { bytesRead.cur += c.length; cb(c); });
  const deps = { fetch: diskFetch, stream, gate: CC.makeGate(), lane: CC.makeLane(), cache: CC.makeCache(), beforeRead: () => global.gc() };
  const results = []; const rssAfter = [];
  let peak = process.memoryUsage().rss; const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
  for (const c of cases.companies) {
    bytesRead.cur = 0; const t0 = Date.now(); let answer = null; let error = null;
    try { answer = await CC.companyCheck({ q: c.q, ...(c.site ? { site: c.site } : {}) }, deps); } catch (e) { error = { status: e.status || null, kind: e.kind || null, message: e.message }; }
    peak = Math.max(peak, process.memoryUsage().rss); rssAfter.push(MB(process.memoryUsage().rss - START_RSS));
    results.push({ case: c, ms: Date.now() - t0, doc_bytes_streamed: bytesRead.cur, answer, error });
    console.log(`${c.ticker.padEnd(5)} ${error ? `ERROR ${error.status} ${error.message}` : `${answer.flags.going_concern}/${answer.flags.delisting_notice_8k}  ${answer.verdict}`}`);
  }
  clearInterval(timer);
  const endRss = process.memoryUsage().rss; global.gc(); global.gc(); const endGcRss = process.memoryUsage().rss;
  const memory = { start_mb: MB(START_RSS), after_modules_loaded_mb: MB(afterLoad), end_mb: MB(endRss), growth_mb: MB(endRss - START_RSS), growth_after_gc_mb: MB(endGcRss - START_RSS), peak_growth_mb: MB(peak - START_RSS), limit_mb: 60, rss_growth_after_each_company_mb: rssAfter, rule: 'one fresh process, 10 companies in sequence, gc forced before each reading, start of process to end' };
  memory.ok = memory.growth_mb < 60;
  console.log(`\nmemory: ${JSON.stringify(memory)}`);

  // ---- score ----
  const controls = [['https://www.sec.gov/', 200], ['https://www.sec.gov/Archives/edgar/data/1/000000000000000000/none.htm', 404]];
  const controlOut = [];
  for (const [u, expect] of SKIP_URLS ? [] : controls) { const r = await resolves(u); controlOut.push({ url: u, expected: expect, got: r.status, ok: REPLAY ? (r.status === expect || r.status === null) : r.status === expect }); }
  const controlsOk = controlOut.every((c) => c.ok);
  const rows = [];
  for (const r of results) {
    const c = r.case; const a = r.answer;
    const row = { ticker: c.ticker, stratum: c.stratum, expected: c.expected, got: a ? a.flags : null, error: r.error, size_404: Boolean(r.error && r.error.status === 404 && /read limit|cannot be read by this tool/.test(r.error.message)), flags_ok: false, verdict_ok: false, sources_total: 0, sources_not_sec: [], sources_not_static: [], sources_failing: [], sections_without_source: [], quote_verbatim: null,
      registered_bytes: { k: c.latest_10k.bytes, q: c.latest_10q.bytes }, doc_bytes_streamed: r.doc_bytes_streamed };
    if (a) {
      row.flags_ok = a.flags.going_concern === c.expected.going_concern && a.flags.delisting_notice_8k === c.expected.delisting_notice_8k;
      row.verdict_ok = verdictAgrees(a);
      const { out, missing } = sourcesOf(a);
      row.sections_without_source = missing; row.sources_total = out.length;
      const uniq = [...new Set(out)];
      row.sources_not_sec = uniq.filter((u) => !E.isSecUrl(u));
      row.sources_not_static = uniq.filter((u) => !E.isStaticSource(u));
      for (const u of SKIP_URLS ? [] : uniq.filter(E.isStaticSource)) { const rec = await resolves(u); if (rec.status !== 200 && !(REPLAY && rec.status === null)) row.sources_failing.push({ url: u, status: rec.status, attempts: rec.attempts }); }
      if (a.going_concern.quote) { try { row.quote_verbatim = await quoteVerbatim(a.going_concern.quote_url, a.going_concern.quote); } catch (e) { row.quote_verbatim = `not checked: ${e.message}`; } }
    }
    rows.push(row);
  }
  const passFlags = rows.every((r) => r.flags_ok);
  const passVerdict = rows.every((r) => r.verdict_ok);
  const passSources = !SKIP_URLS && rows.every((r) => r.sources_not_sec.length === 0 && r.sources_not_static.length === 0 && r.sources_failing.length === 0 && r.sections_without_source.length === 0 && r.sources_total > 0);
  const passSize = rows.every((r) => !r.size_404 && !r.error);
  const pass = passFlags && passVerdict && passSources && passSize && memory.ok && controlsOk;
  const out = { gate: 'GATES-r24-5-v3.md', cases_sha256: have, started_at: started, finished_at: new Date().toISOString(), replay: REPLAY, memory,
    edgar_cache: { json_hits: diskFetch.stats.hits, json_misses: diskFetch.stats.misses, doc_hits: diskStream.stats.hits, doc_misses: diskStream.stats.misses }, url_requests: urlStats.requests, url_check_controls: controlOut,
    result: { pass, flags_all_equal: passFlags, verdict_agrees_with_flags: passVerdict, every_source_is_static_and_resolves: passSources, no_size_404: passSize, memory_under_60_mb: memory.ok }, rows,
    raw: results.map((r) => ({ ticker: r.case.ticker, ms: r.ms, doc_bytes_streamed: r.doc_bytes_streamed, error: r.error, answer: r.answer })) };
  fs.writeFileSync(RAW, JSON.stringify(out, null, 1));
  console.log('\n' + rows.map((r) => `${r.ticker.padEnd(5)} flags ${r.flags_ok ? 'OK ' : 'WRONG'} expected ${JSON.stringify(r.expected)} got ${JSON.stringify(r.got)}  verdict ${r.verdict_ok ? 'OK' : 'DISAGREES'}  sources ${r.sources_total} (not sec.gov ${r.sources_not_sec.length}, not static ${r.sources_not_static.length}, failing ${r.sources_failing.length}, sections without source ${r.sections_without_source.length})  quote verbatim ${r.quote_verbatim}  streamed ${(r.doc_bytes_streamed / 1e6).toFixed(2)} MB${r.error ? `  ERROR ${r.error.status} ${r.error.message}` : ''}`).join('\n'));
  console.log(`\nURL checker controls: ${JSON.stringify(controlOut)}\nEDGAR cache: json ${diskFetch.stats.hits}/${diskFetch.stats.misses} hit/miss, documents ${diskStream.stats.hits}/${diskStream.stats.misses}; URL check requests ${urlStats.requests}`);
  console.log(`\nGATE v3 ${pass ? 'PASS' : 'FAIL'}  (flags ${passFlags}, verdicts ${passVerdict}, sources ${passSources}, no size 404 ${passSize}, memory ${memory.ok} (${memory.growth_mb} MB), controls ${controlsOk})  raw: ${RAW}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(3); });

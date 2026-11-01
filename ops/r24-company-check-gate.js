#!/usr/bin/env node
// ops/r24-company-check-gate.js: the SCORING RUN of the company-check gate (GATES-r24.md section 5). It runs the tool once on each company of the registered case list and applies the pass rule:
//   for all 10 companies the flags equal the expected flags (going_concern, delisting_notice_8k), every fact has a source URL that resolves on sec.gov, and the verdict line agrees with the flags.
// It reads the cases from the registered file GATES-r24-5-cases.md (the JSON block between CASES-JSON-BEGIN and CASES-JSON-END) after checking the file's sha256 against GATES-r24-5-cases.sha256, and it
// REFUSES to score twice: a raw output file next to the case list means the run has happened. `--replay` re-reads the same results from the disk cache with the network off (0 calls) and compares them.
// Every EDGAR response (the company list, the filing lists, the documents) and every insider-function result is cached on disk, so a replay makes 0 calls. Nothing secret is read or printed.
// usage: node ops/r24-company-check-gate.js --cases <dir with GATES-r24-5-cases.md and .sha256> [--cache DIR] [--replay]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const E = require('../tools/r24/company-check/edgar');
const R = require('../tools/r24/company-check/resolve');
const CC = require('../tools/r24/company-check');
const sec = require('../tools/sec');
const T = require('../tools/r23/claim-check/text');
const { makeDiskFetch } = require('./r24-company-check-cache');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(arg('--cases', '/Volumes/D/agentfeed-briefs/r24-20261101'));
const CACHE = arg('--cache', '/Volumes/D/r24/cache/company-check');
const REPLAY = process.argv.includes('--replay');
const CASES_MD = path.join(DIR, 'GATES-r24-5-cases.md');
const RAW = path.join(DIR, REPLAY ? 'GATES-r24-5-replay.json' : 'GATES-r24-5-raw.json');

// ---- the registered case list, after its hash ----
const md = fs.readFileSync(CASES_MD);
const want = fs.readFileSync(path.join(DIR, 'GATES-r24-5-cases.sha256'), 'utf8').trim().split(/\s+/)[0];
const have = crypto.createHash('sha256').update(md).digest('hex');
if (want !== have) { console.error(`the case list does not match its registered hash\n  registered ${want}\n  file       ${have}`); process.exit(2); }
const block = /CASES-JSON-BEGIN\s*```json\s*([\s\S]*?)```\s*CASES-JSON-END/.exec(md.toString('utf8'));
if (!block) { console.error('no CASES-JSON block in the case list'); process.exit(2); }
const cases = JSON.parse(block[1]);
if (!REPLAY && fs.existsSync(RAW)) { console.error(`${RAW} exists: this case list has been scored once and may not be scored again (use --replay to re-read it from the cache)`); process.exit(2); }

const diskFetch = makeDiskFetch({ dir: CACHE, inner: E.defaultEdgarFetch, offline: REPLAY });
const insiderDir = path.join(CACHE, 'insider'); fs.mkdirSync(insiderDir, { recursive: true });
const insiderStats = { hits: 0, misses: 0 };
async function cachedInsider(a) {
  const key = path.join(insiderDir, `${a.ticker}-${a.days}-${new Date().toISOString().slice(0, 10)}.json`);
  const any = fs.readdirSync(insiderDir).filter((f) => f.startsWith(`${a.ticker}-${a.days}-`)).sort().pop();
  const f = REPLAY && any ? path.join(insiderDir, any) : key;
  if (fs.existsSync(f)) { insiderStats.hits++; const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j.__error) throw Object.assign(new Error(j.__error), { status: 503 }); return j; }
  if (REPLAY) throw Object.assign(new Error('offline replay: no stored insider result'), { status: 503 });
  insiderStats.misses++;
  try { const r = await sec.getInsiderTrades(a); fs.writeFileSync(f, JSON.stringify(r)); return r; } catch (e) { fs.writeFileSync(f, JSON.stringify({ __error: e.message })); throw e; }
}

// ---- the URL checker: HEAD, 8 a second, cached; with a known-good and a known-bad control ----
const urlDir = path.join(CACHE, 'urlcheck'); fs.mkdirSync(urlDir, { recursive: true });
const urlStats = { calls: 0 };
const take = E.makeLimiter(8);
function head(url) {
  const f = path.join(urlDir, crypto.createHash('sha256').update(url).digest('hex') + '.json');
  if (fs.existsSync(f)) return Promise.resolve(JSON.parse(fs.readFileSync(f, 'utf8')).status);
  if (REPLAY) return Promise.resolve(null);
  return take().then(() => new Promise((resolve) => {
    urlStats.calls++;
    const u = new URL(url);
    const req = https.request({ host: u.hostname, path: u.pathname + u.search, method: 'HEAD', headers: { 'user-agent': E.UA, accept: '*/*' }, timeout: 15000 }, (res) => {
      res.resume(); fs.writeFileSync(f, JSON.stringify({ url, status: res.statusCode, at: new Date().toISOString() })); resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', () => resolve(0)); req.end();
  }));
}
const URL_KEYS = /^(source|index_url|document_url|quote_url)$/;
function sourcesOf(answer) {
  const out = []; const missing = [];
  const walk = (o, key, trail) => {
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, key, `${trail}[${i}]`));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'website') continue; walk(v, k, `${trail}.${k}`); }
    else if (typeof o === 'string' && URL_KEYS.test(key) && o) out.push({ url: o, at: trail });
  };
  walk(answer, '', '');
  // every EDGAR fact section has its own source
  for (const sec_ of ['company', 'going_concern', 'latest_10k', 'latest_10q', 'delisting_notice_8k', 'staleness', 'insider_form4']) { const v = answer[sec_]; if (!v || typeof v.source !== 'string' || !v.source) missing.push(sec_); }
  answer.recent_8k.forEach((r, i) => { if (!r.source) missing.push(`recent_8k[${i}]`); });
  return { out, missing };
}
const onSec = (u) => E.isSecUrl(u);

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

(async () => {
  const started = new Date().toISOString();
  const results = [];
  for (const c of cases.companies) {
    R._reset();
    const deps = { fetch: diskFetch, getInsiderTrades: cachedInsider, gate: CC.makeGate(), lane: CC.makeLane(), cache: CC.makeCache() };
    const t0 = Date.now();
    let answer = null; let error = null;
    try { answer = await CC.companyCheck({ q: c.q }, deps); } catch (e) { error = { status: e.status || null, kind: e.kind || null, message: e.message }; }
    results.push({ case: c, ms: Date.now() - t0, answer, error });
    console.log(`${c.ticker.padEnd(5)} ${error ? `ERROR ${error.status} ${error.message}` : `${answer.flags.going_concern}/${answer.flags.delisting_notice_8k}  ${answer.verdict}`}`);
  }
  // ---- score ----
  const controls = [['https://www.sec.gov/', 200], ['https://www.sec.gov/Archives/edgar/data/1/000000000000000000/none.htm', 404]];
  const controlOut = [];
  for (const [u, expect] of controls) { const s = await head(u); controlOut.push({ url: u, expected: expect, got: s, ok: REPLAY ? s === expect || s === null : s === expect }); }
  const controlsOk = controlOut.every((c) => c.ok);
  const rows = [];
  for (const r of results) {
    const c = r.case; const a = r.answer;
    const row = { ticker: c.ticker, stratum: c.stratum, expected: c.expected, got: a ? a.flags : null, error: r.error, flags_ok: false, verdict_ok: false, sources_total: 0, sources_not_sec: [], sources_not_resolving: [], sections_without_source: [], quote_verbatim: null };
    if (a) {
      row.flags_ok = a.flags.going_concern === c.expected.going_concern && a.flags.delisting_notice_8k === c.expected.delisting_notice_8k;
      row.verdict_ok = verdictAgrees(a);
      const { out, missing } = sourcesOf(a);
      row.sections_without_source = missing; row.sources_total = out.length;
      const uniq = [...new Set(out.map((x) => x.url))];
      row.sources_not_sec = uniq.filter((u) => !onSec(u));
      for (const u of uniq.filter(onSec)) { const st = await head(u); if (st !== 200 && !(REPLAY && st === null)) row.sources_not_resolving.push({ url: u, status: st }); }
      if (a.going_concern.quote) {                                                      // the quote is a substring of the cited document (checked by fetching it again from the cache)
        try { const d = await diskFetch(a.going_concern.quote_url, { maxBytes: 5 * 1048576 }); const text = T.htmlToText(d.body).replace(/\s+/g, ' '); row.quote_verbatim = text.includes(a.going_concern.quote.replace(/\s+/g, ' ')); } catch (e) { row.quote_verbatim = `not checked: ${e.message}`; }
      }
    }
    rows.push(row);
  }
  const passFlags = rows.every((r) => r.flags_ok);
  const passSources = rows.every((r) => r.sources_not_sec.length === 0 && r.sources_not_resolving.length === 0 && r.sections_without_source.length === 0 && r.sources_total > 0);
  const passVerdict = rows.every((r) => r.verdict_ok);
  const pass = passFlags && passSources && passVerdict && controlsOk;
  const out = { gate: 'GATES-r24.md section 5', cases_sha256: have, started_at: started, finished_at: new Date().toISOString(), replay: REPLAY,
    edgar_cache: { hits: diskFetch.stats.hits, misses: diskFetch.stats.misses }, insider_cache: insiderStats, url_check_calls: urlStats.calls, url_check_controls: controlOut,
    result: { pass, flags_all_equal: passFlags, every_fact_has_a_source_that_resolves_on_sec_gov: passSources, verdict_agrees_with_flags: passVerdict }, rows,
    raw: results.map((r) => ({ ticker: r.case.ticker, ms: r.ms, error: r.error, answer: r.answer })) };
  fs.writeFileSync(RAW, JSON.stringify(out, null, 1));
  console.log('\n' + rows.map((r) => `${r.ticker.padEnd(5)} flags ${r.flags_ok ? 'OK ' : 'WRONG'} expected ${JSON.stringify(r.expected)} got ${JSON.stringify(r.got)}  verdict ${r.verdict_ok ? 'OK' : 'DISAGREES'}  sources ${r.sources_total} (not sec.gov ${r.sources_not_sec.length}, not resolving ${r.sources_not_resolving.length}, sections without source ${r.sections_without_source.length})  quote verbatim ${r.quote_verbatim}`).join('\n'));
  console.log(`\nURL checker controls: ${JSON.stringify(controlOut)}\nEDGAR cache: ${diskFetch.stats.hits} hits, ${diskFetch.stats.misses} misses; insider ${insiderStats.hits} hits, ${insiderStats.misses} misses; URL checks ${urlStats.calls} calls`);
  console.log(`\nGATE ${pass ? 'PASS' : 'FAIL'}  (flags ${passFlags}, sources ${passSources}, verdict ${passVerdict}, controls ${controlsOk})  raw: ${RAW}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(3); });

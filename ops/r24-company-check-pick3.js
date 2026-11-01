#!/usr/bin/env node
// ops/r24-company-check-pick3.js: the SELECTION RULE of the v3 gate (GATES-r24-5-v3.md), as code (the v2 script, pick2.js, stays as it was), run BEFORE the tool is run on any company of the case list. It never calls the tool: it reads EDGAR (the filing
// list and the primary documents, streamed through the disk cache the gate runner uses) and judges the documents with an independent reading aid (tags stripped with one regular expression in 1 MB slices, then
// every place where "substantial doubt" has "going concern" within 300 characters), not with going-concern.js or html-stream.js.
// Excluded from the v3 list: the v1 ten, the v2 ten, the development indexes of ops/r24-company-check-dev.json, and EVERY company that has a document or a filing list in the disk cache when v3 work started
// (CACHE/dev3-ciks.json: the v1 and v2 candidates and lists are all in it, and the comparisons of the v1 and v2 pipelines ran the code on the cached documents).
//   --healthy     5 healthy large caps. Walk company_tickers.json (the v1 snapshot) in file order from index 10; for each company not excluded require: the latest annual report is a 10-K filed within 400 days;
//                 a 10-Q on file; no 8-K or 8-K/A with Item 3.01 in the last 24 months; both primary documents at most 40,000,000 bytes (the v2 read limit); no place with both phrases in either document.
//                 BIG = the 10-K main document over 5,500,000 bytes (over 5 MB however it is counted) and at most 16,000,000 bytes (the band is stated here, before any candidate is read: the largest report put through the whole
//                 tool so far is 12.8 MB, and a bigger one would test the 40 MB limit, which is not what this list is for): take the first 3. SMALL = both documents at most 5,000,000 bytes: take the first 2.
//   --distressed  as v1 (EDGAR full-text search, ascending accession order, strata A going concern + Item 3.01 (take 2), B going concern only (take 2), C Item 3.01 only (take 1)), with the exclusions above
//                 and the 40 MB limit instead of 5 MB. Reading aids as in v1 (a clear affirmative passage, no "alleviated" / denial passage).
// usage: node ops/r24-company-check-pick3.js --healthy|--distressed [--cache DIR] [--out FILE]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('../tools/r24/company-check/edgar');
const { makeDiskStream, makeDiskFetch } = require('./r24-company-check-cache');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const CACHE = arg('--cache', '/Volumes/D/r24/cache/company-check');
const TICKERS = path.join(CACHE, 'company_tickers.snapshot.json');
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'r24-company-check-dev.json'), 'utf8'));
const dev2 = new Set(JSON.parse(fs.readFileSync(path.join(CACHE, 'dev3-ciks.json'), 'utf8')).ciks);
const V1_TEN = ['MU', 'AMD', 'V', 'JNJ', 'MA', 'AWHL', 'MDCX', 'CVR', 'BISA', 'SCKT', 'CVX', 'ORCL', 'BAC', 'ABBV', 'INTC', 'SKYQ', 'DRDB', 'LCU', 'FJET', 'MXCT'];     // the v1 ten and the v2 ten
const fetchC = makeDiskFetch({ dir: CACHE, inner: E.defaultEdgarFetch });
const streamC = makeDiskStream({ dir: CACHE, inner: E.streamDocument });
const d = { fetch: fetchC, now: () => Date.now() };
const NOW = Date.now();
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const cutoff = (() => { const c = new Date(NOW); c.setUTCMonth(c.getUTCMonth() - 24); return iso(c.getTime()); })();
const newest = (rows) => rows.slice().sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0));
const LIMIT = 40000000;
const list = Object.values(JSON.parse(fs.readFileSync(TICKERS, 'utf8')));
const tickerOf = new Map(); list.forEach((v) => { const c = String(v.cik_str).padStart(10, '0'); if (!tickerOf.has(c)) tickerOf.set(c, { ticker: v.ticker, title: v.title }); });
const v1Ciks = new Set(V1_TEN.map((t) => String(list.find((v) => v.ticker === t).cik_str).padStart(10, '0')));
const devRank = (i) => dev.ranks.some(([a, b]) => i >= a && i <= b);
const devName = (n) => dev.names.some((x) => String(n).toUpperCase().includes(x));
const excluded = (cik, i) => v1Ciks.has(cik) || dev2.has(cik) || (i != null && devRank(i));

async function fts(params) {
  const url = `https://efts.sec.gov/LATEST/search-index?${new URLSearchParams({ ...params, dateRange: 'custom' })}`;
  const f = path.join(CACHE, 'fts', crypto.createHash('sha256').update(url).digest('hex') + '.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  await new Promise((r) => setTimeout(r, 200));
  const r = await fetch(url, { headers: { 'user-agent': E.UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`full-text search answered HTTP ${r.status}`);
  const t = await r.text(); fs.writeFileSync(f, t); return JSON.parse(t);
}
async function ftsAll(params, max = 1600) {
  const hits = [];
  for (let from = 0; from < max; from += 100) {
    const j = await fts({ ...params, from: String(from) });
    hits.push(...j.hits.hits);
    if (j.hits.hits.length < 100 || hits.length >= j.hits.total.value) break;
  }
  return hits;
}
async function listing(cik10) {
  const sub = await E.fetchSubmissions(cik10, d); if (!sub) return null;
  await E.loadOlder(sub, cutoff, d, { maxPages: 15, needReports: true });          // the tool's own limit (MAX_LIST_PAGES)
  if (!sub.window_complete) { console.log('   (filing list does not reach back 24 months within 15 pages: skipped, the tool would answer null)'); return null; }
  const k = newest(sub.rows.filter((r) => ['10-K', '10-KT', '10-K405'].includes(r.form)))[0] || null;
  const q = newest(sub.rows.filter((r) => ['10-Q', '10-QT'].includes(r.form)))[0] || null;
  const de = newest(sub.rows.filter((r) => (r.form === '8-K' || r.form === '8-K/A') && r.filed >= cutoff && r.items.includes('3.01')));
  return { sub, k, q, de };
}
// the independent reading aid, over a stream: 1 MB slices cut at a ">" so a tag is not split, tags -> space, a few entities, whitespace collapsed, 400 characters of overlap between slices
function makeAid() {
  let pending = ''; let tail = ''; const passages = []; let bytes = 0;
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/&rsquo;|&#8217;|&#x2019;/gi, '’').replace(/&amp;/g, '&').replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/\s+/g, ' ');
  const scan = (text) => {
    const re = /substantial\s+doubt/gi; let m;
    while ((m = re.exec(text))) { const ctx = text.slice(Math.max(0, m.index - 300), m.index + 330); if (/going[\s-]+concern/i.test(ctx)) passages.push(ctx.replace(/\s+/g, ' ').trim()); }
  };
  const flush = (all) => {
    const cut = all ? pending.length : pending.lastIndexOf('>') + 1;
    if (cut <= 0) return;
    const text = tail + strip(pending.slice(0, cut)); pending = pending.slice(cut);
    scan(text); tail = text.slice(-400);
    // a passage inside the overlap would be found twice: de-duplicated below
  };
  return { push(c) { bytes += c.length; pending += c.toString('latin1'); if (pending.length > 1048576) flush(false); }, end() { flush(true); return { passages: [...new Set(passages)], bytes }; } };
}
async function readDoc(sub, row) {
  const url = E.docUrl(sub.cik, row.accession, row.primary_document);
  const aid = makeAid();
  const r = await streamC(url, { maxBytes: LIMIT }, (c) => aid.push(c));
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return { url, ...aid.end() };
}
const AFFIRM = /(?:raise[sd]?|there\s+is|expressed|exists?)\s+(?:a\s+)?substantial\s+doubt|substantial\s+doubt\s+exists/i;
// (v2 run 1 took Passage Bio's "has evaluated whether there are conditions that raise substantial doubt" for an affirmative passage; found by reading it before registration; "whether" was added: the standard's wording is not a statement)
const DENIAL = /alleviat|no\s+(?:longer\s+)?(?:a\s+|any\s+)?substantial\s+doubt|not\s+raise|no\s+conditions|whether/i;
const mb = (b) => (b / 1e6).toFixed(2);

async function healthy() {
  const big = []; const small = []; const seen = new Set();
  for (let i = 10; i < list.length && (big.length < 3 || small.length < 2); i++) {
    const c = list[i]; const cik = String(c.cik_str).padStart(10, '0');
    if (excluded(cik, i) || seen.has(cik)) continue; seen.add(cik);
    const L = await listing(cik).catch(() => null);
    if (!L || !L.k || !L.q) { console.log(i, c.ticker, 'skip: no 10-K or no 10-Q'); continue; }
    if ((NOW - Date.parse(L.k.filed)) / 86400e3 > 400) { console.log(i, c.ticker, 'skip: latest 10-K older than 400 days'); continue; }
    if (L.de.length) { console.log(i, c.ticker, 'skip: Item 3.01 on', L.de.map((r) => r.filed).join(',')); continue; }
    let dk; try { dk = await readDoc(L.sub, L.k); } catch (e) { console.log(i, c.ticker, 'skip: 10-K', e.code === 'TOO_LARGE' ? 'over the 40 MB limit' : e.message); continue; }
    const bucket = dk.bytes > 5500000 && dk.bytes <= 16000000 ? 'BIG' : dk.bytes <= 5000000 ? 'SMALL' : null;
    if (!bucket) { console.log(i, c.ticker, `skip: 10-K ${mb(dk.bytes)} MB is between the buckets or over 16 MB`); continue; }
    if ((bucket === 'BIG' ? big : small).length >= (bucket === 'BIG' ? 3 : 2)) { console.log(i, c.ticker, `${bucket} full`); continue; }
    let dq; try { dq = await readDoc(L.sub, L.q); } catch (e) { console.log(i, c.ticker, 'skip: 10-Q', e.code === 'TOO_LARGE' ? 'over the 40 MB limit' : e.message); continue; }
    if (bucket === 'SMALL' && dq.bytes > 5000000) { console.log(i, c.ticker, `skip: SMALL needs both documents at most 5 MB (10-Q ${mb(dq.bytes)})`); continue; }
    console.log(i, c.ticker, bucket, `10-K ${L.k.accession} ${mb(dk.bytes)}MB 10-Q ${L.q.accession} ${mb(dq.bytes)}MB passages ${dk.passages.length}/${dq.passages.length}`);
    if (dk.passages.length + dq.passages.length) { console.log('   -> has passages, not taken'); continue; }
    (bucket === 'BIG' ? big : small).push({ stratum: `healthy-${bucket.toLowerCase()}`, rank: i, ticker: c.ticker, name: c.title, cik, k: L.k, q: L.q, kurl: dk.url, qurl: dq.url, kbytes: dk.bytes, qbytes: dq.bytes, fiscal_year_end: L.sub.fiscal_year_end, category: L.sub.category });
  }
  return [...big, ...small];
}

async function distressed() {
  const out = { A: [], B: [], C: [] }; const taken = new Set();
  const hits = (await ftsAll({ q: '"substantial doubt" "going concern"', forms: '10-K', startdt: '2026-03-01', enddt: '2026-10-31' })).filter((h) => h._source.file_type === '10-K' && h._source.form === '10-K')
    .sort((a, b) => (a._source.adsh < b._source.adsh ? -1 : 1));
  console.log('10-K hits with both phrases:', hits.length);
  for (const h of hits) {
    if (out.A.length >= 2 && out.B.length >= 2) break;
    const cik = h._source.ciks[0]; const t = tickerOf.get(cik);
    if (!t || excluded(cik) || devName(h._source.display_names[0]) || taken.has(cik)) continue;
    const L = await listing(cik).catch(() => null);
    if (!L || !L.k || !L.q || L.k.accession !== h._source.adsh) continue;
    const stratum = L.de.length ? 'A' : 'B';
    if (out[stratum].length >= 2) continue;
    let dk; let dq; try { dk = await readDoc(L.sub, L.k); dq = await readDoc(L.sub, L.q); } catch (e) { console.log(t.ticker, 'skip:', e.code === 'TOO_LARGE' ? 'over the 40 MB limit' : e.message); continue; }
    const all = dk.passages.join(' ');
    if (!dk.passages.some((p) => AFFIRM.test(p)) || DENIAL.test(all)) { console.log(t.ticker, stratum, 'skip: no clear affirmative passage, or an alleviation / denial passage'); continue; }
    taken.add(cik);
    out[stratum].push({ stratum, ticker: t.ticker, name: t.title, cik, k: L.k, q: L.q, kurl: dk.url, qurl: dq.url, kbytes: dk.bytes, qbytes: dq.bytes, fiscal_year_end: L.sub.fiscal_year_end, category: L.sub.category,
      passages_10k: dk.passages.length, passages_10q: dq.passages.length, affirmative_passage: dk.passages.find((p) => AFFIRM.test(p)), delisting_8k: L.de.slice(0, 4).map((r) => ({ form: r.form, filed: r.filed, accession: r.accession, items: r.items, url: E.indexUrl(cik, r.accession) })) });
    console.log('picked', stratum, t.ticker, L.k.accession, 'de', L.de.length);
  }
  const eights = (await ftsAll({ q: '"Item 3.01" "minimum bid price"', forms: '8-K', startdt: '2025-11-02', enddt: '2026-10-31' })).filter((h) => h._source.file_type === '8-K').sort((a, b) => (a._source.adsh < b._source.adsh ? -1 : 1));
  console.log('8-K hits for Item 3.01:', eights.length);
  for (const h of eights) {
    if (out.C.length >= 1) break;
    const cik = h._source.ciks[0]; const t = tickerOf.get(cik);
    if (!t || excluded(cik) || devName(h._source.display_names[0]) || taken.has(cik)) continue;
    const L = await listing(cik).catch(() => null);
    if (!L || !L.k || !L.q || !L.de.length) continue;
    if ((NOW - Date.parse(L.k.filed)) / 86400e3 > 400) continue;
    let dk; let dq; try { dk = await readDoc(L.sub, L.k); dq = await readDoc(L.sub, L.q); } catch { continue; }
    if (dk.passages.length + dq.passages.length) { console.log(t.ticker, 'C skip: has passages'); continue; }
    taken.add(cik);
    out.C.push({ stratum: 'C', ticker: t.ticker, name: t.title, cik, k: L.k, q: L.q, kurl: dk.url, qurl: dq.url, kbytes: dk.bytes, qbytes: dq.bytes, fiscal_year_end: L.sub.fiscal_year_end, category: L.sub.category, passages_10k: 0, passages_10q: 0,
      delisting_8k: L.de.slice(0, 4).map((r) => ({ form: r.form, filed: r.filed, accession: r.accession, items: r.items, url: E.indexUrl(cik, r.accession) })), fts_hit: h._source.adsh });
    console.log('picked C', t.ticker, 'de', L.de.length);
  }
  return [...out.A, ...out.B, ...out.C];
}

(async () => {
  const which = process.argv.includes('--healthy') ? 'healthy' : process.argv.includes('--distressed') ? 'distressed' : null;
  if (!which) { console.error('usage: --healthy | --distressed'); process.exit(2); }
  const res = which === 'healthy' ? await healthy() : await distressed();
  const f = arg('--out', path.join(CACHE, `pick3-${which}.json`)); fs.writeFileSync(f, JSON.stringify({ made_at: new Date().toISOString(), tickers_snapshot: TICKERS, cutoff, picks: res }, null, 1));
  console.log(`\n${which}: ${res.length} picked -> ${f}\n${res.map((p) => `${p.stratum} ${p.ticker} ${p.name} 10-K ${mb(p.kbytes)} MB`).join('\n')}`);
})().catch((e) => { console.error(e); process.exit(1); });

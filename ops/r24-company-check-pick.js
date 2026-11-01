#!/usr/bin/env node
// ops/r24-company-check-pick.js: the SELECTION RULE of the company-check gate (GATES-r24.md section 5), as code, run BEFORE the tool is run on any company of the case list. It never calls the tool: it reads
// EDGAR (the filing list and the primary documents, through the same disk cache the gate runner uses) and judges the documents with a short independent reading aid (tags stripped with a few regular
// expressions, then every place where "substantial doubt" has "going concern" within 300 characters), not with tools/r24/company-check/going-concern.js.
//   --healthy     5 healthy large caps. Walk company_tickers.json (the snapshot named by --tickers) in file order from index 10 (indexes 0-9 are development data, see ops/r24-company-check-dev.json); skip a CIK that is
//                 in the development list; require (a) a 10-K as the latest annual report filed within 400 days and a 10-Q on file, (b) both primary documents at most 5 MB (the tool's documented read limit),
//                 (c) no 8-K or 8-K/A with Item 3.01 in the last 24 months over the filing list including older pages, (d) no place with both phrases in either document. Take the first 5.
//   --distressed  stratum A and B from EDGAR full-text search (efts.sec.gov): 10-K main documents filed 2026-03-01..2026-10-31 that contain "substantial doubt" and "going concern", in ascending accession order;
//                 the company has a ticker on the list, the hit is its latest 10-K, there is a 10-Q, both documents are at most 5 MB, the 10-K has an affirmative passage by the pattern below and no passage that
//                 says "alleviated" or "no substantial doubt". A = such a company with Item 3.01 in the last 24 months (take 2), B = without (take 2).
//                 stratum C from 8-K full-text search for "Item 3.01" together with "minimum bid price" (2025-11-02..2026-10-31), ascending accession order. (A first run of this script used "Item 3.01" alone and its first
//                 pick was a listing TRANSFER (Item 3.01 also covers transfers), not a deficiency notice; the query was narrowed to deficiency notices BEFORE any run of the tool, and the first run is in the notes.) the company has an Item 3.01 filing in the list, a 10-K as latest annual report filed within
//                 400 days, a 10-Q, both at most 5 MB, and NO place with both phrases in either document (take 1).
// The output is a JSON file of candidates with their evidence (accessions, URLs, sizes, passages); the case list is written from it by hand and hashed before the first scoring run.
// usage: node ops/r24-company-check-pick.js --healthy|--distressed [--tickers FILE] [--cache DIR] [--out FILE]
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../tools/r24/company-check/edgar');
const { makeDiskFetch } = require('./r24-company-check-cache');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const CACHE = arg('--cache', '/Volumes/D/r24/cache/company-check');
const TICKERS = arg('--tickers', path.join(CACHE, 'company_tickers.snapshot.json'));
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'r24-company-check-dev.json'), 'utf8'));
const fetchC = makeDiskFetch({ dir: CACHE, inner: E.defaultEdgarFetch });
const d = { fetch: fetchC, now: () => Date.now() };
const NOW = Date.now();
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const cutoff = (() => { const c = new Date(NOW); c.setUTCMonth(c.getUTCMonth() - 24); return iso(c.getTime()); })();
const newest = (rows) => rows.slice().sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0));
const MB = 1048576;
const list = Object.values(JSON.parse(fs.readFileSync(TICKERS, 'utf8')));
const tickerOf = new Map(); list.forEach((v) => { const c = String(v.cik_str).padStart(10, '0'); if (!tickerOf.has(c)) tickerOf.set(c, { ticker: v.ticker, title: v.title }); });
const devRank = (i) => dev.ranks.some(([a, b]) => i >= a && i <= b);
const devName = (n) => dev.names.some((x) => String(n).toUpperCase().includes(x));
const devCiks = new Set(list.map((v, i) => (devRank(i) ? String(v.cik_str).padStart(10, '0') : null)).filter(Boolean));

async function fts(params) {
  const url = `https://efts.sec.gov/LATEST/search-index?${new URLSearchParams({ ...params, dateRange: 'custom' })}`;
  const f = path.join(CACHE, 'fts', require('crypto').createHash('sha256').update(url).digest('hex') + '.json');
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
  await E.loadOlder(sub, cutoff, d, { maxPages: 3, needReports: true });
  const k = newest(sub.rows.filter((r) => ['10-K', '10-KT', '10-K405'].includes(r.form)))[0] || null;
  const q = newest(sub.rows.filter((r) => ['10-Q', '10-QT'].includes(r.form)))[0] || null;
  const de = newest(sub.rows.filter((r) => (r.form === '8-K' || r.form === '8-K/A') && r.filed >= cutoff && r.items.includes('3.01')));
  return { sub, k, q, de };
}
async function doc(sub, row) {
  const url = E.docUrl(sub.cik, row.accession, row.primary_document);
  const r = await fetchC(url, { maxBytes: 80 * MB, accept: 'text/html' });
  return { url, bytes: r.body.length, body: r.body };
}
function plain(buf) {
  return buf.toString('utf8').replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ').replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/&rsquo;|&#8217;|&#x2019;/gi, '’').replace(/&amp;/g, '&').replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/\s+/g, ' ');
}
function passages(text) {
  const out = []; const re = /substantial\s+doubt/gi; let m;
  while ((m = re.exec(text))) { const ctx = text.slice(Math.max(0, m.index - 300), m.index + 330); if (/going[\s-]+concern/i.test(ctx)) out.push(ctx.replace(/\s+/g, ' ').trim()); }
  return out;
}
// the reading aid for a clear affirmative passage: the doubt is said to be raised, to exist or to be expressed, directly ("raise substantial doubt", "there is substantial doubt", "substantial doubt exists"). A passage that says
// "there is no longer a substantial doubt" does not match (the first run of this script took such a passage for affirmative; found by reading it, before the tool was run on anything, and the pattern was tightened).
const AFFIRM = /(?:raise[sd]?|there\s+is|expressed|exists?)\s+(?:a\s+)?substantial\s+doubt|substantial\s+doubt\s+exists/i;
const DENIAL = /alleviat|no\s+(?:longer\s+)?(?:a\s+|any\s+)?substantial\s+doubt|not\s+raise|no\s+conditions/i;
const mb = (b) => (b / MB).toFixed(2);

async function healthy() {
  const picked = []; const seen = new Set();
  for (let i = 10; i < list.length && picked.length < 5; i++) {
    const c = list[i]; const cik = String(c.cik_str).padStart(10, '0');
    if (devRank(i) || devCiks.has(cik) || seen.has(cik)) continue; seen.add(cik);
    const L = await listing(cik).catch(() => null);
    if (!L || !L.k || !L.q) { console.log(i, c.ticker, 'skip: no 10-K or no 10-Q'); continue; }
    if ((NOW - Date.parse(L.k.filed)) / 86400e3 > 400) { console.log(i, c.ticker, 'skip: latest 10-K older than 400 days'); continue; }
    if (L.de.length) { console.log(i, c.ticker, 'skip: Item 3.01 on', L.de.map((r) => r.filed).join(',')); continue; }
    const dk = await doc(L.sub, L.k); const dq = await doc(L.sub, L.q);
    if (dk.bytes > 5 * MB || dq.bytes > 5 * MB) { console.log(i, c.ticker, `skip: over 5 MB (10-K ${mb(dk.bytes)}, 10-Q ${mb(dq.bytes)})`); continue; }
    const pk = passages(plain(dk.body)); const pq = passages(plain(dq.body));
    console.log(i, c.ticker, `10-K ${L.k.accession} ${mb(dk.bytes)}MB 10-Q ${L.q.accession} ${mb(dq.bytes)}MB passages ${pk.length}/${pq.length}`);
    if (pk.length + pq.length) { console.log('   -> has passages, not taken'); continue; }
    picked.push({ stratum: 'healthy', rank: i, ticker: c.ticker, name: c.title, cik, k: L.k, q: L.q, kurl: dk.url, qurl: dq.url, kbytes: dk.bytes, qbytes: dq.bytes, fiscal_year_end: L.sub.fiscal_year_end, category: L.sub.category, delisting_8k_in_24_months: 0 });
  }
  return picked;
}

async function distressed() {
  const out = { A: [], B: [], C: [] }; const taken = new Set();
  const hits = (await ftsAll({ q: '"substantial doubt" "going concern"', forms: '10-K', startdt: '2026-03-01', enddt: '2026-10-31' })).filter((h) => h._source.file_type === '10-K' && h._source.form === '10-K')
    .sort((a, b) => (a._source.adsh < b._source.adsh ? -1 : 1));
  console.log('10-K hits with both phrases:', hits.length);
  for (const h of hits) {
    if (out.A.length >= 2 && out.B.length >= 2) break;
    const cik = h._source.ciks[0]; const t = tickerOf.get(cik);
    if (!t || devCiks.has(cik) || devName(h._source.display_names[0]) || taken.has(cik)) continue;
    const L = await listing(cik).catch(() => null);
    if (!L || !L.k || !L.q || L.k.accession !== h._source.adsh) continue;
    const stratum = L.de.length ? 'A' : 'B';
    if (out[stratum].length >= 2) continue;
    const dk = await doc(L.sub, L.k); const dq = await doc(L.sub, L.q);
    if (dk.bytes > 5 * MB || dq.bytes > 5 * MB) { console.log(t.ticker, `skip: over 5 MB`); continue; }
    const pk = passages(plain(dk.body)); const pq = passages(plain(dq.body));
    const all = pk.join(' ');
    if (!pk.some((p) => AFFIRM.test(p)) || DENIAL.test(all)) { console.log(t.ticker, stratum, 'skip: no clear affirmative passage, or an alleviation / denial passage'); continue; }
    taken.add(cik);
    out[stratum].push({ stratum, ticker: t.ticker, name: t.title, cik, k: L.k, q: L.q, kurl: dk.url, qurl: dq.url, kbytes: dk.bytes, qbytes: dq.bytes, fiscal_year_end: L.sub.fiscal_year_end, category: L.sub.category,
      passages_10k: pk.length, passages_10q: pq.length, affirmative_passage: pk.find((p) => AFFIRM.test(p)), delisting_8k: L.de.slice(0, 4).map((r) => ({ form: r.form, filed: r.filed, accession: r.accession, items: r.items, url: E.indexUrl(cik, r.accession) })) });
    console.log('picked', stratum, t.ticker, L.k.accession, 'de', L.de.length);
  }
  const eights = (await ftsAll({ q: '"Item 3.01" "minimum bid price"', forms: '8-K', startdt: '2025-11-02', enddt: '2026-10-31' })).filter((h) => h._source.file_type === '8-K').sort((a, b) => (a._source.adsh < b._source.adsh ? -1 : 1));
  console.log('8-K hits for Item 3.01:', eights.length);
  for (const h of eights) {
    if (out.C.length >= 1) break;
    const cik = h._source.ciks[0]; const t = tickerOf.get(cik);
    if (!t || devCiks.has(cik) || devName(h._source.display_names[0]) || taken.has(cik)) continue;
    const L = await listing(cik).catch(() => null);
    if (!L || !L.k || !L.q || !L.de.length) continue;
    if ((NOW - Date.parse(L.k.filed)) / 86400e3 > 400) continue;
    const dk = await doc(L.sub, L.k); const dq = await doc(L.sub, L.q);
    if (dk.bytes > 5 * MB || dq.bytes > 5 * MB) continue;
    const pk = passages(plain(dk.body)); const pq = passages(plain(dq.body));
    if (pk.length + pq.length) { console.log(t.ticker, 'C skip: has passages'); continue; }
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
  const f = arg('--out', path.join(CACHE, `pick-${which}.json`)); fs.writeFileSync(f, JSON.stringify({ made_at: new Date().toISOString(), tickers_snapshot: TICKERS, cutoff, picks: res }, null, 1));
  console.log(`\n${which}: ${res.length} picked -> ${f}\n${res.map((p) => `${p.stratum} ${p.ticker} ${p.name}`).join('\n')}`);
})().catch((e) => { console.error(e); process.exit(1); });

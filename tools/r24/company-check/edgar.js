// tools/r24/company-check/edgar.js: the EDGAR reads of company-check (R24 item 5, 1 Nov 2026). Everything that touches sec.gov goes through defaultEdgarFetch:
//   - the declared User-Agent of tools/sec.js (SEC fair access asks for a contact in it) and a token bucket of 8 requests a second (the SEC allows 10). If tools/sec.js is loaded and exports `take`
//     this module uses that bucket, so the process has a single ceiling (see the notes for the one-line export)
//   - lib/safe-fetch.js, the one SSRF guard: https only, www.sec.gov and data.sec.gov only (checked here as well), 3 redirects at most, 10 s, a byte cap per document
//   - 404 is an answer (null), 403 and 429 are the SEC throttling us, 5xx and timeouts are an outage: those three are the 503 "Not charged" refusal, never a finding
//   - v2: streamDocument() reads a filing in chunks (same host lock, same guard: lib/safe-fetch.js checkUrl and guardedLookup, https only, at most 3 redirects each re-checked, a byte cap, a deadline)
// The functions after it turn EDGAR's own JSON into rows. Nothing here caches a document: the one cache of the tool is the per-accession analysis in index.js.
'use strict';
const https = require('https');
const SF = require('../../../lib/safe-fetch');
const { unavailable } = require('../../r23/common');

const UA = 'AgentFeed ochinimus@gmail.com';
const RATE = 8;
const HOSTS = new Set(['www.sec.gov', 'data.sec.gov']);
const MAX_JSON = 6 * 1024 * 1024;
const MAX_DOC = 40000000;           // v2: a filing is SCANNED as a stream, never held whole, so the cap is 40 MB (decimal), not 5 MiB; JSON documents are still read whole and capped at MAX_JSON
const FETCH_MS = 10000;
const STREAM_MS = 30000;            // a 40 MB filing needs more than the 10 s of a small document; the whole read, redirects included, ends at this deadline

// ---- one token bucket for this module (8 a second), or tools/sec.js's own when it exports one ------------------------------------------------------------------------------
function makeLimiter(rate = RATE, { now = Date.now, setTimer = setTimeout } = {}) {
  let tokens = rate; let last = now();
  return function take() {
    return new Promise((resolve) => {
      const tryNow = () => {
        const t = now(); tokens = Math.min(rate, tokens + ((t - last) / 1000) * rate); last = t;
        if (tokens >= 1) { tokens -= 1; resolve(); } else setTimer(tryNow, Math.ceil(((1 - tokens) / rate) * 1000));
      };
      tryNow();
    });
  };
}
const ownTake = makeLimiter(RATE);
// tools/sec.js keeps its own 8 a second bucket private; if it ever exports `take` AND is loaded in this process (the server), this module shares that bucket. It never loads tools/sec.js itself (v3: that load is
// about 1 MB resident in a process that has no other use for it).
let secPath = null; try { secPath = require.resolve('../../sec'); } catch { /* not installed beside this tool */ }
const take = () => { const m = secPath && require.cache[secPath]; return m && m.exports && typeof m.exports.take === 'function' ? m.exports.take() : ownTake(); };

// ---- URLs ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const DOCNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:htm|html|txt)$/i;
const CIK10 = /^\d{10}$/;
const SUBPAGE = /^CIK\d{10}-submissions-\d{3}\.json$/;
const docUrl = (cik, acc, doc) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(acc).replace(/-/g, '')}/${doc}`;
const indexUrl = (cik, acc) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(acc).replace(/-/g, '')}/${acc}-index.htm`;
// v3: every source URL the answer carries is a STATIC EDGAR object, never a dynamic page (a browse-edgar listing answered HTTP 503 under load in the v2 gate): a filing document or index under
// /Archives/edgar/data/<cik>/<accession without dashes>/, the company's submissions JSON on data.sec.gov (the filing list every listing fact is read from), or the data.sec.gov XBRL API.
const submissionsUrl = (cik) => `https://data.sec.gov/submissions/CIK${cik}.json`;
const STATIC_PATHS = [
  [/^www\.sec\.gov$/, /^\/Archives\/edgar\/data\/\d{1,10}\/\d{18}\/[A-Za-z0-9][A-Za-z0-9._\-/]{0,200}$/],
  [/^data\.sec\.gov$/, /^\/submissions\/CIK\d{10}(?:-submissions-\d{3})?\.json$/],
  [/^data\.sec\.gov$/, /^\/api\/xbrl\/[A-Za-z0-9._\-/]{1,200}\.json$/],
];
/** is this a static EDGAR object? https, exactly one of the three shapes above (so never a cgi-bin, browse-edgar or search page), no query string, no fragment, no credentials, no port */
function isStaticSource(href) {
  let u; try { u = new URL(href); } catch { return false; }
  if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password || u.port) return false;
  return STATIC_PATHS.some(([h, p]) => h.test(u.hostname) && p.test(u.pathname));
}
const isSecUrl = (href) => { try { const u = new URL(href); return u.protocol === 'https:' && (u.hostname === 'sec.gov' || u.hostname.endsWith('.sec.gov')); } catch { return false; } };

// ---- the fetcher --------------------------------------------------------------------------------------------------------------------------------------------------------------
/**
 * -> { status: 200 | 404, url, contentType, body: Buffer } ; throws the 503 refusal for anything else, and an error with code 'TOO_LARGE' for a document over maxBytes
 * (the caller decides whether that is a refusal or a null with a reason). Only sec.gov hosts are fetched.
 */
async function defaultEdgarFetch(url, { maxBytes = MAX_JSON, accept = 'application/json', timeoutMs = FETCH_MS } = {}) {
  const u = lockUrl(url);
  await take();
  let r;
  try {
    r = await SF.safeFetch(u.href, { maxBytes, timeoutMs, userAgent: UA, accept, httpsOnly: true, acceptStatus: (c) => c >= 400 });
  } catch (e) {
    // safe-fetch says "...-byte limit" for a document over the cap, as a bad_request; nothing else it throws is the caller's fault here (the URL is ours)
    if (e && /-byte limit/.test(String(e.message))) throw Object.assign(new Error(`document is over the ${maxBytes}-byte limit`), { code: 'TOO_LARGE' });
    throw unavailable(`EDGAR could not be read (${String((e && e.message) || e).replace(/\s*Not charged\.?$/i, '').slice(0, 120)})`, 60);
  }
  let finalHost = ''; try { finalHost = new URL(r.url).hostname; } catch { /* stays empty */ }
  if (!HOSTS.has(finalHost)) throw unavailable('EDGAR answered from an address outside sec.gov', 300);
  if (r.status === 200 || r.status === 404) return { status: r.status, url: r.url, contentType: r.contentType || '', body: r.body };
  if (r.status === 403 || r.status === 429) throw unavailable(`EDGAR is limiting requests (HTTP ${r.status})`, 300);
  throw unavailable(`EDGAR answered HTTP ${r.status}`, 120);
}

/** the host lock on a fixed address: https, www.sec.gov or data.sec.gov, no credentials, no port but 443. -> the URL ; throws the 503 refusal */
function lockUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw unavailable('EDGAR address is not valid', 60); }
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) throw unavailable('only www.sec.gov and data.sec.gov are read', 3600);
  return u;
}

/**
 * v2: reads one document as a STREAM. `onChunk(Buffer)` is called for each piece, in order, as it arrives; nothing is kept here. -> { status: 200 | 404, url, contentType, bytes }.
 * The address guard is lib/safe-fetch.js's (checkUrl with httpsOnly on every hop, guardedLookup inside the socket's own lookup), plus the host lock; redirects are followed by hand, at most 3, each one
 * checked again; the declared size and the running size are held to `maxBytes` (error code TOO_LARGE, the stream is destroyed); the whole read ends at `timeoutMs` (503). 403/429 are the SEC
 * limiting us, a 5xx or a socket error is an outage: all 503, "Not charged". An error thrown by onChunk ends the read and is rethrown.
 */
async function streamDocument(url, { maxBytes = MAX_DOC, timeoutMs = STREAM_MS, accept = 'text/html,application/xhtml+xml,text/plain' } = {}, onChunk) {
  let u = lockUrl(url);
  await take();
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; ; hop++) {
    try { u = SF.checkUrl(u.href, { httpsOnly: true }); } catch (e) { throw unavailable(`EDGAR address refused (${String(e.message).slice(0, 80)})`, 3600); }
    if (!HOSTS.has(u.hostname)) throw unavailable('EDGAR answered from an address outside sec.gov', 300);
    const res = await new Promise((resolve, reject) => {
      const req = https.request(u, { method: 'GET', lookup: SF.guardedLookup, headers: { 'user-agent': UA, accept, 'accept-encoding': 'identity' }, timeout: Math.max(1, deadline - Date.now()) }, resolve);
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      req.end();
    }).catch((e) => { throw unavailable(`EDGAR could not be read (${String((e && e.message) || e).replace(/\s*Not charged\.?$/i, '').slice(0, 120)})`, 60); });
    const status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= 3) throw unavailable('EDGAR redirected more than 3 times', 300);
      try { u = new URL(res.headers.location, u); } catch { throw unavailable('EDGAR sent a redirect that is not an address', 300); }
      continue;
    }
    if (status === 404) { res.resume(); return { status: 404, url: u.href, contentType: '', bytes: 0 }; }
    if (status === 403 || status === 429) { res.resume(); throw unavailable(`EDGAR is limiting requests (HTTP ${status})`, 300); }
    if (status !== 200) { res.resume(); throw unavailable(`EDGAR answered HTTP ${status}`, 120); }
    const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const tooLarge = () => Object.assign(new Error(`document is over the ${maxBytes}-byte limit`), { code: 'TOO_LARGE' });
    if (Number(res.headers['content-length'] || 0) > maxBytes) { res.destroy(); throw tooLarge(); }
    let size = 0;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { res.destroy(); reject(unavailable('timed out reading the document', 60)); }, Math.max(1, deadline - Date.now()));
      const stop = (err) => { clearTimeout(t); res.destroy(); reject(err); };
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) return stop(tooLarge());
        try { onChunk(c); } catch (e) { stop(e); }
      });
      res.on('end', () => { clearTimeout(t); resolve(); });
      res.on('error', (e) => stop(unavailable(`read failed (${String(e.message).slice(0, 80)})`, 60)));
    });
    return { status: 200, url: u.href, contentType: type, bytes: size };
  }
}

/** a JSON document from EDGAR -> the parsed value, or null for a 404 ; a body that is not JSON is an outage, never a finding */
async function getJson(d, url, opts) {
  const r = await d.fetch(url, { maxBytes: MAX_JSON, accept: 'application/json', ...opts });
  if (r.status === 404) return null;
  try { return JSON.parse(r.body.toString('utf8')); } catch { throw unavailable('EDGAR answered with a document that could not be parsed', 120); }
}

// ---- submissions --------------------------------------------------------------------------------------------------------------------------------------------------------------
// The forms the tool reads; every other filing (a Form 4 is one in five) is counted only for how far back the list reaches.
const WANT = new Set(['10-K', '10-K/A', '10-KT', '10-KT/A', '10-K405', '10-Q', '10-Q/A', '10-QT', '8-K', '8-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);

const FORM4_KEEP = 40;                                   // the newest Form 4 / 4/A rows of the recent block are kept (a few small objects) for the insider section; no other Form 4 row is kept
const FORM4_DOC = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}\.xml$/;

/** the columns EDGAR uses in both the `recent` block and the older pages -> { rows (wanted forms only, newest first as EDGAR lists them), form4 (the newest Form 4 rows), oldest } */
function rowsOf(cols, cik) {
  const rows = []; const form4 = []; let oldest = null;
  if (!cols || !Array.isArray(cols.accessionNumber) || !Array.isArray(cols.form) || !Array.isArray(cols.filingDate)) return { rows, form4, oldest };
  for (let i = 0; i < cols.accessionNumber.length; i++) {
    const filed = String(cols.filingDate[i] || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(filed) && (oldest === null || filed < oldest)) oldest = filed;
    const form = String(cols.form[i] || '');
    const accession = String(cols.accessionNumber[i] || '');
    if ((form === '4' || form === '4/A') && form4.length < FORM4_KEEP && ACCESSION.test(accession) && /^\d{4}-\d{2}-\d{2}$/.test(filed)) {
      const pd = cols.primaryDocument && cols.primaryDocument[i] ? String(cols.primaryDocument[i]) : null;
      form4.push({ form, filed, accession, primary_document: pd && FORM4_DOC.test(pd) ? pd : null });
    }
    if (!WANT.has(form)) continue;
    if (!ACCESSION.test(accession) || !/^\d{4}-\d{2}-\d{2}$/.test(filed)) continue;
    const rd = cols.reportDate && cols.reportDate[i] ? String(cols.reportDate[i]) : null;
    const doc = cols.primaryDocument && cols.primaryDocument[i] ? String(cols.primaryDocument[i]) : null;
    const items = cols.items && cols.items[i] ? String(cols.items[i]).split(',').map((x) => x.trim()).filter((x) => /^\d{1,2}\.\d{2}$/.test(x)) : [];
    rows.push({ form, filed, report_date: rd && /^\d{4}-\d{2}-\d{2}$/.test(rd) ? rd : null, accession, primary_document: doc && DOCNAME.test(doc) ? doc : null, items, cik });
  }
  return { rows, form4, oldest };
}

/** one company's filing list. `pages` holds the older files EDGAR names; loadOlder() adds rows from them when the 24-month window or a missing report needs them */
async function fetchSubmissions(cik, d) {
  if (!CIK10.test(cik)) throw unavailable('company number is not valid', 3600);
  const j = await getJson(d, `https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!j || typeof j !== 'object') return null;
  const { rows, form4, oldest } = rowsOf(j.filings && j.filings.recent, cik);
  const files = (j.filings && Array.isArray(j.filings.files) ? j.filings.files : [])
    .filter((f) => f && SUBPAGE.test(String(f.name)) && /^\d{4}-\d{2}-\d{2}$/.test(String(f.filingTo || '')))
    .map((f) => ({ name: String(f.name), from: String(f.filingFrom || ''), to: String(f.filingTo) })).sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
  const str = (x) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 300) : null);
  return {
    cik, name: str(j.name), category: str(j.category), fiscal_year_end: /^\d{4}$/.test(String(j.fiscalYearEnd || '')) ? String(j.fiscalYearEnd) : null,
    website: str(j.website), investor_website: str(j.investorWebsite), tickers: Array.isArray(j.tickers) ? j.tickers.filter((t) => typeof t === 'string').slice(0, 8) : [], exchanges: Array.isArray(j.exchanges) ? j.exchanges.filter((t) => typeof t === 'string').slice(0, 8) : [],
    sic_description: str(j.sicDescription),
    rows, form4, oldest_covered: oldest, files, pages_loaded: 0, exhausted: files.length === 0,
  };
}

/**
 * Reads older pages (newest first) until the list reaches back to `cutoff` (YYYY-MM-DD) or `maxPages` have been read. With `needReports` it also keeps reading while the list holds no
 * 10-K and no 10-Q (a filer that went quiet). -> sub, changed in place; sub.window_complete says whether the list now reaches `cutoff`.
 */
async function loadOlder(sub, cutoff, d, { maxPages = 3, needReports = false } = {}) {
  const have = () => sub.rows.some((r) => /^10-[KQ]/.test(r.form));
  while (sub.files.length > sub.pages_loaded && sub.pages_loaded < maxPages && ((sub.oldest_covered !== null && sub.oldest_covered > cutoff) || (needReports && !have()))) {
    const page = sub.files[sub.pages_loaded];
    sub.pages_loaded++;
    const j = await getJson(d, `https://data.sec.gov/submissions/${page.name}`);
    if (!j) continue;
    const { rows, oldest } = rowsOf(j, sub.cik);
    sub.rows.push(...rows);
    if (oldest !== null && (sub.oldest_covered === null || oldest < sub.oldest_covered)) sub.oldest_covered = oldest;
  }
  sub.exhausted = sub.files.length <= sub.pages_loaded;
  sub.window_complete = sub.exhausted || (sub.oldest_covered !== null && sub.oldest_covered <= cutoff);
  return sub;
}

module.exports = {
  UA, RATE, MAX_JSON, MAX_DOC, STREAM_MS, HOSTS, WANT, ACCESSION, DOCNAME,
  makeLimiter, defaultEdgarFetch, streamDocument, lockUrl, getJson, fetchSubmissions, loadOlder, rowsOf,
  docUrl, indexUrl, submissionsUrl, isStaticSource, isSecUrl,
};

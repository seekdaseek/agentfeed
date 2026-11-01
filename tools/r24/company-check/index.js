// tools/r24/company-check/index.js: GET /api/company-check?q=<company name, ticker or website> (R24 item 5, 1 Nov 2026). $0.25. Deterministic: no language model, no judgment beyond the fixed rules.
//
// One call resolves the company on EDGAR (resolve.js), reads its filing list (edgar.js), reads the primary document of the latest 10-K and the latest 10-Q once each and tests them for
// going-concern language (going-concern.js), checks the 8-K list for Item 3.01 over the last 24 months, applies the staleness rule (staleness.js), reads the Form 4 direction over a stated window
// (insider.js: the computation of tools/sec.js getInsiderTrades through this tool's own reader), and, when a website is known, runs site-signals (RDAP off) in parallel. The verdict line is a template over
// the flags (verdict.js). Every fact carries a `source` on sec.gov; the website section is labelled as the service's own live read and is never mixed into the EDGAR facts.
//
// Failure semantics (tools/r23/common.js): a bad `q` or `site` is a 400 before any request; EDGAR down, throttling us, or unparsable is a 503; a company that files no 10-K or 10-Q (a foreign private issuer
// on 20-F or 40-F is named as such) or whose latest annual report is over the read limit (v2: 40 MB) is a 404 "not covered"; a domain that matches no company name is a 404 too; all are "Not charged". A fact that could not
// be read is null with a reason.
// Fair access: one declared User-Agent, 8 requests a second (one bucket, edgar.js), and a process-wide lane so EDGAR phases of different calls do not overlap.
// Memory (v2): a filing is read as a STREAM (html-stream.js): each chunk is turned into lines of visible text and each line goes to the phrase analyser, so no document and no text of it is ever held; what is kept
// across calls is the per-accession result (a few hundred bytes), the Form 4 results per accession, both in caches bounded by entries and bytes, for 24 hours, and the SEC company list as text (800 KB) for 24 hours.
'use strict';
const { unavailable, notCovered, bad, envNum } = require('../../r23/common');
const E = require('./edgar');
const R = require('./resolve');
const GC = require('./going-concern');
const { staleness, RULE: STALE_RULE } = require('./staleness');
const { verdictLine } = require('./verdict');
const { itemObjects } = require('./items');
const INS = require('./insider');
const MEM = require('./memory');
const { makeHtmlScanner, makePlainScanner } = require('./html-stream');

const USD = 0.25;
const NAME = 'get_company_check';
const ROUTE = 'GET /api/company-check';
const WINDOW_MONTHS = 24;
const INSIDER_DAYS = 90;
const INSIDER_WAIT_MS = 12000;
const MAX_8K_LISTED = 10;
const MAX_LIST_PAGES = 15;            // older pages of the filing list read at most (a bank with thousands of prospectus filings needs 11 to reach back 24 months)
const MIN_TEXT_CHARS = 5000;           // a 10-K or 10-Q has far more text than this; less means the document was not what it should be
const TEN_K = ['10-K', '10-KT', '10-K405'];
const TEN_Q = ['10-Q', '10-QT'];
const FOREIGN = ['20-F', '20-F/A', '40-F', '40-F/A'];

const isoOf = (t) => new Date(t).toISOString().slice(0, 10);
const cutoffOf = (now) => { const c = new Date(now); c.setUTCMonth(c.getUTCMonth() - WINDOW_MONTHS); return isoOf(c.getTime()); };
const strip = (msg) => String(msg).replace(/\s*Not charged\.?$/i, '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 200);
const newest = (rows) => rows.slice().sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : a.accession < b.accession ? 1 : -1));

// ---------------------------------------------------------------------------------------------------- in-flight limit and the EDGAR lane
/** at most `max` calls in flight; a call that cannot get a slot within waitMs is refused (503, Not charged) before it fetches anything */
function makeGate({ max = 2, waitMs = 2000 } = {}) {
  let active = 0; const queue = [];
  const take = () => { active++; let done = false; return () => { if (done) return; done = true; active--; drain(); }; };
  function drain() { while (queue.length && active < max) { const w = queue.shift(); clearTimeout(w.timer); w.resolve(take()); } }
  return {
    acquire() {
      if (active < max) return Promise.resolve(take());
      return new Promise((resolve, reject) => {
        const w = { resolve, timer: null };
        w.timer = setTimeout(() => { const i = queue.indexOf(w); if (i >= 0) queue.splice(i, 1); reject(unavailable('company-check is busy', 5)); }, waitMs);
        queue.push(w);
      });
    },
    stats: () => ({ active, waiting: queue.length, max }),
  };
}
/** one EDGAR phase at a time in this process: the filing reads (this module's limiter) and the insider function (its own) never overlap, so together they stay under the 8 a second */
function makeLane({ waitMs = 25000 } = {}) {
  let tail = Promise.resolve(); let waiting = 0;
  return {
    run(fn) {
      waiting++;
      const mine = tail.then(() => undefined, () => undefined);
      let release; const hold = new Promise((r) => { release = r; });
      tail = mine.then(() => hold);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { waiting--; release(); reject(unavailable('EDGAR reads are queued behind other calls', 10)); }, waitMs);
        mine.then(async () => { clearTimeout(t); waiting--; try { resolve(await fn()); } catch (e) { reject(e); } finally { release(); } });
      });
    },
    stats: () => ({ waiting }),
  };
}

// ---------------------------------------------------------------------------------------------------- the per-accession result cache (24 h, bounded by entries and bytes)
function makeCache({ ttlMs = 24 * 3600e3, maxEntries = 400, maxBytes = 512 * 1024 } = {}) {
  const m = new Map(); let bytes = 0;
  const drop = (k) => { const e = m.get(k); if (e) { bytes -= e.bytes; m.delete(k); } };
  return {
    get(k, now = Date.now()) { const e = m.get(k); if (!e) return undefined; if (now - e.at >= ttlMs) { drop(k); return undefined; } m.delete(k); m.set(k, e); return e.v; },
    set(k, v, now = Date.now()) {
      drop(k); const b = JSON.stringify(v).length * 2 + 64;
      if (b > maxBytes / 4) return;
      m.set(k, { at: now, v, bytes: b }); bytes += b;
      while (m.size > maxEntries || bytes > maxBytes) drop(m.keys().next().value);
    },
    get size() { return m.size; }, get bytes() { return bytes; },
  };
}

const SHARED = { gate: makeGate(), lane: makeLane(), cache: makeCache(), form4Cache: makeCache({ maxEntries: 300, maxBytes: 256 * 1024 }) };
// site-signals is loaded the first time a site is read or a site parameter is checked (the server has it loaded anyway); RDAP is off whatever the environment says: the tool never calls a registry
let siteOffInst = null;
const siteOff = () => siteOffInst || (siteOffInst = require('../../r23/site-signals').create({}));

// ---------------------------------------------------------------------------------------------------- reading one filing
class ReadError extends Error { constructor(msg, transient) { super(msg); this.transient = transient; } }

/**
 * -> the analysis of one filing's primary document ; throws ReadError (transient: EDGAR down or throttling; otherwise this document cannot be read).
 * v2: the document is read as a STREAM (EDGAR's own address, the guard of lib/safe-fetch.js, a byte cap of d.maxDocBytes): each chunk goes to the text scanner (html-stream.js) and each line of text to the
 * analyser, so nothing the size of the document, or of its text, is ever held. `d.beforeRead()` is called first when given (the memory run forces a garbage collection there).
 */
async function readFiling(row, cik, d) {
  const hit = d.cache.get(row.accession, d.now());
  if (hit) return { ...hit, cached: true };
  if (!row.primary_document) throw new ReadError('the filing has no primary document in a readable format (htm, html or txt)', false);
  const url = E.docUrl(cik, row.accession, row.primary_document);
  const html = /\.html?$/i.test(row.primary_document);
  const analyser = GC.makeAnalyser();
  let chars = 0;
  const scanner = (html ? makeHtmlScanner : makePlainScanner)((l) => { chars += l.length + 1; analyser.line(l); });
  if (typeof d.beforeRead === 'function') d.beforeRead();
  const tally = MEM.perDocument(d.collect);
  let r;
  try {
    r = await d.stream(url, { maxBytes: d.maxDocBytes }, (c) => { tally.add(c.length); try { scanner.push(c); } catch { throw Object.assign(new Error('the document could not be converted to text'), { convert: true }); } });
    scanner.end();
  } catch (e) {
    if (e && e.code === 'TOO_LARGE') throw new ReadError(`the document is over the ${Math.round(d.maxDocBytes / 1e6)} MB read limit`, false);
    if (e && e.convert) throw new ReadError(e.message, false);
    throw new ReadError(strip(e && e.message), true);
  }
  if (r.status !== 200) throw new ReadError('EDGAR does not serve this document', false);
  chars = Math.max(0, chars - 1);
  if (chars < MIN_TEXT_CHARS) throw new ReadError('the document holds too little text to be the report', false);
  const v = { url, chars, ...analyser.finish() };
  d.cache.set(row.accession, v, d.now());
  return { ...v, cached: false };
}

function filingSection(row, cik, res) {
  const index_url = E.indexUrl(cik, row.accession);
  const base = { form: row.form, period: row.report_date, filed: row.filed, accession: row.accession, index_url, source: index_url };
  if (!res || res.error) return { ok: false, ...base, document_url: row.primary_document ? E.docUrl(cik, row.accession, row.primary_document) : null, reason: res ? res.error : 'not read', going_concern: null };
  return { ok: true, ...base, document_url: res.url, chars_read: res.chars, cached: res.cached,
    going_concern: { found: res.found, mentions: res.mentions, affirmative: res.affirmative, non_asserting: res.non_asserting, quote: res.quote, quote_url: res.quote === null ? null : res.url, quote_truncated: res.quote_truncated,
      non_asserting_example: res.non_asserting_example, alleviation_mentions: res.alleviation } };
}

// ---------------------------------------------------------------------------------------------------- the pieces of the answer
function delistingOf(sub, cutoff, todayIso) {
  const rows = newest(sub.rows.filter((r) => (r.form === '8-K' || r.form === '8-K/A') && r.filed >= cutoff && r.items.includes('3.01')));
  const complete = Boolean(sub.window_complete);
  const filings = rows.slice(0, 5).map((r) => ({ form: r.form, filed: r.filed, accession: r.accession, items: itemObjects(r.items), index_url: E.indexUrl(sub.cik, r.accession) }));
  const flag = rows.length ? true : (complete ? false : null);
  return {
    flag, count: rows.length, window: { from: cutoff, to: todayIso, complete }, latest_filed: rows.length ? rows[0].filed : null, filings,
    ...(flag === null ? { reason: 'EDGAR\'s filing list does not reach back the full window' } : {}),
    item: { number: '3.01', title: 'Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard; Transfer of Listing' },
    source: rows.length ? E.indexUrl(sub.cik, rows[0].accession) : E.submissionsUrl(sub.cik),       // the filing list the answer is read from
  };
}
function recent8k(sub) {
  return newest(sub.rows.filter((r) => r.form === '8-K')).slice(0, MAX_8K_LISTED).map((r) => ({ filed: r.filed, accession: r.accession, items: itemObjects(r.items), index_url: E.indexUrl(sub.cik, r.accession), source: E.indexUrl(sub.cik, r.accession) }));
}

function insiderOf(r, cik) {
  const trades = Array.isArray(r.trades) ? r.trades : [];
  const buys = trades.filter((t) => t.code === 'P'); const sales = trades.filter((t) => t.code === 'S');
  const bu = Number(r.open_market_buys_usd) || 0; const su = Number(r.open_market_sales_usd) || 0;
  const dir = !buys.length && !sales.length ? 'no_open_market_trades'
    : (bu || su) ? (bu > su ? 'net_purchases' : su > bu ? 'net_sales' : 'balanced')
      : (buys.length > sales.length ? 'net_purchases' : sales.length > buys.length ? 'net_sales' : 'balanced');
  const filed = r.oldest_trade_filed ? [r.oldest_trade_filed] : trades.map((t) => t.filed).filter(Boolean).sort();
  return {
    ok: true, window_days: r.window_days, window_complete: !r.filings_capped, ...(r.filings_capped ? { covers_from: filed.length ? filed[0] : null } : {}),
    form4_filings: r.form4_filings, transactions: r.transactions,
    open_market_purchases: { count: buys.length, usd: bu }, open_market_sales: { count: sales.length, usd: su }, net_usd: Math.round((bu - su) * 100) / 100, net_direction: dir,
    note: 'open-market purchases (code P) and sales (code S) only; awards, tax withholding, exercises and gifts are not counted',
    source: E.submissionsUrl(cik),
  };
}

/** the site-signals answer -> the short summary this tool shows (the full answer is the site-signals route) */
function siteSummary(r, from) {
  const p = r.page || {}; const t = r.tls || {}; const n = r.dns || {}; const h = r.headers || {};
  return {
    ok: true, from, host: r.host, url: r.url, fetched_at: r.fetched_at,
    page: { ok: Boolean(p.ok), status: p.status == null ? null : p.status, final_url: p.final_url || null, redirected: Boolean(p.redirected), reason: p.ok ? undefined : p.reason },
    tls: { ok: Boolean(t.ok), protocol: t.protocol || null, issuer: t.issuer ? t.issuer.organization || t.issuer.common_name || null : null, valid_to: t.valid_to || null, days_left: t.days_left == null ? null : t.days_left, expired: t.expired == null ? null : t.expired, reason: t.ok ? undefined : t.reason },
    dns: { ok: Boolean(n.ok), a: n.counts ? n.counts.a : null, aaaa: n.counts ? n.counts.aaaa : null, mx: n.counts ? n.counts.mx : null, spf: n.spf ? Boolean(n.spf.present) : null, dmarc: n.dmarc ? (n.dmarc.present ? n.dmarc.policy || 'present' : 'absent') : null, caa: n.counts ? n.counts.caa : null, reason: n.ok ? undefined : n.reason },
    headers: { ok: Boolean(h.ok), grade: h.grade || null, score: h.score == null ? null : h.score, max: h.max == null ? null : h.max, reason: h.ok ? undefined : h.reason },
    note: 'a live read of the site by this service (TLS handshake, DNS, one page request), not a fact from EDGAR',
  };
}
const siteHostOf = (v) => { if (!v) return null; try { const h = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase().replace(/\.$/, ''); return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : null; } catch { return null; } };

/** the website section: started as soon as the host is known, never fails the answer */
async function runSite(host, from, d) {
  try {
    const r = await d.getSiteSignals({ url: `https://${host}/` });
    return { ...siteSummary(r, from), host, url: `https://${host}/` };       // the site that was asked for, whatever the answer says
  } catch (e) {
    return { ok: false, from, host, reason: strip((e && e.message) || 'the site could not be read'), note: 'a live read of the site by this service, not a fact from EDGAR' };
  }
}

// ---------------------------------------------------------------------------------------------------- method text (numbers come from the constants above)
const methodText = (maxBytes) => `Read from EDGAR: the SEC company list, the company's filing list, the primary document of the latest 10-K and of the latest 10-Q (read as a stream and turned into visible text a line at a time, at most ${Math.round(maxBytes / 1e6)} MB each, never held whole), the 8-K list for Item 3.01 over the last ${WINDOW_MONTHS} months, and the Form 4 filings of the last ${INSIDER_DAYS} days through the existing insider function. Going-concern test: "substantial doubt" with "going concern" within ${GC.NEAR} characters in one line; each sentence is judged by a fixed list of rules, and a denial, a hedge, a definition or a resolution is not counted, so the flag is true only when a sentence says the doubt exists. The first such sentence is quoted word for word. Only the primary document of each filing is read: language that sits only in an exhibit is not seen. Absence of language in the documents read is not evidence of absence elsewhere. Item 3.01 also covers regained compliance and listing transfers; the 8-K itself is not read. The website section is a live read by this service (site-signals, registration data off) of the site named in it (the site parameter, else the website given as q, else the one EDGAR lists), not an EDGAR fact. A website given as q that EDGAR does not map is matched by its domain to the company name, and the answer says how. Facts as the documents state them: no rating, no prediction, no advice.`;

// ---------------------------------------------------------------------------------------------------- assembling the answer (pure: the constructed example uses it too)
function assemble(x) {
  const { resolved, sub, tenK, tenQ, delisting, eightK, stale, insider, website, now, maxBytes } = x;
  const read = [tenK, tenQ].filter((s) => s && s.ok);
  const gcForms = read.filter((s) => s.going_concern.found).map((s) => s.form === '10-KT' ? '10-K' : s.form === '10-QT' ? '10-Q' : s.form);
  const formsRead = read.map((s) => (/^10-K/.test(s.form) ? '10-K' : '10-Q'));
  const gcFlag = read.length ? gcForms.length > 0 : null;
  const quoted = read.find((s) => s.going_concern.found);
  const alleviation = read.some((s) => s.going_concern.found && s.going_concern.alleviation_mentions > 0);
  const going_concern = {
    flag: gcFlag, read: formsRead, found_in: gcForms,
    quote: quoted ? quoted.going_concern.quote : null, quote_url: quoted ? quoted.going_concern.quote_url : null, quote_truncated: quoted ? quoted.going_concern.quote_truncated : false,
    ...(read.length ? {} : { reason: 'neither the latest 10-K nor the latest 10-Q could be read' }),
    source: (quoted || read[0] || { document_url: null }).document_url,
  };
  const todayIso = isoOf(now);
  const flags = { going_concern: gcFlag, delisting_notice_8k: delisting.flag, stale: stale.stale };
  const verdict = verdictLine({ going_concern: gcFlag, gc_forms: gcForms, gc_read: formsRead.length ? formsRead : ['10-K'], alleviation, delisting: delisting.flag, delisting_date: delisting.latest_filed, delisting_count: delisting.count,
    stale: stale.stale, expected_period_end: stale.expected_period_end, due_date: stale.due_date });
  return {
    query: { q: resolved.q, resolved_by: resolved.via, ...(resolved.match ? { match: resolved.match } : {}) },
    company: { name: sub.name || resolved.name, cik: sub.cik, ticker: resolved.ticker || (sub.tickers[0] || null), tickers: sub.tickers, exchanges: sub.exchanges, industry: sub.sic_description, fiscal_year_end: sub.fiscal_year_end, filer_category: sub.category, source: E.submissionsUrl(sub.cik) },
    verdict, flags,
    going_concern,
    latest_10k: tenK || { ok: false, reason: 'no 10-K on EDGAR for this company', source: E.submissionsUrl(sub.cik) },
    latest_10q: tenQ || { ok: false, reason: 'no 10-Q on EDGAR for this company', source: E.submissionsUrl(sub.cik) },
    delisting_notice_8k: delisting,
    recent_8k: eightK,
    staleness: { ...stale, source: `https://data.sec.gov/submissions/CIK${sub.cik}.json` },
    insider_form4: insider,
    website,
    fetched_at: new Date(now).toISOString(), as_of: todayIso,
    method: methodText(maxBytes),
  };
}

// ---------------------------------------------------------------------------------------------------- the call
function resolveDeps(deps) {
  const maxDoc = Math.min(Math.max(envNum('R24_COMPANYCHECK_MAX_DOC_BYTES', E.MAX_DOC, deps.env || process.env), 1024 * 1024), E.MAX_DOC);
  const d = { now: Date.now, fetch: E.defaultEdgarFetch, stream: E.streamDocument, getSiteSignals: (a) => siteOff().getSiteSignals(a), ...SHARED, maxDocBytes: maxDoc, insiderDays: INSIDER_DAYS, insiderWaitMs: INSIDER_WAIT_MS, ...deps };
  if (typeof d.getInsiderTrades !== 'function') d.getInsiderTrades = (q) => INS.getInsiderTrades(q, d);       // v2: this tool's own Form 4 reader (insider.js), not the process-wide fetch of tools/sec.js
  return d;
}

/** phase A, in the lane: resolve, read the filing list, read the two documents */
async function phaseA(q, d) {
  const resolved = await R.resolveCompany(q, d);
  let sub = resolved.sub || await E.fetchSubmissions(resolved.cik, d);
  if (!sub) throw unavailable('EDGAR has no filing list for this company right now', 300);
  const now = d.now(); const cutoff = cutoffOf(now);
  await E.loadOlder(sub, cutoff, d, { maxPages: MAX_LIST_PAGES, needReports: true });
  const tenKRow = newest(sub.rows.filter((r) => TEN_K.includes(r.form)))[0] || null;
  const tenQRow = newest(sub.rows.filter((r) => TEN_Q.includes(r.form)))[0] || null;
  if (!tenKRow && !tenQRow) {
    if (sub.rows.some((r) => FOREIGN.includes(r.form))) throw notCovered(`${sub.name || 'this company'} files annual reports on Form 20-F or 40-F (a foreign private issuer), which this tool does not read`);
    throw notCovered(`${sub.name || 'this company'} has no 10-K or 10-Q on EDGAR`);
  }
  // the website to read: the site parameter, else the website given as q, else the one EDGAR lists; started now, read in parallel with the documents
  const fromParam = d.siteHost || null;
  const fromInput = resolved.website_input ? siteHostOf(resolved.website_input) : null;
  const fromEdgar = siteHostOf(sub.website) || siteHostOf(sub.investor_website);
  const host = fromParam || fromInput || fromEdgar;
  const sitePromise = host ? runSite(host, fromParam ? 'the site parameter' : fromInput ? 'the q parameter' : 'EDGAR record', d)
    : Promise.resolve({ ok: false, from: null, host: null, reason: 'no site was given (q is not a website and there is no site parameter) and EDGAR lists no website for this company', note: 'a live read of the site by this service, not a fact from EDGAR' });

  const sections = {};
  for (const [key, row] of [['tenK', tenKRow], ['tenQ', tenQRow]]) {
    if (!row) { sections[key] = null; continue; }
    try {
      sections[key] = filingSection(row, sub.cik, await readFiling(row, sub.cik, d));
    } catch (e) {
      if (!(e instanceof ReadError)) throw e;
      if (e.transient) throw unavailable(`${row.form} could not be read from EDGAR (${e.message})`, 120);
      if (key === 'tenK') throw notCovered(`the latest annual report of ${sub.name || 'this company'} cannot be read by this tool (${e.message})`);
      sections[key] = filingSection(row, sub.cik, { error: e.message });
    }
  }
  if (sections.tenK && sections.tenK.ok) {
    const amends = newest(sub.rows.filter((r) => r.form === '10-K/A' && r.filed >= tenKRow.filed)).slice(0, 3);
    if (amends.length) sections.tenK.later_amendments = amends.map((r) => ({ form: r.form, filed: r.filed, accession: r.accession, index_url: E.indexUrl(sub.cik, r.accession) }));
  }
  const todayIso = isoOf(now);
  const delisting = delistingOf(sub, cutoff, todayIso);
  const stale = staleness({ fiscalYearEnd: sub.fiscal_year_end, category: sub.category, rows: sub.rows, today: now });
  return { resolved: { ...resolved, q }, sub, ...sections, delisting, eightK: recent8k(sub), stale, sitePromise };
}

/** phase B, in the lane: the Form 4 section, with a wait limit (the lane stays held until the read itself has finished) */
async function phaseB(a, d) {
  const src = E.submissionsUrl(a.sub.cik);
  let timer;
  const work = Promise.resolve().then(() => d.getInsiderTrades({ ticker: a.resolved.ticker || a.sub.tickers[0] || null, cik: a.sub.cik, days: d.insiderDays, rows: a.sub.form4 || [] })).then((r) => ({ r }), (e) => ({ e }));
  const first = await Promise.race([work, new Promise((res) => { timer = setTimeout(() => res({ late: true }), d.insiderWaitMs); })]);
  clearTimeout(timer);
  if (first.late) { await Promise.race([work, new Promise((res) => { timer = setTimeout(res, 30000); })]); clearTimeout(timer); return { ok: false, window_days: d.insiderDays, reason: 'the Form 4 filings did not arrive in time', source: src }; }
  if (first.e) return { ok: false, window_days: d.insiderDays, reason: strip((first.e && first.e.message) || 'the Form 4 function failed'), source: src };
  try { return insiderOf(first.r, a.sub.cik); } catch { return { ok: false, window_days: d.insiderDays, reason: 'the Form 4 answer could not be read', source: src }; }
}

/** the optional `site` parameter -> a host name, or null ; a 400 (before any request) for anything that is not a public website the site-signals guard would read */
function parseSiteParam(raw) {
  if (raw == null || raw === '') return null;
  if (Array.isArray(raw)) throw bad('give one site');
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > 2048) throw bad('site is over the 2048-character limit');
  let u;
  try { u = require('../../r23/site-signals').parseSiteUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch (e) { throw bad(`site: ${String(e.message).replace(/^url /, '')}`); }
  return u.hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * @param {{q?: string, site?: string}} args  the merged query
 * @param {object} [deps]  now, fetch(url, opts), getInsiderTrades({ticker, days}), getSiteSignals({url}), gate, lane, cache, maxDocBytes, insiderWaitMs (tests and the gate runner inject; the real path needs none)
 */
async function companyCheck(args, deps = {}) {
  const d = resolveDeps(deps);
  const q = args && args.q;
  R.classifyQuery(q);                                           // 400 before a slot is taken or anything is fetched
  d.siteHost = parseSiteParam(args && args.site);                // so is a bad site
  const release = await d.gate.acquire();                       // 503 "busy" after 2 s, before any request
  try {
    const a = await d.lane.run(() => phaseA(q, d));
    const insider = await d.lane.run(() => phaseB(a, d));
    const website = await a.sitePromise;
    return assemble({ resolved: a.resolved, sub: a.sub, tenK: a.tenK, tenQ: a.tenQ, delisting: a.delisting, eightK: a.eightK, stale: a.stale, insider, website, now: d.now(), maxBytes: d.maxDocBytes });
  } finally { release(); }
}

// ---------------------------------------------------------------------------------------------------- the route entry
const DESC = 'Use when an agent needs to check a US-listed company. Returns a verdict line and the SEC facts behind it: going-concern language, delisting-notice 8-Ks, overdue reports, insider Form 4 direction. EDGAR down (503) or a foreign filer (404) is not charged.';
const EXAMPLE_Q = 'EXMP';

function buildExample() {
  const cik = '0000000001'; const now = Date.parse('2026-11-01T12:00:00.000Z');
  const sub = { cik, name: 'Example Holdings Corp', tickers: [EXAMPLE_Q], exchanges: ['Nasdaq'], sic_description: 'Services-Prepackaged Software', fiscal_year_end: '1231', category: 'Accelerated filer' };
  // the example is the answer for a healthy filer and no site: the Bazaar example travels inside every 402 challenge (12,000 bytes at most), so it is the small case, not the distressed one
  const sec1 = (form, period, filed, acc, doc) => ({ ok: true, form, period, filed, accession: acc, index_url: E.indexUrl(cik, acc), source: E.indexUrl(cik, acc), document_url: E.docUrl(cik, acc, doc), chars_read: 412000, cached: false,
    going_concern: { found: false, mentions: 0, affirmative: 0, non_asserting: 0, quote: null, quote_url: null, quote_truncated: false, non_asserting_example: null, alleviation_mentions: 0 } });
  const tenK = sec1('10-K', '2025-12-31', '2026-03-12', '0000000001-26-000002', 'example-20251231.htm');
  const tenQ = sec1('10-Q', '2026-09-30', '2026-10-30', '0000000001-26-000011', 'example-20260930.htm');
  const rows = [{ form: '8-K', filed: '2026-09-02', accession: '0000000001-26-000009', items: ['5.02', '9.01'] }, { form: '8-K', filed: '2026-08-14', accession: '0000000001-26-000007', items: ['2.02', '9.01'] }];
  const subRows = { cik, rows: rows.map((r) => ({ ...r, cik, report_date: null, primary_document: null })), window_complete: true };
  const delisting = delistingOf(subRows, '2024-11-01', '2026-11-01');
  const stale = { stale: false, rule: STALE_RULE, latest_report_period: '2026-09-30', expected_period_end: '2026-09-30', expected_form: '10-Q', due_date: '2026-11-19' };
  const insider = insiderOf({ window_days: INSIDER_DAYS, filings_capped: false, form4_filings: 4, transactions: 6, open_market_buys_usd: 0, open_market_sales_usd: 184500, trades: [{ code: 'S', filed: '2026-10-08' }, { code: 'S', filed: '2026-10-08' }, { code: 'A', filed: '2026-09-15' }] }, cik);
  const website = { ok: false, from: null, host: null, reason: 'no site was given (q is not a website and there is no site parameter) and EDGAR lists no website for this company', note: 'a live read of the site by this service, not a fact from EDGAR' };
  return assemble({ resolved: { q: EXAMPLE_Q, via: 'ticker', ticker: EXAMPLE_Q, name: sub.name }, sub: { ...sub, rows: [] }, tenK, tenQ, delisting, eightK: recent8k(subRows), stale, insider, website, now, maxBytes: E.MAX_DOC });
}

let ENTRIES = null;
/** the route entry; built on first use, so a process that only runs companyCheck() (the gate runner, a script) never loads zod */
function makeEntries() {
  const { z } = require('zod');
  return [
  { name: NAME, route: ROUTE, usd: USD,
    tags: ['sec', 'edgar', 'company', 'due-diligence', 'going-concern', 'delisting', '8-k', '10-k', 'insider', 'compliance'],
    desc: DESC,
    schema: {
      q: z.string().describe('the company: a US-listed ticker such as AAPL, the company name as it is filed, or its website such as example.com (EDGAR rarely maps a website, so a website is matched by its domain to the company name and the answer says how)'),
      site: z.string().optional().describe('optional: the company website to read with the site check (TLS, DNS, security headers), such as www.example.com; without it the site is the website given as q, or the one EDGAR lists'),
    },
    title: 'Company check',
    question: 'Do the latest SEC filings of this company carry going-concern language, a delisting-notice 8-K, or an overdue report?',
    example: buildExample(),
    run: async (args) => companyCheck(args || {}) },
  ];
}

module.exports = { MAX_LIST_PAGES, get _siteOff() { return siteOff(); }, runSite, get entries() { return ENTRIES || (ENTRIES = makeEntries()); }, companyCheck, assemble, buildExample, readFiling, phaseA, phaseB, delistingOf, insiderOf, recent8k, siteSummary, makeGate, makeLane, makeCache, parseSiteParam, methodText, DESC, NAME, ROUTE, USD, WINDOW_MONTHS, INSIDER_DAYS, TEN_K, TEN_Q, _shared: SHARED };

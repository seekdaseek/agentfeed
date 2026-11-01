// tools/sec.js — SEC EDGAR: /api/sec-filings, /api/insider-trades, /api/sec-8k (R5 B2).
//
// EDGAR is public: "Anyone can access and download this information for free" (SEC, Accessing
// EDGAR Data); filings and government-created content are "free to access and reuse", cite the
// source, and never use "SEC"/"EDGAR" in a trade name (docs/SOURCES.md). Fair access: at most 10
// requests/second across all our machines with a declared User-Agent carrying a contact; this
// module is the only EDGAR caller and holds ONE limiter at 8/s.
//   ticker -> CIK   https://www.sec.gov/files/company_tickers.json, refreshed once a day
//   filings         https://data.sec.gov/submissions/CIK##########.json
//   Form 4          /Archives/edgar/data/{cik}/{accession}/{primaryDocument without the xsl prefix}
//   8-K, market-wide the current-filings Atom feed (browse-edgar?action=getcurrent&type=8-K)
// EDGAR down or slow is a 503 (never billed); an unknown ticker is a 400.
'use strict';
const UA = 'AgentFeed ochinimus@gmail.com';
const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });

// ---- one global limiter: 8 requests per second ----
const RATE = 8; let tokens = RATE; let last = Date.now(); const waiters = [];
function take() {
  return new Promise((resolve) => {
    const tryNow = () => {
      const now = Date.now(); tokens = Math.min(RATE, tokens + ((now - last) / 1000) * RATE); last = now;
      if (tokens >= 1) { tokens -= 1; resolve(); } else setTimeout(tryNow, Math.ceil(((1 - tokens) / RATE) * 1000));
    };
    tryNow();
  });
}
async function edgar(url, { json = true } = {}) {
  await take();
  let r;
  try { r = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(10000) }); } catch (e) { throw unavailable(`EDGAR unreachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})`); }
  if (r.status === 404) return null;
  if (!r.ok) throw unavailable(`EDGAR answered HTTP ${r.status}`);
  return json ? r.json() : r.text();
}

// ---- ticker -> CIK, daily ----
let tickers = null; // { at, map: Map(TICKER -> { cik, name }) }
async function cikFor(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(t)) throw bad('ticker must be a US-listed symbol such as AAPL, MSFT or BRK-B');
  if (!tickers || Date.now() - tickers.at > 86400e3) {
    const j = await edgar('https://www.sec.gov/files/company_tickers.json');
    if (!j) throw unavailable('EDGAR ticker map unavailable');
    const map = new Map();
    for (const v of Object.values(j)) map.set(String(v.ticker).toUpperCase(), { cik: String(v.cik_str).padStart(10, '0'), name: v.title });
    tickers = { at: Date.now(), map };
  }
  const hit = tickers.map.get(t) || tickers.map.get(t.replace('.', '-')) || tickers.map.get(t.replace('-', '.'));
  if (!hit) throw bad(`unknown ticker ${t}: not in the SEC's company ticker list`);
  return { ticker: t, ...hit };
}
async function submissions(cik) {
  const j = await edgar(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!j) throw unavailable(`EDGAR has no submissions file for CIK ${cik}`);
  const f = j.filings && j.filings.recent;
  const rows = [];
  for (let i = 0; f && i < f.accessionNumber.length; i++) {
    rows.push({ form: f.form[i], filed: f.filingDate[i], report_date: f.reportDate[i] || null, accession: f.accessionNumber[i],
      primary_document: f.primaryDocument[i], description: f.primaryDocDescription[i] || null, items: f.items ? f.items[i] || null : null });
  }
  return { name: j.name, sic: j.sic || null, sic_description: j.sicDescription || null, rows };
}
const docUrl = (cik, acc, doc) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${doc}`;
const indexUrl = (cik, acc) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${acc}-index.htm`;
const CITE = 'Source: SEC EDGAR (sec.gov), public filings.';
// A form this company has never filed and that is not on this list is a typo, not an empty
// finding: 400, never billed. A listed form with no filing is a real answer (count 0).
const COMMON_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A', '6-K', '20-F', '40-F', '3', '4', '4/A', '5', '144',
  'S-1', 'S-1/A', 'S-3', 'S-4', 'S-8', 'F-1', 'F-3', '424B2', '424B3', '424B4', '424B5', 'FWP', 'DEF 14A', 'DEFA14A', 'PRE 14A',
  'SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A', 'SCHEDULE 13D', 'SCHEDULE 13G', '13F-HR', '11-K', 'ARS', 'CORRESP', 'UPLOAD', 'D', 'N-CSR']);

async function getSecFilings(p = {}) {
  const c = await cikFor(p.ticker);
  const form = p.form ? String(p.form).trim().toUpperCase().replace(/\s+/g, ' ') : null;
  if (form && !/^[A-Z0-9][A-Z0-9\-/ ]{0,13}$/.test(form)) throw bad('form must be an EDGAR form type such as 10-K, 10-Q, 8-K, 4, S-1, DEF 14A or 13F-HR');
  const limit = p.limit == null || p.limit === '' ? 10 : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw bad('limit must be an integer from 1 to 50');
  const s = await submissions(c.cik);
  if (form && !COMMON_FORMS.has(form) && !s.rows.some((r) => r.form === form)) {
    throw bad(`${form} is not a common EDGAR form type and ${c.ticker} has not filed one; try 10-K, 10-Q, 8-K, 4, S-1, DEF 14A or 13F-HR`);
  }
  const rows = s.rows.filter((r) => !form || r.form === form).slice(0, limit).map((r) => ({
    form: r.form, filed: r.filed, report_date: r.report_date, accession: r.accession, description: r.description,
    items: r.items, document_url: docUrl(c.cik, r.accession, r.primary_document), index_url: indexUrl(c.cik, r.accession) }));
  return { ticker: c.ticker, cik: c.cik, company: s.name, sic: s.sic, industry: s.sic_description, form: form || 'any', count: rows.length, filings: rows, source: CITE };
}

// ---- Form 4 ----
const xml = () => { const { XMLParser } = require('fast-xml-parser'); return new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (n) => ['reportingOwner', 'nonDerivativeTransaction', 'derivativeTransaction'].includes(n) }); };
const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const num = (x) => { const v = Number(val(x)); return Number.isFinite(v) ? v : null; };
const form4Cache = new Map();
const CODES = { P: 'open-market purchase', S: 'open-market sale', A: 'grant or award', D: 'disposition to the issuer', F: 'tax withholding', M: 'option exercise', C: 'conversion', G: 'gift', X: 'option exercise (in the money)', J: 'other' };
async function form4(cik, row) {
  if (form4Cache.has(row.accession)) return form4Cache.get(row.accession);
  const doc = String(row.primary_document).replace(/^xsl[^/]*\//, '');
  const text = await edgar(docUrl(cik, row.accession, doc), { json: false });
  if (!text) return [];
  const d = xml().parse(text).ownershipDocument || {};
  const owners = (d.reportingOwner || []).map((o) => {
    const rel = o.reportingOwnerRelationship || {};
    const roles = [rel.isDirector === '1' || rel.isDirector === 'true' ? 'director' : null, rel.isOfficer === '1' || rel.isOfficer === 'true' ? (rel.officerTitle || 'officer') : null,
      rel.isTenPercentOwner === '1' || rel.isTenPercentOwner === 'true' ? '10% owner' : null, rel.isOther === '1' ? (rel.otherText || 'other') : null].filter(Boolean);
    return { name: o.reportingOwnerId && o.reportingOwnerId.rptOwnerName, role: roles.join(', ') || null };
  });
  const tx = ((d.nonDerivativeTable || {}).nonDerivativeTransaction || []).map((t) => {
    const a = t.transactionAmounts || {};
    const shares = num(a.transactionShares), price = num(a.transactionPricePerShare);
    const code = t.transactionCoding && t.transactionCoding.transactionCode;
    return { date: val(t.transactionDate), code, code_meaning: CODES[code] || null, acquired_or_disposed: val(a.transactionAcquiredDisposedCode) === 'A' ? 'acquired' : 'disposed',
      shares, price, value_usd: shares != null && price != null ? Math.round(shares * price * 100) / 100 : null,
      shares_after: num(t.postTransactionAmounts && t.postTransactionAmounts.sharesOwnedFollowingTransaction), security: val(t.securityTitle) };
  });
  const out = owners.length ? tx.map((t) => ({ insider: owners.map((o) => o.name).join('; '), role: owners.map((o) => o.role).filter(Boolean).join('; ') || null, ...t, filed: row.filed, accession: row.accession, filing_url: indexUrl(cik, row.accession) })) : [];
  form4Cache.set(row.accession, out);
  if (form4Cache.size > 5000) form4Cache.delete(form4Cache.keys().next().value);
  return out;
}

async function getInsiderTrades(p = {}) {
  const c = await cikFor(p.ticker);
  const days = p.days == null || p.days === '' ? 30 : Number(p.days);
  if (!Number.isInteger(days) || days < 1 || days > 180) throw bad('days must be an integer from 1 to 180');
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const s = await submissions(c.cik);
  const filings = s.rows.filter((r) => (r.form === '4' || r.form === '4/A') && r.filed >= since).slice(0, 25);
  const trades = [];
  for (const f of filings) trades.push(...(await form4(c.cik, f)));
  const sum = (code) => Math.round(trades.filter((t) => t.code === code && t.value_usd).reduce((a, t) => a + t.value_usd, 0) * 100) / 100;
  return { ticker: c.ticker, cik: c.cik, company: s.name, window_days: days, since, form4_filings: filings.length,
    filings_capped: filings.length === 25, transactions: trades.length,
    open_market_buys_usd: sum('P'), open_market_sales_usd: sum('S'), trades, source: CITE };
}

// ---- market-wide 8-K, from the current-filings Atom feed ----
const ITEM_RE = /Item (\d+\.\d+):\s*([^<\n]+)/g;
async function getSec8k(p = {}) {
  const hours = p.hours == null || p.hours === '' ? 24 : Number(p.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw bad('hours must be an integer from 1 to 72');
  const cutoff = Date.now() - hours * 3600e3;
  const out = []; let oldest = Date.now(); let start = 0;
  for (; start < 600 && oldest > cutoff; start += 100) {
    const text = await edgar(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=${start}&count=100&output=atom`, { json: false });
    if (!text) break;
    const entries = text.split('<entry>').slice(1);
    if (!entries.length) break;
    for (const e of entries) {
      const title = (e.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
      const updated = (e.match(/<updated>([^<]*)<\/updated>/) || [])[1];
      const t = Date.parse(updated); if (Number.isFinite(t)) oldest = Math.min(oldest, t);
      if (!(t >= cutoff)) continue;
      const tm = title.match(/^(\S+)\s+-\s+(.*)\s+\((\d{10})\)\s+\((\w+)\)/);
      const summary = (e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '';
      const plain = summary.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const items = [...plain.matchAll(ITEM_RE)].map((m) => ({ item: m[1], title: m[2].trim() }));
      out.push({ form: tm ? tm[1] : '8-K', company: tm ? tm[2] : title, cik: tm ? tm[3] : null, role: tm ? tm[4] : null, filed_at: new Date(t).toISOString(),
        accession: (e.match(/accession-number=([\d-]+)/) || [])[1] || null, items, url: (e.match(/href="([^"]+)"/) || [])[1] || null });
    }
  }
  // the feed lists each filer and subject company separately: keep one row per accession
  const seen = new Set(); const rows = out.filter((r) => (r.accession && seen.has(r.accession) ? false : (seen.add(r.accession), true)));
  const counts = {}; for (const r of rows) for (const i of r.items) counts[i.item] = (counts[i.item] || 0) + 1;
  // the feed is read 600 entries deep at most; on a busier window the oldest hours are cut, and we say so
  const capped = start >= 600 && oldest > cutoff;
  return { window_hours: hours, count: rows.length, window_complete: !capped, ...(capped ? { covers_since: new Date(oldest).toISOString() } : {}), item_counts: counts, filings: rows, source: CITE };
}

module.exports = { getSecFilings, getInsiderTrades, getSec8k, take };  // `take` is the one 8/s EDGAR bucket; tools/r24/company-check shares it so the SEC's 10/s ceiling holds across routes

// tools/r24/company-check/insider.js: the Form 4 section of company-check (R24 item 5, v2): the same computation as tools/sec.js getInsiderTrades (the window, the 25-filing cap, the parse of the Form 4 XML, the
// sums of open-market purchases (code P) and sales (code S)), done through this tool's own EDGAR reader instead of the process-wide fetch. Why: tools/sec.js reads with the global fetch, and the first use
// of the global fetch in a fresh process costs 35 to 60 MB of resident memory by itself (measured: 39 MB at the first request, 17 more reading an 800 KB body), which alone would pass the 60 MB budget of
// the v2 gate. The numbers are the same as sec.js gives, which test/r24-company-check-insider.test.js proves by running both on the same synthetic EDGAR and ops/r24-company-check-insider-equiv.js on live
// filings. Differences: reads go through edgar.js (the 8 a second bucket, safe-fetch, 1 MB per Form 4); a Form 4 that is missing (404) is skipped as sec.js skips it; the Form 4 results are kept per
// accession in a cache bounded by entries and bytes (sec.js keeps up to 5,000); and only what the answer uses is kept of each transaction (code, filing date, value), never an insider's name.
'use strict';
const E = require('./edgar');

const CAP = 25;                      // Form 4 filings read at most (as tools/sec.js)
const MAX_FORM4 = 1024 * 1024;
const CODES_COUNTED = new Set(['P', 'S']);

let xmlParser = null;
const xml = () => {
  if (!xmlParser) {
    const { XMLParser } = require('fast-xml-parser');
    xmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (n) => ['reportingOwner', 'nonDerivativeTransaction', 'derivativeTransaction'].includes(n) });
  }
  return xmlParser;
};
const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const num = (x) => { const v = Number(val(x)); return Number.isFinite(v) ? v : null; };

/** one Form 4 document (text) -> [{ code, value_usd }] ; a document with no reporting owner yields nothing, as in tools/sec.js */
function parseForm4(text) {
  const d = xml().parse(text).ownershipDocument || {};
  if (!(d.reportingOwner || []).length) return [];
  return ((d.nonDerivativeTable || {}).nonDerivativeTransaction || []).map((t) => {
    const a = t.transactionAmounts || {};
    const shares = num(a.transactionShares); const price = num(a.transactionPricePerShare);
    const code = t.transactionCoding && t.transactionCoding.transactionCode;
    return { code: typeof code === 'string' ? code : null, value_usd: shares != null && price != null ? Math.round(shares * price * 100) / 100 : null };
  });
}

/**
 * @param {{ cik: string, days: number, rows: Array<{form, filed, accession, primary_document}> }} q  rows: the newest Form 4 rows of the filing list (edgar.js fetchSubmissions `form4`)
 * @param {{ now: () => number, fetch: Function, form4Cache?: {get, set} }} d
 * @returns the fields of tools/sec.js getInsiderTrades that the answer uses: window_days, form4_filings, filings_capped, transactions, open_market_buys_usd, open_market_sales_usd, and trades (open-market ones only: [{code, filed, value_usd}]); plus oldest_trade_filed
 */
async function getInsiderTrades({ cik, days, rows }, d) {
  const since = new Date(d.now() - days * 86400e3).toISOString().slice(0, 10);
  const filings = rows.filter((r) => r.filed >= since).slice(0, CAP);
  const trades = []; let oldestTrade = null;
  for (const f of filings) {
    let list = d.form4Cache ? d.form4Cache.get(f.accession, d.now()) : undefined;
    if (!list) {
      list = [];
      const doc = f.primary_document ? String(f.primary_document).replace(/^xsl[^/]*\//, '') : null;
      if (doc && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.xml$/.test(doc)) {
        const r = await d.fetch(E.docUrl(cik, f.accession, doc), { maxBytes: MAX_FORM4, accept: 'application/xml,text/xml,*/*' });
        if (r.status === 200) { try { list = parseForm4(r.body.toString('utf8')); } catch { list = []; } }
        r.body = null;
      }
      if (d.form4Cache) d.form4Cache.set(f.accession, list, d.now());
    }
    for (const t of list) trades.push({ code: t.code, filed: f.filed, value_usd: t.value_usd });
    if (list.length && (oldestTrade === null || f.filed < oldestTrade)) oldestTrade = f.filed;
  }
  const sum = (code) => Math.round(trades.filter((t) => t.code === code && t.value_usd).reduce((a, t) => a + t.value_usd, 0) * 100) / 100;
  return { window_days: days, form4_filings: filings.length, filings_capped: filings.length === CAP, transactions: trades.length, oldest_trade_filed: oldestTrade, open_market_buys_usd: sum('P'), open_market_sales_usd: sum('S'), trades: trades.filter((t) => CODES_COUNTED.has(t.code)) };
}

module.exports = { getInsiderTrades, parseForm4, CAP };

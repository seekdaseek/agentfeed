// test/fixtures/r24/company-check/world.js: a synthetic EDGAR for the company-check tests (R24 item 5). Every company, accession, address and sentence is invented; the shapes (company_tickers.json,
// the submissions JSON with its `files` pages, a primary document as inline-XBRL HTML, a 20-F filer) are the ones EDGAR serves. `makeWorld()` returns `{ fetch, calls }`: `fetch(url, opts)` is a
// drop-in for tools/r24/company-check/edgar.js defaultEdgarFetch (it enforces maxBytes the same way, with code TOO_LARGE), and `calls` records every URL asked for.
'use strict';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

const FILLER = [
  'The Company designs, manufactures and sells its products through direct sales and through distributors in North America, Europe and Asia.',
  'Revenue is recognised when control of the promised goods or services transfers to the customer, in an amount that reflects the consideration the Company expects to receive.',
  'Inventories are stated at the lower of cost, determined on a first-in, first-out basis, and net realisable value.',
  'The Company is subject to claims and legal proceedings in the ordinary course of business; management does not expect any outcome to be material.',
  'Property and equipment are depreciated on a straight-line basis over the estimated useful lives of the assets, which range from three to thirty years.',
  'Income taxes are accounted for under the asset and liability method, and deferred tax assets are reduced by a valuation allowance when realisation is not likely.',
];
const filler = (n) => Array.from({ length: n }, (_, i) => `<p style="margin:0">${FILLER[i % FILLER.length]} (note ${i + 1})</p>`).join('\n');

const SENT = {
  affirmative: 'The Company has incurred recurring losses from operations and negative cash flows. These conditions raise substantial doubt about the Company’s ability to continue as a going concern.',
  auditor: 'Our independent registered public accounting firm has included an explanatory paragraph in its report expressing substantial doubt about our ability to continue as a going concern.',
  negated: 'Based on this evaluation, management concluded that there is no substantial doubt about the Company’s ability to continue as a going concern for the twelve months following the issuance of these financial statements.',
  standard: 'Under ASC 205-40, management is required to evaluate whether there are conditions or events, considered in the aggregate, that raise substantial doubt about the Company’s ability to continue as a going concern.',
  hypothetical: 'If we are unable to obtain financing on acceptable terms, our auditors could raise substantial doubt about our ability to continue as a going concern.',
};

/** a primary document: inline-XBRL HTML with a hidden header (a decoy that must never count), filler and the given sentences */
function doc({ title, sentences = [], hiddenDecoy = true, filler: n = 40 }) {
  const hidden = hiddenDecoy ? '<ix:header><ix:hidden><ix:nonNumeric name="dei:Decoy">There is substantial doubt about the going concern of the hidden header.</ix:nonNumeric></ix:hidden></ix:header>' : '';
  return `<?xml version="1.0" encoding="utf-8"?><html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"><head><title>${title}</title><style>.x{color:red}</style></head><body>${hidden}
<div><p><b>${title}</b></p>${filler(n)}
${sentences.map((s) => `<p>${s}</p>`).join('\n')}
<table><tr><td>Net loss</td><td>(1,204)</td></tr></table>
<script>var substantialDoubt = "substantial doubt going concern";</script></div></body></html>`;
}

/** a Form 4 document (ownershipDocument) with the given non-derivative transactions [{ code, shares, price, ad }] and a derivative one that must never count */
function form4(txs, { owners = 1, derivative = true } = {}) {
  const owner = (i) => `<reportingOwner><reportingOwnerId><rptOwnerCik>000000${i}</rptOwnerCik><rptOwnerName>Insider ${i}</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle></reportingOwnerRelationship></reportingOwner>`;
  const tx = (t) => `<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-10-05</value></transactionDate><transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${t.code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${t.shares}</value></transactionShares>${t.price == null ? '<transactionPricePerShare><footnoteId id="F1"/></transactionPricePerShare>' : `<transactionPricePerShare><value>${t.price}</value></transactionPricePerShare>`}<transactionAcquiredDisposedCode><value>${t.ad || 'D'}</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>1000</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction>`;
  const deriv = derivative ? '<derivativeTable><derivativeTransaction><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>99999</value></transactionShares><transactionPricePerShare><value>99999</value></transactionPricePerShare></transactionAmounts></derivativeTransaction></derivativeTable>' : '';
  return `<?xml version="1.0"?><ownershipDocument><schemaVersion>X0508</schemaVersion><documentType>4</documentType>${Array.from({ length: owners }, (_, i) => owner(i + 1)).join('')}<nonDerivativeTable>${txs.map(tx).join('')}</nonDerivativeTable>${deriv}</ownershipDocument>`;
}

const acc = (n, yy = 26) => `0000000${String(n).padStart(3, '0')}-${yy}-${String(n).padStart(6, '0')}`;
const isoDaysAgo = (d) => new Date(NOW - d * 86400e3).toISOString().slice(0, 10);

function companies() {
  const C = {};
  // 1 healthy large accelerated filer, December year end; its negated and standard-wording sentences must not count
  C.ALDR = { cik: 1000001, name: 'Alder Instruments Inc', ticker: 'ALDR', fye: '1231', category: 'Large accelerated filer', sic: 'Instruments for Measuring', exchanges: ['Nasdaq'],
    filings: [
      { form: '10-K', filed: '2026-02-20', period: '2025-12-31', doc: 'aldr-20251231.htm', text: doc({ title: 'Alder 10-K', sentences: [SENT.negated, SENT.standard, SENT.hypothetical] }) },
      { form: '10-Q', filed: '2026-10-30', period: '2026-09-30', doc: 'aldr-20260930.htm', text: doc({ title: 'Alder 10-Q', sentences: [SENT.negated] }) },
      { form: '10-Q', filed: '2026-07-31', period: '2026-06-30', doc: 'aldr-20260630.htm', text: doc({ title: 'Alder 10-Q 2' }) },
      { form: '8-K', filed: '2026-10-30', items: '2.02,9.01' }, { form: '8-K', filed: '2026-05-01', items: '2.02,9.01' }, { form: '8-K', filed: '2026-02-20', items: '5.02' },
      { form: '4', filed: '2026-10-08', doc: 'xslF345X05/wk-form4_1.xml', rawDoc: 'wk-form4_1.xml', xml: form4([{ code: 'P', shares: 100, price: 10.5, ad: 'A' }, { code: 'S', shares: 40, price: 20, ad: 'D' }, { code: 'A', shares: 500, price: null, ad: 'A' }]) },
      { form: '4', filed: '2026-09-15', doc: 'xslF345X05/wk-form4_2.xml', rawDoc: 'wk-form4_2.xml', xml: form4([{ code: 'S', shares: 25, price: 21.4, ad: 'D' }, { code: 'F', shares: 12, price: 21.4, ad: 'D' }], { owners: 2 }) },
      { form: '4', filed: '2026-06-10', doc: 'xslF345X05/wk-form4_3.xml', rawDoc: 'wk-form4_3.xml', xml: form4([{ code: 'S', shares: 1000, price: 30, ad: 'D' }]) },
    ] };
  // 2 going concern in the 10-K and the 10-Q, a later 10-K/A, a delisting notice 8-K and a 8-K/A
  C.BRLG = { cik: 1000002, name: 'Briar Logistics Corp', ticker: 'BRLG', fye: '1231', category: 'Non-accelerated filer', sic: 'Trucking', exchanges: ['NYSE'],
    filings: [
      { form: '10-K', filed: '2026-04-14', period: '2025-12-31', doc: 'brlg-20251231.htm', text: doc({ title: 'Briar 10-K', sentences: [SENT.affirmative, SENT.auditor, SENT.standard] }) },
      { form: '10-K/A', filed: '2026-04-30', period: '2025-12-31', doc: 'brlg-20251231a.htm', text: doc({ title: 'Briar 10-K/A' }) },
      { form: '10-Q', filed: '2026-11-01', period: '2026-09-30', doc: 'brlg-20260930.htm', text: doc({ title: 'Briar 10-Q', sentences: [SENT.affirmative] }) },
      { form: '8-K', filed: '2026-08-12', items: '3.01' }, { form: '8-K', filed: '2026-09-02', items: '3.01,9.01' }, { form: '8-K/A', filed: '2026-09-09', items: '3.01' }, { form: '8-K', filed: '2026-06-01', items: '1.01' },
    ] };
  // 3 going concern in the 10-K only, no 3.01
  C.CBMN = { cik: 1000003, name: 'Cobalt Mining Co', ticker: 'CBMN', fye: '0630', category: 'Non-accelerated filer', sic: 'Metal Mining', exchanges: ['OTC'],
    filings: [
      { form: '10-K', filed: '2026-09-28', period: '2026-06-30', doc: 'cbmn-20260630.htm', text: doc({ title: 'Cobalt 10-K', sentences: [SENT.affirmative] }) },
      { form: '10-Q', filed: '2026-05-14', period: '2026-03-31', doc: 'cbmn-20260331.htm', text: doc({ title: 'Cobalt 10-Q' }) },
      { form: '8-K', filed: '2026-07-01', items: '8.01' },
    ] };
  // 4 stale: the last periodic report is a 10-K for June 2024; fiscal year end June
  C.DLTA = { cik: 1000004, name: 'Delta Ferries Ltd', ticker: 'DLTA', fye: '0630', category: 'Non-accelerated filer', sic: 'Water Transportation', exchanges: ['NYSE'],
    filings: [
      { form: '10-K', filed: '2024-10-15', period: '2024-06-30', doc: 'dlta-20240630.htm', text: doc({ title: 'Delta 10-K' }) },
      { form: '10-Q', filed: '2024-05-10', period: '2024-03-31', doc: 'dlta-20240331.htm', text: doc({ title: 'Delta 10-Q' }) },
      { form: '8-K', filed: '2025-01-05', items: '5.02' },
    ] };
  // 5 a foreign private issuer: only a 20-F
  C.EXPT = { cik: 1000005, name: 'Eastern Export Holdings plc', ticker: 'EXPT', fye: '1231', category: 'Large accelerated filer', sic: 'Wholesale', exchanges: ['NYSE'],
    filings: [{ form: '20-F', filed: '2026-04-20', period: '2025-12-31', doc: 'expt-20f.htm', text: doc({ title: 'Eastern 20-F' }) }, { form: '6-K', filed: '2026-08-01', items: '' }] };
  // 6 nothing periodic at all
  C.FNCH = { cik: 1000006, name: 'Finch Biotech Inc', ticker: 'FNCH', fye: '1231', category: '', sic: 'Biological Products', exchanges: ['Nasdaq'], filings: [{ form: '8-K', filed: '2026-09-01', items: '8.01' }] };
  // 7 a busy filer: `recent` reaches back only 15 months, an older page holds a delisting notice 8-K from 20 months ago
  const busy = [];
  for (let i = 0; i < 40; i++) busy.push({ form: '4', filed: isoDaysAgo(5 + i * 10) });
  C.GRND = { cik: 1000007, name: 'Grand Textiles Inc', ticker: 'GRND', fye: '0331', category: 'Accelerated filer', sic: 'Textile Mill Products', exchanges: ['Nasdaq'],
    filings: [
      { form: '10-K', filed: '2026-05-29', period: '2026-03-31', doc: 'grnd-20260331.htm', text: doc({ title: 'Grand 10-K' }) },
      { form: '10-Q', filed: '2026-08-07', period: '2026-06-30', doc: 'grnd-20260630.htm', text: doc({ title: 'Grand 10-Q' }) },
      { form: '8-K', filed: '2026-08-07', items: '2.02,9.01' }, ...busy,
    ],
    older: [{ name: 'CIK0001000007-submissions-001.json', filings: [{ form: '8-K', filed: isoDaysAgo(610), items: '3.01' }, { form: '8-K', filed: isoDaysAgo(700), items: '2.02' }, { form: '10-K', filed: '2025-05-30', period: '2025-03-31', doc: 'grnd-20250331.htm', text: doc({ title: 'Grand old 10-K' }) }] }],
    recentReaches: 15 };
  // 8 a company whose 10-K is over the read limit
  C.HUGE = { cik: 1000008, name: 'Huge Filings Corp', ticker: 'HUGE', fye: '1231', category: 'Large accelerated filer', sic: 'Services', exchanges: ['NYSE'],
    filings: [{ form: '10-K', filed: '2026-02-20', period: '2025-12-31', doc: 'huge-20251231.htm', text: doc({ title: 'Huge 10-K' }), padBytes: 6 * 1024 * 1024 }, { form: '10-Q', filed: '2026-10-30', period: '2026-09-30', doc: 'huge-20260930.htm', text: doc({ title: 'Huge 10-Q' }) }] };
  // 9 a healthy company whose 10-Q is a stub (too little text): the 10-Q section reports why, the answer stands on the 10-K
  C.STUB = { cik: 1000009, name: 'Stub Quarterly Inc', ticker: 'STUB', fye: '1231', category: 'Accelerated filer', sic: 'Services', exchanges: ['Nasdaq'],
    filings: [{ form: '10-K', filed: '2026-02-20', period: '2025-12-31', doc: 'stub-20251231.htm', text: doc({ title: 'Stub 10-K' }) }, { form: '10-Q', filed: '2026-10-30', period: '2026-09-30', doc: 'stub-20260930.htm', text: '<html><body><p>See exhibit.</p></body></html>' }] };
  // 10 and 11: two companies a name query cannot tell apart
  C.PNFD = { cik: 1000010, name: 'Pioneer Foods Inc', ticker: 'PNFD', fye: '1231', category: 'Accelerated filer', sic: 'Food', exchanges: ['NYSE'], filings: [{ form: '10-K', filed: '2026-02-20', period: '2025-12-31', doc: 'pnfd.htm', text: doc({ title: 'Pioneer 10-K' }) }] };
  C.PNGP = { cik: 1000011, name: 'Pioneer Foods Group plc', ticker: 'PNGP', fye: '1231', category: 'Accelerated filer', sic: 'Food', exchanges: ['NYSE'], filings: [{ form: '10-K', filed: '2026-02-20', period: '2025-12-31', doc: 'pngp.htm', text: doc({ title: 'Pioneer Group 10-K' }) }] };
  // 12 a company that lists its website on EDGAR (most do not)
  C.INDV = { cik: 1000012, name: 'Indigo Ventures Inc', ticker: 'INDV', fye: '1231', category: 'Non-accelerated filer', sic: 'Services', exchanges: ['Nasdaq'], website: 'www.indigo-ventures.com',
    filings: [{ form: '10-K', filed: '2026-03-30', period: '2025-12-31', doc: 'indv.htm', text: doc({ title: 'Indigo 10-K' }) }, { form: '10-Q', filed: '2026-10-30', period: '2026-09-30', doc: 'indv-q.htm', text: doc({ title: 'Indigo 10-Q' }) }] };
  // 13 a plain-text filing, hard-wrapped
  C.TXTC = { cik: 1000013, name: 'Textfile Corp', ticker: 'TXTC', fye: '1231', category: 'Non-accelerated filer', sic: 'Services', exchanges: ['OTC'],
    filings: [{ form: '10-K', filed: '2026-03-30', period: '2025-12-31', doc: 'txtc.txt', plain: true, text: wrap(`${Array.from({ length: 70 }, (_, i) => FILLER[i % FILLER.length]).join('\n\n')}\n\nThe Company has suffered recurring losses and these conditions raise substantial\ndoubt about the Company's ability to continue as a going\nconcern.\n`) }] };
  // 14 a company whose documents the scenario makes unavailable (the real-server test answers HTTP 503 for any URL containing "outg-")
  C.OUTG = { cik: 1000014, name: 'Outage Systems Inc', ticker: 'OUTG', fye: '1231', category: 'Accelerated filer', sic: 'Services', exchanges: ['Nasdaq'],
    filings: [{ form: '10-K', filed: '2026-02-20', period: '2025-12-31', doc: 'outg-20251231.htm', text: doc({ title: 'Outage 10-K' }) }, { form: '10-Q', filed: '2026-10-30', period: '2026-09-30', doc: 'outg-20260930.htm', text: doc({ title: 'Outage 10-Q' }) }] };
  // 15 a company with 30 Form 4 filings in the last 60 days (the cap of 25 applies), each with one sale or purchase
  C.FRM4 = { cik: 1000015, name: 'Form Four Holdings Inc', ticker: 'FRM4', fye: '1231', category: 'Accelerated filer', sic: 'Services', exchanges: ['Nasdaq'],
    filings: [{ form: '10-K', filed: '2026-02-20', period: '2025-12-31', doc: 'frm4-20251231.htm', text: doc({ title: 'Form Four 10-K' }) },
      ...Array.from({ length: 30 }, (_, i) => ({ form: '4', filed: isoDaysAgo(2 + i * 2), doc: `xslF345X05/f${i}.xml`, rawDoc: `f${i}.xml`, xml: form4([{ code: i % 3 ? 'S' : 'P', shares: 10 + i, price: 5 + (i % 7), ad: i % 3 ? 'D' : 'A' }], { derivative: false }) }))] };
  // 16 and 17: banks whose filing list is spread over many older pages (prospectus filings by the thousand): BANK needs 11 pages to reach back 24 months and has an Item 3.01 8-K on the last of them; DEEP needs 20
  const pages = (n, withNotice, step) => Array.from({ length: n }, (_, i) => ({ name: `CIK00010000${withNotice ? 16 : 17}-submissions-${String(i + 1).padStart(3, '0')}.json`,
    filings: [{ form: '424B2', filed: isoDaysAgo(340 + i * step) }, { form: '424B2', filed: isoDaysAgo(340 + i * step + 20) }, ...(withNotice && i === n - 1 ? [{ form: '8-K', filed: isoDaysAgo(725), items: '3.01' }] : [])] }));
  C.BANK = { cik: 1000016, name: 'Bigbank Holdings Inc', ticker: 'BNKX', fye: '1231', category: 'Large accelerated filer', sic: 'Banks', exchanges: ['NYSE'],
    filings: [{ form: '10-K', filed: '2026-02-20', period: '2025-12-31', doc: 'bnkx-20251231.htm', text: doc({ title: 'Bank 10-K' }) }, { form: '10-Q', filed: '2026-10-30', period: '2026-09-30', doc: 'bnkx-20260930.htm', text: doc({ title: 'Bank 10-Q' }) }, ...Array.from({ length: 30 }, (_, i) => ({ form: '424B2', filed: isoDaysAgo(3 + i * 10) }))],
    older: pages(11, true, 38), recentReaches: 11 };
  C.DEEP = { cik: 1000017, name: 'Deepfile Corp', ticker: 'DEEP', fye: '1231', category: 'Large accelerated filer', sic: 'Banks', exchanges: ['NYSE'],
    filings: [{ form: '10-K', filed: '2026-02-20', period: '2025-12-31', doc: 'deep-20251231.htm', text: doc({ title: 'Deep 10-K' }) }, { form: '10-Q', filed: '2026-10-30', period: '2026-09-30', doc: 'deep-20260930.htm', text: doc({ title: 'Deep 10-Q' }) }, ...Array.from({ length: 30 }, (_, i) => ({ form: '424B2', filed: isoDaysAgo(3 + i * 10) }))],
    older: pages(20, false, 10), recentReaches: 11 };
  return C;
}
function wrap(t) { return t.split('\n').map((l) => (l.length > 78 ? l.replace(/(.{1,76})(\s+|$)/g, '$1\n').trimEnd() : l)).join('\n'); }

const cols = (rows) => {
  const o = { accessionNumber: [], filingDate: [], reportDate: [], form: [], items: [], primaryDocument: [], primaryDocDescription: [] };
  for (const r of rows) { o.accessionNumber.push(r.accession); o.filingDate.push(r.filed); o.reportDate.push(r.period || ''); o.form.push(r.form); o.items.push(r.items || ''); o.primaryDocument.push(r.doc || ''); o.primaryDocDescription.push(''); }
  return o;
};

/** @param {object} [opt] opt.tickersFail, opt.status(url) -> an HTTP status to answer instead, opt.delay(url) -> ms, opt.onCall(url) */
function makeWorld(opt = {}) {
  const C = companies();
  let n = 1;
  for (const c of Object.values(C)) {
    for (const f of [...c.filings, ...(c.older || []).flatMap((p) => p.filings)]) f.accession = acc(n++);
  }
  const bytes = new Map();             // url -> { body, type }
  const calls = [];
  const dir = (c, f) => `https://www.sec.gov/Archives/edgar/data/${c.cik}/${f.accession.replace(/-/g, '')}/${f.doc}`;
  for (const c of Object.values(C)) for (const f of [...c.filings, ...(c.older || []).flatMap((p) => p.filings)]) {
    if (f.rawDoc) { bytes.set(`https://www.sec.gov/Archives/edgar/data/${c.cik}/${f.accession.replace(/-/g, '')}/${f.rawDoc}`, { body: Buffer.from(f.xml, 'utf8'), type: 'text/xml' }); continue; }
    if (!f.doc) continue;
    let body = Buffer.from(f.text, 'utf8');
    if (f.padBytes) body = Buffer.concat([body, Buffer.alloc(f.padBytes, 0x20)]);
    bytes.set(dir(c, f), { body, type: f.plain ? 'text/plain' : 'text/html' });
  }
  const tickers = {}; Object.values(C).forEach((c, i) => { tickers[i] = { cik_str: c.cik, ticker: c.ticker, title: c.name.toUpperCase() === c.name ? c.name : c.name }; });
  // pad the list to a realistic size so the "list looks complete" guard passes
  for (let i = 0; i < 200; i++) tickers[100 + i] = { cik_str: 2000000 + i, ticker: `ZZ${String(i).padStart(3, '0')}`, title: `Filler Company ${i} Inc` };
  const json = new Map();
  json.set('https://www.sec.gov/files/company_tickers.json', tickers);
  for (const c of Object.values(C)) {
    const rows = c.filings.slice().sort((a, b) => (a.filed < b.filed ? 1 : -1));
    const reach = c.recentReaches ? isoDaysAgo(c.recentReaches * 30) : null;
    const recent = reach ? rows.filter((r) => r.filed >= reach) : rows;
    const cik10 = String(c.cik).padStart(10, '0');
    const files = (c.older || []).map((p) => ({ name: p.name, filingCount: p.filings.length, filingFrom: p.filings.map((f) => f.filed).sort()[0], filingTo: p.filings.map((f) => f.filed).sort().pop() }));
    json.set(`https://data.sec.gov/submissions/CIK${cik10}.json`, { cik: cik10, name: c.name, tickers: [c.ticker], exchanges: c.exchanges, sicDescription: c.sic, category: c.category, fiscalYearEnd: c.fye, website: c.website || '', investorWebsite: '',
      filings: { recent: cols(recent), files } });
    for (const p of c.older || []) json.set(`https://data.sec.gov/submissions/${p.name}`, cols(p.filings.slice().sort((a, b) => (a.filed < b.filed ? 1 : -1))));
  }

  async function fetch(url, o = {}) {
    calls.push(url);
    if (opt.onCall) opt.onCall(url);
    if (opt.delay) { const ms = opt.delay(url); if (ms) await new Promise((r) => setTimeout(r, ms)); }
    const forced = opt.status ? opt.status(url) : null;
    if (forced) {
      if (forced === 404) return { status: 404, url, contentType: '', body: Buffer.alloc(0) };
      const e = new Error(forced === 403 || forced === 429 ? `EDGAR is limiting requests (HTTP ${forced}). Not charged.` : `EDGAR answered HTTP ${forced}. Not charged.`); e.status = 503; e.retryAfter = 60; throw e;
    }
    if (json.has(url)) return { status: 200, url, contentType: 'application/json', body: Buffer.from(JSON.stringify(json.get(url))) };
    const b = bytes.get(url);
    if (b) {
      if (o.maxBytes && b.body.length > o.maxBytes) throw Object.assign(new Error(`document is over the ${o.maxBytes}-byte limit`), { code: 'TOO_LARGE' });
      return { status: 200, url, contentType: b.type, body: Buffer.from(b.body) };
    }
    return { status: 404, url, contentType: '', body: Buffer.alloc(0) };
  }
  /** v2: the document reader of the tool (edgar.js streamDocument): onChunk gets the body in pieces of opt.chunk bytes (default 4096); the cap is enforced while streaming, as the real one does */
  async function stream(url, o = {}, onChunk) {
    calls.push(url);
    if (opt.onCall) opt.onCall(url);
    if (opt.delay) { const ms = opt.delay(url); if (ms) await new Promise((r) => setTimeout(r, ms)); }
    const forced = opt.status ? opt.status(url) : null;
    if (forced) {
      if (forced === 404) return { status: 404, url, contentType: '', bytes: 0 };
      const e = new Error(forced === 403 || forced === 429 ? `EDGAR is limiting requests (HTTP ${forced}). Not charged.` : `EDGAR answered HTTP ${forced}. Not charged.`); e.status = 503; e.retryAfter = 60; throw e;
    }
    const b = bytes.get(url);
    if (!b) return { status: 404, url, contentType: '', bytes: 0 };
    const cs = opt.chunk || 4096; let size = 0;
    for (let p = 0; p < b.body.length; p += cs) {
      const c = b.body.subarray(p, p + cs); size += c.length;
      if (o.maxBytes && size > o.maxBytes) throw Object.assign(new Error(`document is over the ${o.maxBytes}-byte limit`), { code: 'TOO_LARGE' });
      onChunk(Buffer.from(c));
    }
    return { status: 200, url, contentType: b.type, bytes: size };
  }
  return { fetch, stream, calls, companies: C, SENT, NOW, urlOf: (key, i = 0) => dir(C[key], C[key].filings.filter((f) => f.doc)[i]) };
}

module.exports = { makeWorld, doc, form4, SENT, NOW, FILLER };

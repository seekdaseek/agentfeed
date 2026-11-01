// test/r24-company-check-parts.test.js: the parts of company-check that need no whole call (R24 item 5): the query and the company list, EDGAR's rows and older pages, the 8 a second
// limiter, the staleness rule, the verdict templates, the bounded cache, the in-flight gate and the EDGAR lane, and the public text. A synthetic EDGAR (fixtures/r24/company-check/world.js).
// Each check has a control: a known-positive input, or a variant that must behave differently.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../tools/r24/company-check/edgar');
const R = require('../tools/r24/company-check/resolve');
const S = require('../tools/r24/company-check/staleness');
const V = require('../tools/r24/company-check/verdict');
const I = require('../tools/r24/company-check/items');
const CC = require('../tools/r24/company-check');
const W = require('./fixtures/r24/company-check/world');

const mk = (opt) => { const w = W.makeWorld(opt); return { w, d: { fetch: w.fetch, now: () => W.NOW } }; };
const rejects = async (p, f) => { try { await p; } catch (e) { f(e); return e; } assert.fail('expected a refusal'); };

// ---------------------------------------------------------------------------------------------------- the query
test('normName: state suffixes and corporate endings go, words stay; known positives from real EDGAR titles', () => {
  const cases = [['COSTCO WHOLESALE CORP /NEW', 'costco wholesale'], ['Apple Inc.', 'apple'], ['BANK OF AMERICA CORP /DE/', 'bank of america'], ['WELLS FARGO & COMPANY/MN', 'wells fargo and'], ['AT&T INC.', 'at and t'],
    ['Meta Platforms, Inc.', 'meta platforms'], ['ELI LILLY & Co', 'eli lilly and'], ['Nestlé S.A.', 'nestle'], ['Inc', 'inc']];
  for (const [raw, want] of cases) assert.equal(R.normName(raw), want, raw);
});

test('classifyQuery: a website is recognised by scheme, slash or a dotted host; a ticker with a dot (BRK.B) and a name with spaces are text; bad input is a 400 before anything else', () => {
  assert.deepEqual(R.classifyQuery('https://www.Example-Co.com/investors?x=1'), { kind: 'website', host: 'www.example-co.com' });
  assert.deepEqual(R.classifyQuery('example-co.com'), { kind: 'website', host: 'example-co.com' });
  assert.deepEqual(R.classifyQuery('example.com/ir'), { kind: 'website', host: 'example.com' });
  assert.deepEqual(R.classifyQuery('BRK.B'), { kind: 'text', text: 'BRK.B' });
  assert.deepEqual(R.classifyQuery('Amazon.com Inc'), { kind: 'text', text: 'Amazon.com Inc' }, 'a name with a dot and a space is a name');
  assert.deepEqual(R.classifyQuery('  AAPL '), { kind: 'text', text: 'AAPL' });
  const badQ = [undefined, null, '', '   ', ['a', 'b'], 'x'.repeat(201), 'a\u0000b', 'ftp://example.com', 'http://', 'https://-bad-.com', 'http://127.0.0.1/', 'localhost/x'];
  for (const q of badQ) { const e = (() => { try { R.classifyQuery(q); } catch (x) { return x; } return null; })(); assert.ok(e && e.kind === 'bad_request', String(JSON.stringify(q)).slice(0, 30)); }
});

test('resolveCompany: ticker (any case, BRK.B = BRK-B), exact name, start of a name, every word; ambiguity is a 400 that names the tickers', async () => {
  R._reset(); const { d } = mk();
  assert.equal((await R.resolveCompany('brlg', d)).cik, '0001000002');
  const byName = await R.resolveCompany('Briar Logistics', d); assert.equal(byName.ticker, 'BRLG'); assert.equal(byName.via, 'name');
  assert.equal((await R.resolveCompany('Briar Logistics Corp', d)).ticker, 'BRLG');
  assert.equal((await R.resolveCompany('logistics briar', d)).ticker, 'BRLG', 'every word of the query, in any order');
  assert.equal((await R.resolveCompany('Pioneer Foods', d)).ticker, 'PNFD', 'the exact name wins over a longer name that starts with it');
  const e = await rejects(R.resolveCompany('Pioneer', d), (x) => { assert.equal(x.kind, 'bad_request'); assert.match(x.message, /matches 2 companies/); });
  assert.deepEqual(e.supported, ['PNFD', 'PNGP']);
  await rejects(R.resolveCompany('zzzzqq', d), (x) => assert.match(x.message, /nothing on EDGAR's company list matches/));
  await rejects(R.resolveCompany('x', d), (x) => assert.match(x.message, /too short|nothing/));
});

test('resolveCompany by website (v2): EDGAR\'s own mapping first; a website EDGAR does not map is matched by its domain to company names, strongest match first; several companies are a 400 that names them, none a 404', async () => {
  R._reset(); const { w, d } = mk();
  for (const q of ['indigo-ventures.com', 'https://www.indigo-ventures.com/ir', 'investors.indigo-ventures.com']) {
    const r = await R.resolveCompany(q, d); assert.equal(r.ticker, 'INDV', q); assert.equal(r.via, 'website'); assert.equal(r.match, 'EDGAR lists this website for the company'); assert.ok(r.sub && r.sub.website === 'www.indigo-ventures.com');
  }
  // not mapped: the domain against the names
  const byName = await R.resolveCompany('https://www.alder-instruments.com/about', d);
  assert.deepEqual([byName.ticker, byName.via, byName.match, byName.website_input], ['ALDR', 'domain-name', 'the company name equals the domain name', 'www.alder-instruments.com']);
  const first = await R.resolveCompany('briar.com', d); assert.deepEqual([first.ticker, first.via, first.match], ['BRLG', 'domain-name', 'the first word of the company name equals the domain name']);
  const starts = await R.resolveCompany('cobaltmining-group.com', d).catch((e) => e); assert.equal(starts.status, 404, 'a label that is not a name');
  const indigo = await R.resolveCompany('indigo.com', d); assert.deepEqual([indigo.ticker, indigo.via, indigo.match], ['INDV', 'domain-name', 'the first word of the company name equals the domain name'], 'EDGAR maps indigo-ventures.com, not indigo.com: this is a name match and says so');
  const amb = await rejects(R.resolveCompany('pioneer.com', d), (x) => { assert.equal(x.kind, 'bad_request'); assert.match(x.message, /could belong to 2 companies/); }); assert.deepEqual(amb.supported, ['PNFD', 'PNGP']);
  const none = await rejects(R.resolveCompany('nothing-like-any-company.org', d), (x) => { assert.equal(x.status, 404); assert.match(x.message, /no company name on EDGAR's company list matches the domain nothing-like-any-company\.org: not covered, not charged\.$/); }); void none;
  assert.equal(R.byDomain({ rows: [] }, 'ab').rows.length, 0, 'a name part of fewer than 3 letters matches nothing');
  // the tiers are ordered: the ticker tier beats the first-word tier
  const rows = [{ cik: '1', ticker: 'ZZZ', title: 'Acme Corp', norm: 'acme', words: ['acme'] }, { cik: '2', ticker: 'ACME', title: 'Other Inc', norm: 'other', words: ['other'] }, { cik: '3', ticker: 'AC3', title: 'Acme Widgets', norm: 'acme widgets', words: ['acme', 'widgets'] }];
  assert.deepEqual([R.byDomain({ rows }, 'acme').match, R.byDomain({ rows }, 'acme').rows.map((r) => r.cik)], ['the company name equals the domain name', ['1']]);
  assert.equal(R.byDomain({ rows: rows.slice(1) }, 'acme').match, 'the ticker equals the domain name');
  assert.equal(R.byDomain({ rows: rows.slice(2) }, 'acme').match, 'the first word of the company name equals the domain name');
  assert.equal(R.byDomain({ rows: rows.slice(2) }, 'acw').rows.length, 0, 'a label of fewer than 4 letters does not match a first word, one of fewer than 6 does not match a start');
  w.calls.length = 0;
  await rejects(R.resolveCompany('nothing-like-any-company.org', d), () => {});
  assert.deepEqual(w.calls.filter((u) => /submissions/.test(u)), [], 'no candidate, no submissions read');
});

test('the company list is held for 24 hours, an old copy is served when a refresh fails (up to 7 days), and a list that looks incomplete is refused', async () => {
  R._reset(); const { w } = mk();
  let now = W.NOW; const d = { fetch: w.fetch, now: () => now };
  await R.resolveCompany('ALDR', d); await R.resolveCompany('BRLG', d);
  assert.equal(w.calls.filter((u) => /company_tickers/.test(u)).length, 1, 'one read serves both');
  now += 25 * 3600e3; await R.resolveCompany('ALDR', d);
  assert.equal(w.calls.filter((u) => /company_tickers/.test(u)).length, 2, 'control: after 24 h it is read again');
  const failing = { fetch: async (u, o) => { if (/company_tickers/.test(u)) { throw Object.assign(new Error('EDGAR down. Not charged.'), { status: 503 }); } return w.fetch(u, o); }, now: () => now + 26 * 3600e3 };
  assert.equal((await R.resolveCompany('ALDR', failing)).ticker, 'ALDR', 'stale copy served');
  const veryLate = { ...failing, now: () => now + 9 * 24 * 3600e3 };
  await rejects(R.resolveCompany('ALDR', veryLate), (x) => assert.equal(x.status, 503));
  R._reset();
  const tiny = { fetch: async () => ({ status: 200, url: R.TICKERS_URL, contentType: 'application/json', body: Buffer.from(JSON.stringify({ 0: { cik_str: 1, ticker: 'A', title: 'A Inc' } })) }), now: () => now };
  await rejects(R.resolveCompany('A', tiny), (x) => { assert.equal(x.status, 503); assert.match(x.message, /Not charged\.$/); });
  R._reset();
});

test('the SEC company list is held as TEXT: a ticker is found by a text search with no row structure built (memory); a name or a domain builds the rows once; a list in another layout is parsed instead and gives the same answers', async () => {
  R._reset(); const { w, d } = mk();
  const list = await R.loadList(d);
  assert.equal(list.canonical, true); assert.equal(list._rows, null);
  assert.equal((await R.resolveCompany('brlg', d)).cik, '0001000002'); assert.equal((await R.resolveCompany('PNFD', d)).via, 'ticker');
  assert.equal(list._rows, null, 'two ticker queries built no rows');
  await R.resolveCompany('Briar Logistics', d); assert.ok(Array.isArray(list._rows) && list._rows.length > 200, 'a name query built them');
  // find() against the full parse, for every row of the list
  const whole = JSON.parse((await w.fetch(R.TICKERS_URL)).body.toString());
  const plain = R.parseList(Buffer.from(JSON.stringify(whole)));
  for (const v of Object.values(whole)) { const f = plain.find(v.ticker); assert.ok(f, v.ticker); assert.equal(Number(f.cik), v.cik_str); assert.equal(f.title, v.title); }
  assert.equal(plain.find('NOPE'), null); assert.equal(plain.find('A"B'), null); assert.equal(plain.find('ALD'), null, 'a prefix of a ticker is not the ticker'); assert.equal(plain.find('aldr'), null, 'tickers are upper case');
  // escapes in a title, and a second ticker of the same company
  const odd = { 0: { cik_str: 5, ticker: 'ODD', title: 'AT&T "Quoted" \\ Corp \u00e9' }, 1: { cik_str: 5, ticker: 'ODD-P', title: 'AT&T "Quoted" \\ Corp \u00e9' } };
  for (let i = 0; i < 150; i++) odd[10 + i] = { cik_str: 100 + i, ticker: `Q${i}`, title: `Pad ${i}` };
  const o = R.parseList(Buffer.from(JSON.stringify(odd))); assert.equal(o.canonical, true); assert.equal(o.find('ODD').title, 'AT&T "Quoted" \\ Corp \u00e9'); assert.equal(o.find('ODD-P').cik, '0000000005');
  // another layout (spaces and a different key order): parsed, same answers, and canonical is false
  const spaced = R.parseList(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(whole).map(([k, v]) => [k, { ticker: v.ticker, title: v.title, cik_str: v.cik_str }])), null, 1)));
  assert.equal(spaced.canonical, false); assert.equal(spaced.find('BRLG').cik, '0001000002'); assert.equal(spaced.rows.length, Object.keys(whole).length);
  R._reset();
});

// ---------------------------------------------------------------------------------------------------- EDGAR rows and pages
test('rowsOf keeps the wanted forms with a valid accession and date, drops a document name that is not a plain file name, parses items, and reports how far back the list reaches', () => {
  const cols = { accessionNumber: ['0000000001-26-000001', 'bad', '0000000001-26-000003', '0000000001-26-000004', '0000000001-26-000005'], filingDate: ['2026-05-01', '2026-04-01', '2026-03-01', 'not-a-date', '2024-12-31'],
    reportDate: ['2026-03-31', '', '', '', ''], form: ['10-Q', '10-K', '4', '8-K', '8-K'], items: ['', '', '', '1.01', '3.01,9.01'], primaryDocument: ['../../etc/passwd.htm', 'a.htm', 'f.xml', 'b.htm', 'c.htm'] };
  const { rows, oldest } = E.rowsOf(cols, '0000000001');
  assert.deepEqual(rows.map((r) => [r.form, r.filed, r.primary_document, r.items]), [['10-Q', '2026-05-01', null, []], ['8-K', '2024-12-31', 'c.htm', ['3.01', '9.01']]]);
  assert.equal(oldest, '2024-12-31', 'a Form 4 and an invalid row still count for how far back the list reaches (the Form 4 here is 2026-03-01; the oldest is the 8-K)');
  assert.deepEqual(E.rowsOf(null, 'x'), { rows: [], form4: [], oldest: null });
  for (const bad of ['../x.htm', 'a/b.htm', 'x.pdf', '.htm', 'a b.htm']) assert.ok(!E.DOCNAME.test(bad), bad);
  for (const ok of ['aapl-20250927.htm', 'f10k.html', 'doc_1.txt']) assert.ok(E.DOCNAME.test(ok), ok);
});

test('older pages: read newest first until the list reaches the cutoff, at most maxPages, a 404 page skipped; window_complete says whether the cutoff is reached', async () => {
  const { w, d } = mk();
  const sub = await E.fetchSubmissions('0001000007', d);
  assert.equal(sub.files.length, 1); assert.ok(sub.oldest_covered > '2025-07-01', 'recent reaches back only about 15 months');
  assert.equal(sub.rows.some((r) => r.items.includes('3.01')), false, 'the notice is not in the recent block');
  await E.loadOlder(sub, '2024-11-01', d);
  assert.equal(sub.rows.some((r) => r.items.includes('3.01')), true, 'it is in the older page');
  assert.equal(sub.window_complete, true); assert.equal(sub.pages_loaded, 1);
  const s2 = await E.fetchSubmissions('0001000007', d); await E.loadOlder(s2, '2024-11-01', d, { maxPages: 0 });
  assert.equal(s2.window_complete, false, 'control: no page read, the window is not complete');
  const hole = mk({ status: (u) => (/submissions-001/.test(u) ? 404 : null) });
  const s3 = await E.fetchSubmissions('0001000007', hole.d); await E.loadOlder(s3, '2024-11-01', hole.d);
  assert.equal(s3.pages_loaded, 1); assert.equal(s3.exhausted, true);
  w.calls.length = 0; const s4 = await E.fetchSubmissions('0001000001', d); await E.loadOlder(s4, '2024-11-01', d);
  assert.equal(w.calls.length, 1, 'a company whose recent block reaches the cutoff reads no older page');
  assert.equal(await E.fetchSubmissions('0009999999', d), null, 'a company EDGAR does not know is null');
  await rejects(E.fetchSubmissions('../x', d), (x) => assert.equal(x.status, 503));
});

test('the limiter lets a burst of `rate` through and then one per 1/rate seconds; a faster limiter is measurably faster (control)', async () => {
  const run = async (rate, n) => { const take = E.makeLimiter(rate); const t0 = Date.now(); for (let i = 0; i < n; i++) await take(); return Date.now() - t0; };
  const slow = await run(20, 40);                // 20 at once, then 20 more at 50 ms each: about 1 s
  assert.ok(slow >= 850 && slow < 2000, `${slow} ms`);
  const fast = await run(2000, 40); assert.ok(fast < 300, `${fast} ms`);
  assert.equal(E.RATE, 8, 'the production ceiling is 8 a second (the SEC allows 10)');
});

// ---------------------------------------------------------------------------------------------------- staleness
const day = (s) => Date.parse(`${s}T12:00:00Z`);
test('staleness: the latest overdue period decides; due dates by filer category plus the Rule 12b-25 extension; 52/53-week tolerance; new registrants; unknowns are null', () => {
  const rows = (...pairs) => pairs.map(([form, report_date]) => ({ form, report_date }));
  const LAF = 'Large accelerated filer'; const NON = 'Non-accelerated filer';
  // December year end, large accelerated: the Q3 10-Q (2026-09-30) is due 2026-11-14, so on 2026-11-01 the Q2 10-Q (due 2026-08-14) is the latest overdue period
  let r = S.staleness({ fiscalYearEnd: '1231', category: LAF, today: day('2026-11-01'), rows: rows(['10-K', '2025-12-31'], ['10-Q', '2026-03-31'], ['10-Q', '2026-06-30']) });
  assert.deepEqual([r.stale, r.expected_period_end, r.expected_form, r.due_date], [false, '2026-06-30', '10-Q', '2026-08-14']);
  r = S.staleness({ fiscalYearEnd: '1231', category: LAF, today: day('2026-11-01'), rows: rows(['10-K', '2025-12-31'], ['10-Q', '2026-03-31']) });
  assert.equal(r.stale, true, 'control: the Q2 report is missing'); assert.equal(r.latest_report_period, '2026-03-31');
  // the day after the due date flips it
  const mid = (today) => S.staleness({ fiscalYearEnd: '1231', category: LAF, today: day(today), rows: rows(['10-K', '2025-12-31'], ['10-Q', '2026-03-31'], ['10-Q', '2026-06-30']) });
  assert.equal(mid('2026-11-14').stale, false, 'Q3 is due 2026-11-14 and today is not after it'); assert.equal(mid('2026-11-15').stale, true, 'the day after, a missing Q3 is overdue');
  // a non-accelerated filer has 90 + 15 days for a 10-K: due 2026-04-15 for December
  assert.equal(S.staleness({ fiscalYearEnd: '1231', category: NON, today: day('2026-04-15'), rows: rows(['10-K', '2024-12-31'], ['10-Q', '2025-09-30']) }).stale, false);
  assert.equal(S.staleness({ fiscalYearEnd: '1231', category: NON, today: day('2026-04-16'), rows: rows(['10-K', '2024-12-31'], ['10-Q', '2025-09-30']) }).stale, true);
  assert.equal(S.staleness({ fiscalYearEnd: '1231', category: LAF, today: day('2026-03-17'), rows: rows(['10-K', '2024-12-31'], ['10-Q', '2025-09-30']) }).stale, true, 'a large filer: 60 + 15 days, due 2026-03-16');
  assert.equal(S.staleness({ fiscalYearEnd: '1231', category: LAF, today: day('2026-03-16'), rows: rows(['10-K', '2024-12-31'], ['10-Q', '2025-09-30']) }).stale, false);
  assert.equal(S.dueDays('10-K', 'Accelerated filer'), 75); assert.equal(S.dueDays('10-K', LAF), 60); assert.equal(S.dueDays('10-K', ''), 90); assert.equal(S.dueDays('10-Q', 'Accelerated filer'), 40); assert.equal(S.dueDays('10-Q', NON), 45);
  // a 52/53-week year: record says 0926, the period ended 2026-06-27; 7 days of tolerance
  assert.equal(S.staleness({ fiscalYearEnd: '0926', category: LAF, today: day('2026-10-20'), rows: rows(['10-K', '2025-09-27'], ['10-Q', '2026-03-28'], ['10-Q', '2026-06-27']) }).stale, false);
  assert.equal(S.staleness({ fiscalYearEnd: '0926', category: LAF, today: day('2026-10-20'), rows: rows(['10-K', '2025-09-27'], ['10-Q', '2026-03-28'], ['10-Q', '2026-06-17']) }).stale, true, 'control: ten days early is not the period');
  // a company that never reported before the period is not expected to have reported it
  assert.equal(S.staleness({ fiscalYearEnd: '1231', category: NON, today: day('2026-11-01'), rows: rows(['10-Q', '2026-09-30']) }).stale, false);
  // a quiet filer
  const quiet = S.staleness({ fiscalYearEnd: '0630', category: NON, today: day('2026-11-01'), rows: rows(['10-K', '2024-06-30'], ['10-Q', '2024-03-31']) });
  assert.deepEqual([quiet.stale, quiet.expected_period_end, quiet.expected_form], [true, '2026-06-30', '10-K']);
  // leap-day and month-end year ends
  assert.equal(S.staleness({ fiscalYearEnd: '0229', category: NON, today: day('2026-11-01'), rows: rows(['10-K', '2026-02-28'], ['10-Q', '2026-05-31'], ['10-Q', '2026-08-31']) }).stale, false);
  assert.deepEqual(S.periods('0229', NON, day('2026-11-01')).filter((p) => p.form === '10-K').map((p) => p.end).slice(-3), ['2025-02-28', '2026-02-28', '2027-02-28']);
  // unknowns
  assert.equal(S.staleness({ fiscalYearEnd: '1231', category: LAF, today: day('2026-11-01'), rows: [] }).stale, null);
  assert.equal(S.staleness({ fiscalYearEnd: null, category: LAF, today: day('2026-11-01'), rows: rows(['10-K', '2025-12-31']) }).stale, null);
  assert.equal(S.staleness({ fiscalYearEnd: '9999', category: LAF, today: day('2026-11-01'), rows: rows(['10-K', '2025-12-31']) }).stale, null);
  assert.equal(S.staleness({ fiscalYearEnd: '1231', category: LAF, today: day('2026-11-01'), rows: rows(['10-K/A', '2025-12-31']) }).stale, null, 'an amendment alone is not a periodic report');
});

// ---------------------------------------------------------------------------------------------------- verdict
test('verdict: every combination of the three flags gives the line an independent function derives from them; no judgment word, no prediction', () => {
  const expect = (gc, de, st) => {
    const a = [];
    if (gc === false && de === false) a.push('No going-concern language and no delisting notice found in the filings read');
    else {
      a.push(gc === true ? 'Going-concern language in the latest 10-K' : gc === false ? 'No going-concern language in the 10-K read' : 'Going-concern language could not be checked');
      a.push(de === true ? 'delisting notice 8-K (Item 3.01) on 2026-03-14' : de === false ? 'no delisting notice 8-K (Item 3.01) in the last 24 months' : 'Item 3.01 delisting notices could not be checked for the full 24 months');
    }
    a.push(st === true ? 'latest periodic report overdue (period ending 2026-06-30, due 2026-08-14)' : st === false ? 'filings current' : 'filing currency not determined');
    return `${a.join('; ')}.`;
  };
  const BANNED = /\b(safe|safer|buy|sell|hold|rug\w*|guarantee\w*|will (?:fail|default|collapse)|predict\w*|recommend\w*|avoid|invest\w*)\b/i;
  let n = 0;
  for (const gc of [true, false, null]) for (const de of [true, false, null]) for (const st of [true, false, null]) {
    const line = V.verdictLine({ going_concern: gc, gc_forms: gc ? ['10-K'] : [], gc_read: ['10-K'], alleviation: false, delisting: de, delisting_date: '2026-03-14', delisting_count: 1, stale: st, expected_period_end: '2026-06-30', due_date: '2026-08-14' });
    assert.equal(line, expect(gc, de, st), `${gc}/${de}/${st}`); assert.ok(!BANNED.test(line), line); n++;
  }
  assert.equal(n, 27);
  // control: the banned-word pattern matches known positives
  for (const w of ['this is safe', 'time to buy', 'sell now', 'a rug pull', 'guaranteed', 'we predict a default', 'hold']) assert.ok(BANNED.test(w), w);
  // the two lines the task gives
  assert.equal(V.verdictLine({ going_concern: true, gc_forms: ['10-K'], gc_read: ['10-K', '10-Q'], delisting: true, delisting_date: '2026-03-14', delisting_count: 1, stale: false }), 'Going-concern language in the latest 10-K; delisting notice 8-K (Item 3.01) on 2026-03-14; filings current.');
  assert.equal(V.verdictLine({ going_concern: false, gc_forms: [], gc_read: ['10-K', '10-Q'], delisting: false, stale: false }), 'No going-concern language and no delisting notice found in the filings read; filings current.');
  assert.match(V.verdictLine({ going_concern: true, gc_forms: ['10-K', '10-Q'], gc_read: ['10-K', '10-Q'], alleviation: true, delisting: true, delisting_date: '2026-03-14', delisting_count: 3, stale: false }), /10-K and 10-Q \(the document also says management's plans alleviate the doubt\); delisting notice 8-K \(Item 3.01\) on 2026-03-14 \(3 in the last 24 months\)/);
});

test('8-K item titles: Item 3.01 carries the form\'s own title, an unknown item keeps its number and has no title', () => {
  assert.deepEqual(I.itemObjects(['3.01', '9.99']), [{ item: '3.01', title: 'Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard; Transfer of Listing' }, { item: '9.99', title: null }]);
  assert.equal(Object.keys(I.ITEM_TITLES).length, 32, 'items 1.01 to 9.01 of Form 8-K');
});

// ---------------------------------------------------------------------------------------------------- the cache, the gate, the lane
test('the per-accession cache is bounded by entries and by bytes, expires after 24 hours, and never keeps one entry that is a large share of the budget', () => {
  const c = CC.makeCache({ maxEntries: 50, maxBytes: 20000, ttlMs: 1000 });
  for (let i = 0; i < 500; i++) c.set(`a${i}`, { quote: 'x'.repeat(40), n: i }, 0);
  assert.ok(c.size <= 50 && c.bytes <= 20000, `${c.size} entries, ${c.bytes} bytes`); assert.equal(c.get('a499', 10).n, 499); assert.equal(c.get('a0', 10), undefined, 'the oldest are gone');
  assert.equal(c.get('a499', 2000), undefined, 'expired'); c.set('big', { q: 'y'.repeat(6000) }, 0); assert.equal(c.get('big', 1), undefined, 'one entry over a quarter of the budget is not kept');
  const h = CC.makeCache({}); h.set('k', { a: 1 }, 0); assert.deepEqual(h.get('k', 24 * 3600e3 - 1), { a: 1 }); assert.equal(h.get('k', 24 * 3600e3 + 1), undefined);
});

test('the in-flight gate: two at once, the third waits and is refused with the 503 "Not charged" after the wait; a released slot lets a waiter in; releasing twice frees one slot', async () => {
  const g = CC.makeGate({ max: 2, waitMs: 80 });
  const a = await g.acquire(); const b = await g.acquire();
  const t0 = Date.now(); await rejects(g.acquire(), (x) => { assert.equal(x.status, 503); assert.equal(x.retryAfter, 5); assert.match(x.message, /busy\. Not charged\.$/); }); assert.ok(Date.now() - t0 >= 70);
  const waiter = g.acquire(); a(); const c = await waiter; assert.equal(g.stats().active, 2);
  b(); b(); assert.equal(g.stats().active, 1, 'a second release of the same slot changes nothing'); c();
  const loose = CC.makeGate({ max: 3, waitMs: 80 }); await loose.acquire(); await loose.acquire(); await loose.acquire();        // control: with a limit of 3 the third is not refused
});

test('the EDGAR lane runs one phase at a time in the order asked, survives a phase that throws, and refuses a phase that waits too long', async () => {
  const lane = CC.makeLane({ waitMs: 150 });
  let running = 0; let max = 0; const order = [];
  const phase = (name, ms, fail) => lane.run(async () => { running++; max = Math.max(max, running); order.push(`start ${name}`); await new Promise((r) => setTimeout(r, ms)); running--; order.push(`end ${name}`); if (fail) throw new Error('boom'); return name; });
  const rs = await Promise.allSettled([phase('a', 30), phase('b', 30, true), phase('c', 30)]);
  assert.equal(max, 1, 'never two phases at once'); assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  const slow = lane.run(() => new Promise((r) => setTimeout(r, 400)));
  await rejects(lane.run(async () => 'late'), (x) => { assert.equal(x.status, 503); assert.match(x.message, /Not charged\.$/); }); await slow;
  assert.equal(await lane.run(async () => 'after'), 'after', 'the lane works after a refusal');
  // control: without the lane two phases overlap
  running = 0; max = 0; const raw = (ms) => (async () => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, ms)); running--; })();
  await Promise.all([raw(20), raw(20)]); assert.equal(max, 2);
});

// ---------------------------------------------------------------------------------------------------- plain text and the public text
test('the plain-text scanner: a hard-wrapped plain-text filing becomes one line per paragraph, so a sentence cut at the margin is still one sentence, for any chunk size', () => {
  const H = require('../tools/r24/company-check/html-stream');
  const raw = Buffer.from('The Company has suffered recurring losses and these conditions raise substantial\ndoubt about the Company\'s ability to continue as a going\nconcern.\n\nNext paragraph.\n');
  for (const cs of [1, 3, 7, 64, 100000]) {
    const out = []; const sc = H.makePlainScanner((l) => out.push(l));
    for (let p = 0; p < raw.length; p += cs) sc.push(raw.subarray(p, p + cs));
    sc.end();
    assert.deepEqual(out, ['The Company has suffered recurring losses and these conditions raise substantial doubt about the Company\'s ability to continue as a going concern.', 'Next paragraph.'], `chunk ${cs}`);
  }
});

test('public text: description 180 to 255 characters starting "Use when an agent needs", a question, lower-case tags, a schema with q only, and none of the words the contract forbids', () => {
  const e = CC.entries[0];
  assert.equal(e.name, 'get_company_check'); assert.equal(e.route, 'GET /api/company-check'); assert.equal(e.usd, 0.25);
  assert.ok(e.desc.length >= 180 && e.desc.length <= 255, String(e.desc.length)); assert.match(e.desc, /^Use when an agent needs /); assert.match(e.desc, /503/); assert.match(e.desc, /404/); assert.match(e.desc, /not charged/i);
  assert.match(e.question, /\?$/); assert.ok(e.tags.every((t) => t === t.toLowerCase()) && e.tags.length >= 5);
  assert.deepEqual(Object.keys(e.schema), ['q', 'site']);
  const FORBID = /\b(rug\w*|guarantee\w*|buy|sell|hold|safe|since)\b/i;
  const text = [e.desc, e.question, e.title, e.tags.join(' '), CC.methodText(5 * 1048576), JSON.stringify(e.example), JSON.stringify(Object.values(e.schema).map((z) => z.description))].join('\n');
  assert.ok(!FORBID.test(text), (FORBID.exec(text) || [])[0]);
  for (const w of ['since 2020', 'a rugged pull', 'guaranteed', 'buy now', 'sell', 'hold', 'a safe harbor']) assert.ok(FORBID.test(w) || w === 'a rugged pull', w);       // control: the pattern matches its positives ("rugged" is not "rug")
  assert.ok(/^Example Holdings Corp$/.test(e.example.company.name), 'the example is constructed: an invented company, no real name');
  assert.match(CC.methodText(5 * 1048576), /last 24 months/); assert.match(CC.methodText(5 * 1048576), /last 90 days/); assert.match(CC.methodText(5 * 1048576), /within 400 characters/);
});

test('the constructed example is the output of the same assembler the live route uses, deterministic, and every EDGAR fact in it has a source on sec.gov', () => {
  const a = CC.buildExample(); const b = CC.buildExample();
  assert.deepEqual(a, b);
  const urls = [];
  const walk = (o, key) => { if (Array.isArray(o)) o.forEach((x) => walk(x, key)); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'website') continue; walk(v, k); } else if (typeof o === 'string' && /^(source|index_url|document_url|quote_url)$/.test(key)) urls.push(o); };
  walk(a, '');
  assert.ok(urls.length >= 10); for (const u of urls) assert.ok(E.isSecUrl(u), u);
  assert.ok(!E.isSecUrl('https://sec.gov.evil.example/x') && !E.isSecUrl('http://www.sec.gov/x') && E.isSecUrl('https://data.sec.gov/submissions/CIK0000000001.json'), 'control for the host check');
  assert.equal(a.verdict, 'No going-concern language and no delisting notice found in the filings read; filings current.');   // the example is a healthy filer with no site: it travels in every 402 challenge, which has a 12,000 byte ceiling
});

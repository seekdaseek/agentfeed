// test/r24-company-check.test.js: whole calls of company-check (R24 item 5) against a synthetic EDGAR (fixtures/r24/company-check/world.js) with the insider function and site-signals injected.
// What is proved here: the flags and the verdict for each kind of company, every refusal (400, 404, 503) and that none of them has fetched what it should not have, the 24-month window across
// EDGAR's older pages, the 5 MB read limit and its control, the cache by accession, the in-flight limit, the lane (the insider function never runs while a filing is being read), and that
// nothing in an answer is a raw document.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CC = require('../tools/r24/company-check');
const E = require('../tools/r24/company-check/edgar');
const R = require('../tools/r24/company-check/resolve');
const siteSignals = require('../tools/r23/site-signals');
const W = require('./fixtures/r24/company-check/world');

const INSIDER = { window_days: 90, filings_capped: false, form4_filings: 3, transactions: 4, open_market_buys_usd: 1000, open_market_sales_usd: 250, trades: [{ code: 'P', filed: '2026-10-01' }, { code: 'S', filed: '2026-10-02' }, { code: 'A', filed: '2026-10-03' }] };
const SITE = { host: 'www.indigo-ventures.com', url: 'https://www.indigo-ventures.com/', fetched_at: '2026-11-01T12:00:00.000Z', page: { ok: true, status: 200, final_url: 'https://www.indigo-ventures.com/', redirected: false },
  tls: { ok: true, protocol: 'TLSv1.3', issuer: { organization: 'Example CA' }, valid_to: '2027-01-01T00:00:00.000Z', days_left: 60, expired: false }, dns: { ok: true, counts: { a: 1, aaaa: 0, mx: 1, caa: 0 }, spf: { present: true }, dmarc: { present: true, policy: 'none' } }, headers: { ok: true, grade: 'C', score: 55, max: 100 } };
function setup(opt = {}) {
  R._reset();
  const world = W.makeWorld(opt.world);
  const log = [];
  const deps = {
    fetch: world.fetch, stream: world.stream, now: () => W.NOW, gate: CC.makeGate(), lane: CC.makeLane(), cache: CC.makeCache(),
    getInsiderTrades: async (a) => { log.push(['insider', a.ticker, a.days]); return typeof opt.insider === 'function' ? opt.insider(a) : INSIDER; },
    getSiteSignals: async (a) => { log.push(['site', a.url]); if (opt.site) return opt.site(a); return SITE; },
    ...opt.deps,
  };
  return { world, deps, log, run: (q) => CC.companyCheck({ q }, deps) };
}
const refused = async (p, check) => { try { await p; } catch (e) { check(e); return e; } assert.fail('expected a refusal'); };
const docCalls = (world) => world.calls.filter((u) => /\/Archives\/edgar\/data\//.test(u));
const NOT_CHARGED = /Not charged\.$|not covered, not charged\.$/;
const secUrls = (a) => { const out = []; const walk = (o, k, inWeb) => { if (Array.isArray(o)) o.forEach((x) => walk(x, k, inWeb)); else if (o && typeof o === 'object') for (const [kk, v] of Object.entries(o)) walk(v, kk, inWeb || kk === 'website'); else if (!inWeb && typeof o === 'string' && /^(source|index_url|document_url|quote_url)$/.test(k) && o) out.push(o); }; walk(a, '', false); return out; };

test('healthy company: no flag, the verdict says so, denials and the standard\'s wording are mentions that are not counted, a hidden header is never read, every fact has a source on sec.gov', async () => {
  const t = setup(); const a = await t.run('ALDR');
  assert.deepEqual(a.flags, { going_concern: false, delisting_notice_8k: false, stale: false });
  assert.equal(a.verdict, 'No going-concern language and no delisting notice found in the filings read; filings current.');
  assert.equal(a.latest_10k.going_concern.found, false); assert.equal(a.latest_10k.going_concern.mentions, 3); assert.equal(a.latest_10k.going_concern.non_asserting, 3); assert.equal(a.latest_10k.going_concern.quote, null);
  assert.equal(a.latest_10k.accession.length, 20); assert.equal(a.latest_10k.period, '2025-12-31'); assert.equal(a.latest_10q.period, '2026-09-30');
  assert.equal(a.going_concern.flag, false); assert.deepEqual(a.going_concern.read, ['10-K', '10-Q']); assert.equal(a.going_concern.quote, null);
  assert.equal(a.delisting_notice_8k.flag, false); assert.equal(a.delisting_notice_8k.window.complete, true); assert.equal(a.delisting_notice_8k.window.from, '2024-11-01');
  assert.equal(a.recent_8k.length, 3); assert.deepEqual(a.recent_8k[0].items, [{ item: '2.02', title: 'Results of Operations and Financial Condition' }, { item: '9.01', title: 'Financial Statements and Exhibits' }]);
  assert.equal(a.company.cik, '0001000001'); assert.equal(a.company.filer_category, 'Large accelerated filer');
  assert.equal(a.insider_form4.net_direction, 'net_purchases'); assert.equal(a.insider_form4.open_market_purchases.count, 1); assert.equal(a.insider_form4.window_days, 90);
  const urls = secUrls(a); assert.ok(urls.length >= 12); for (const u of urls) assert.ok(E.isSecUrl(u), u);
  assert.equal(a.website.ok, false); assert.match(a.website.reason, /EDGAR lists no website/);
  assert.ok(JSON.stringify(a).length < 14000, `${JSON.stringify(a).length} bytes: an answer holds quotes and facts, never a document`);
  assert.ok(!JSON.stringify(a).includes('hidden header'));
});

test('going concern in the 10-K and the 10-Q, three Item 3.01 filings (one an 8-K/A), a later 10-K/A: flags true, the first affirmative sentence is quoted with its URL, the verdict names both', async () => {
  const t = setup(); const a = await t.run('Briar Logistics');
  assert.deepEqual(a.flags, { going_concern: true, delisting_notice_8k: true, stale: false });
  assert.equal(a.verdict, 'Going-concern language in the latest 10-K and 10-Q; delisting notice 8-K (Item 3.01) on 2026-09-09 (3 in the last 24 months); filings current.');
  assert.equal(a.going_concern.quote, 'These conditions raise substantial doubt about the Company’s ability to continue as a going concern.'); assert.equal(a.going_concern.quote_url, a.latest_10k.document_url);
  assert.deepEqual(a.going_concern.found_in, ['10-K', '10-Q']); assert.equal(a.latest_10k.going_concern.affirmative, 2); assert.equal(a.latest_10k.going_concern.non_asserting, 1);
  assert.equal(a.delisting_notice_8k.count, 3); assert.equal(a.delisting_notice_8k.filings[0].filed, '2026-09-09'); assert.equal(a.delisting_notice_8k.filings[0].form, '8-K/A'); assert.match(a.delisting_notice_8k.source, /-index\.htm$/);
  assert.equal(a.latest_10k.later_amendments.length, 1); assert.equal(a.latest_10k.later_amendments[0].form, '10-K/A');
  assert.equal(a.latest_10k.document_url, t.world.urlOf('BRLG', 0));
});

test('going concern in the 10-K only: found_in names the form, the verdict says "latest 10-K", and a missing delisting notice is stated as such', async () => {
  const t = setup(); const a = await t.run('CBMN');
  assert.deepEqual(a.flags, { going_concern: true, delisting_notice_8k: false, stale: false }); assert.deepEqual(a.going_concern.found_in, ['10-K']);
  assert.equal(a.verdict, 'Going-concern language in the latest 10-K; no delisting notice 8-K (Item 3.01) in the last 24 months; filings current.');
});

test('a company that has stopped reporting is stale, and the verdict gives the period and the due date; a plain-text filing cut at the margin is still read as sentences', async () => {
  const t = setup(); const a = await t.run('DLTA');
  assert.equal(a.flags.stale, true); assert.equal(a.staleness.expected_period_end, '2026-06-30'); assert.equal(a.staleness.due_date, '2026-10-13');
  assert.match(a.verdict, /latest periodic report overdue \(period ending 2026-06-30, due 2026-10-13\)\.$/);
  assert.match(a.staleness.rule, /60, 75 or 90 days/); assert.match(a.staleness.source, /^https:\/\/data\.sec\.gov\/submissions\/CIK0001000004\.json$/);
  const tx = await setup().run('TXTC');
  assert.equal(tx.flags.going_concern, true); assert.match(tx.going_concern.quote, /^The Company has suffered recurring losses and these conditions raise substantial doubt about the Company's ability to continue as a going concern\.$/);
});

test('the 24-month window reaches into EDGAR\'s older pages: a notice 20 months ago is found only because the older page is read; with the page unreadable the flag is null with a reason, never false', async () => {
  const t = setup(); const a = await t.run('GRND');
  assert.equal(a.flags.delisting_notice_8k, true); assert.equal(a.delisting_notice_8k.window.complete, true); assert.ok(t.world.calls.some((u) => /submissions-001\.json$/.test(u)));
  assert.match(a.verdict, /delisting notice 8-K \(Item 3\.01\) on 20\d\d-\d\d-\d\d/);
  const t2 = setup({ world: { status: (u) => (/submissions-001/.test(u) ? 503 : null) } });
  await refused(t2.run('GRND'), (e) => { assert.equal(e.status, 503); assert.match(e.message, NOT_CHARGED); });                // an outage on the page is a refusal, not a false answer
  const t3 = setup({ world: { status: (u) => (/submissions-001/.test(u) ? 404 : null) } });
  const a3 = await t3.run('GRND');
  assert.equal(a3.flags.delisting_notice_8k, false, 'the page is gone and EDGAR lists no more pages: the list is as complete as it can be');
  assert.equal(a3.delisting_notice_8k.window.complete, true);
});

test('a busy filer (a bank with thousands of prospectus filings): the 24-month window is reached through 11 older pages of the filing list and the notice on the last page is found; a list that is longer than the page limit is null with a reason, never false', async () => {
  const t = setup(); const a = await t.run('BNKX');
  assert.equal(a.flags.delisting_notice_8k, true); assert.equal(a.delisting_notice_8k.window.complete, true); assert.equal(t.world.calls.filter((u) => /CIK0001000016-submissions-\d{3}\.json$/.test(u)).length, 11);
  const d = setup(); const b = await d.run('DEEP');
  assert.equal(b.flags.delisting_notice_8k, null, 'after 15 pages the list still does not reach back 24 months'); assert.equal(b.delisting_notice_8k.window.complete, false); assert.match(b.delisting_notice_8k.reason, /does not reach back/);
  assert.equal(d.world.calls.filter((u) => /CIK0001000017-submissions-\d{3}\.json$/.test(u)).length, CC.MAX_LIST_PAGES);
  assert.match(b.verdict, /could not be checked for the full 24 months/); assert.equal(CC.MAX_LIST_PAGES, 15);
});

test('a window the list does not reach is null with a reason (maxPages 0 is not injectable, so the shape is checked on the pure builder)', () => {
  const sub = { cik: '0000000001', rows: [], window_complete: false };
  const d = CC.delistingOf(sub, '2024-11-01', '2026-11-01');
  assert.equal(d.flag, null); assert.match(d.reason, /does not reach back/);
  assert.match(require('../tools/r24/company-check/verdict').verdictLine({ going_concern: false, gc_forms: [], gc_read: ['10-K'], delisting: null, stale: false }), /could not be checked for the full 24 months/);
});

test('refusals that cost nothing: a foreign filer and a company with no 10-K or 10-Q are 404 "not covered" and read no document; a filing over the read limit is a 404 only when it is over the limit (v2: 40 MB, and a smaller limit gives the control)', async () => {
  const t = setup();
  await refused(t.run('EXPT'), (e) => { assert.equal(e.status, 404); assert.equal(e.kind, 'bad_request'); assert.match(e.message, /Form 20-F or 40-F/); assert.match(e.message, NOT_CHARGED); });
  await refused(t.run('FNCH'), (e) => { assert.equal(e.status, 404); assert.match(e.message, /has no 10-K or 10-Q on EDGAR: not covered, not charged\.$/); });
  assert.deepEqual(docCalls(t.world).filter((u) => !/submissions|company_tickers/.test(u)), [], 'no filing document was fetched');
  // v2: a 6 MiB annual report is READ (the limit is 40 MB) ...
  const big = await setup().run('HUGE'); assert.equal(big.flags.going_concern, false); assert.equal(big.latest_10k.ok, true); assert.ok(big.latest_10k.chars_read > 5000);
  // ... and with the limit at 5 MiB the same company is a 404 that names the limit (the control: the 404 is the limit and nothing else)
  const t2 = setup({ deps: { maxDocBytes: 5 * 1024 * 1024 } });
  await refused(t2.run('HUGE'), (e) => { assert.equal(e.status, 404); assert.match(e.message, /over the 5 MB read limit/); assert.match(e.message, NOT_CHARGED); });
  // the limit handed to the reader is d.maxDocBytes, 40 MB (decimal) by default
  const seen = []; const t3 = setup(); const inner = t3.deps.stream; t3.deps.stream = async (u, o, cb) => { seen.push([u, o && o.maxBytes]); return inner(u, o, cb); }; await t3.run('ALDR');
  assert.ok(seen.filter(([u]) => /aldr-/.test(u)).every(([, m]) => m === 40000000)); assert.equal(seen.filter(([u]) => /aldr-/.test(u)).length, 2);
});

test('an unreadable 10-Q (too little text) does not fail the answer: its section says why, the flag stands on the 10-K, and the verdict says which form was read', async () => {
  const a = await setup().run('STUB');
  assert.equal(a.latest_10q.ok, false); assert.match(a.latest_10q.reason, /too little text/); assert.equal(a.latest_10q.going_concern, null);
  assert.deepEqual(a.going_concern.read, ['10-K']); assert.equal(a.flags.going_concern, false); assert.equal(a.verdict, 'No going-concern language and no delisting notice found in the filings read; filings current.');
});

test('bad input is a 400 before any request; ambiguity names the tickers; an unknown company is a 400 too (control: a valid call does fetch)', async () => {
  const t = setup();
  for (const q of ['', '   ', undefined, 'x'.repeat(300)]) await refused(CC.companyCheck({ q }, t.deps), (e) => { assert.equal(e.kind, 'bad_request'); assert.ok(!e.status); });
  assert.equal(t.world.calls.length, 0, 'nothing was fetched for a bad q');
  const e = await refused(t.run('Pioneer'), (x) => { assert.equal(x.kind, 'bad_request'); assert.match(x.message, /PNFD .*PNGP/); }); assert.deepEqual(e.supported, ['PNFD', 'PNGP']);
  await refused(t.run('Nonexistent Widgets Ltd'), (x) => assert.equal(x.kind, 'bad_request'));
  await t.run('ALDR'); assert.ok(t.world.calls.length > 0);
});

test('EDGAR trouble is the 503 "Not charged" in every place it can happen: the company list, the filing list, the 10-K, the 10-Q; a 403 or 429 (the SEC limiting us) too', async () => {
  const where = [['company list', /company_tickers/, 500], ['filing list', /submissions\/CIK/, 503], ['10-K', /aldr-20251231/, 502], ['10-Q', /aldr-20260930/, 503], ['a 429 on the 10-K', /aldr-20251231/, 429], ['a 403 on the list', /company_tickers/, 403]];
  for (const [what, re, status] of where) {
    const t = setup({ world: { status: (u) => (re.test(u) ? status : null) } });
    await refused(t.run('ALDR'), (e) => { assert.equal(e.status, 503, what); assert.match(e.message, /Not charged\.$/, what); assert.ok(e.retryAfter > 0, what); });
  }
  const unknown = setup({ world: { status: (u) => (/submissions\/CIK0001000001/.test(u) ? 404 : null) } });
  await refused(unknown.run('ALDR'), (e) => assert.equal(e.status, 503));            // listed on the SEC's company list but no filing list: not an answer
});

test('the insider function and the website are separate sections: either may fail and the answer stands; a website that the caller gave is read, a website EDGAR lists is read, and the registration data stays off', async () => {
  const noInsider = setup({ insider: () => { throw new Error('Form 4 service down. Not charged.'); } });
  const a = await noInsider.run('ALDR'); assert.equal(a.insider_form4.ok, false); assert.match(a.insider_form4.reason, /Form 4 service down/); assert.ok(!/Not charged/.test(a.insider_form4.reason)); assert.equal(a.flags.going_concern, false);
  const slow = setup({ insider: () => new Promise((r) => setTimeout(() => r(INSIDER), 150)), deps: { insiderWaitMs: 40 } });
  const s = await slow.run('ALDR'); assert.equal(s.insider_form4.ok, false); assert.match(s.insider_form4.reason, /did not arrive in time/);
  const t = setup({ site: () => { throw Object.assign(new Error('www.indigo-ventures.com does not resolve. Not charged.'), { status: 503 }); } });
  const f = await t.run('INDV'); assert.equal(f.website.ok, false); assert.match(f.website.reason, /does not resolve/); assert.equal(f.website.from, 'EDGAR record'); assert.equal(f.flags.going_concern, false);
  const ok = setup(); const g = await ok.run('INDV');
  assert.equal(g.website.ok, true); assert.equal(g.website.from, 'EDGAR record'); assert.deepEqual(ok.log.find((x) => x[0] === 'site'), ['site', 'https://www.indigo-ventures.com/']);
  assert.deepEqual([g.website.tls.protocol, g.website.tls.issuer, g.website.dns.spf, g.website.dns.dmarc, g.website.headers.grade], ['TLSv1.3', 'Example CA', true, 'none', 'C']);
  assert.match(g.website.note, /not a fact from EDGAR/);
  const viaSite = setup(); const h = await viaSite.run('https://indigo-ventures.com/about'); assert.equal(h.query.resolved_by, 'website'); assert.equal(h.website.from, 'the q parameter'); assert.deepEqual(viaSite.log.find((x) => x[0] === 'site'), ['site', 'https://indigo-ventures.com/']);
  assert.equal(secUrls(h).some((u) => /indigo/.test(u)), false, 'the website never appears among the EDGAR sources');
  // registration data: the instance the tool uses never has a `domain` section whatever the environment says; the default instance of site-signals does when the environment says "on" (control)
  assert.equal(siteSignals.create({ R23_SITESIGNALS_RDAP: 'on' }).rdapEnabled, true); assert.equal(CC._siteOff.rdapEnabled, false);
  assert.equal(CC._siteOff.entries[0].desc.includes('domain age'), false);
});

test('v2 website input: the optional site parameter chooses the site that is read (and the answer states it); a website given as q that EDGAR does not map is matched by its domain to the company name and the answer says how; a bad site is a 400 before any request', async () => {
  const run = (t, q, site) => CC.companyCheck({ q, ...(site === undefined ? {} : { site }) }, t.deps);
  // site= on a ticker: that site is read, even where EDGAR lists another
  const t = setup(); const a = await run(t, 'ALDR', 'https://www.Alder-Instruments.example.org/investors?x=1');
  assert.deepEqual(t.log.filter((x) => x[0] === 'site'), [['site', 'https://www.alder-instruments.example.org/']]);
  assert.deepEqual([a.website.ok, a.website.from, a.website.host], [true, 'the site parameter', 'www.alder-instruments.example.org']);
  const e = setup(); const b = await run(e, 'INDV', 'other-site.com');
  assert.deepEqual(e.log.filter((x) => x[0] === 'site'), [['site', 'https://other-site.com/']]); assert.equal(b.website.from, 'the site parameter', 'the site parameter beats the website EDGAR lists'); assert.equal(b.website.host, 'other-site.com');
  // no site anywhere: the section says so and why
  const n = setup(); const c = await run(n, 'ALDR'); assert.equal(c.website.ok, false); assert.match(c.website.reason, /no site was given \(q is not a website and there is no site parameter\) and EDGAR lists no website/); assert.equal(c.website.host, null);
  assert.deepEqual(n.log.filter((x) => x[0] === 'site'), []);
  // a website as q, not mapped by EDGAR: matched by the domain to the name; the site read is that site
  const d = setup(); const w = await run(d, 'https://www.alder-instruments.com/about');
  assert.deepEqual([w.query.resolved_by, w.query.match, w.company.ticker], ['domain-name', 'the company name equals the domain name', 'ALDR']);
  assert.deepEqual([w.website.from, w.website.host], ['the q parameter', 'www.alder-instruments.com']); assert.deepEqual(d.log.filter((x) => x[0] === 'site'), [['site', 'https://www.alder-instruments.com/']]);
  const m = await run(setup(), 'indigo-ventures.com'); assert.deepEqual([m.query.resolved_by, m.query.match], ['website', 'EDGAR lists this website for the company']);
  const both = setup(); const x = await run(both, 'alder-instruments.com', 'status.alder-instruments.com'); assert.equal(x.website.host, 'status.alder-instruments.com', 'with both, the site parameter is the one read'); assert.equal(x.website.from, 'the site parameter');
  // refusals: ambiguity is a 400 with the tickers, no match is a 404, both before any document is read
  const r = setup();
  const amb = await refused(run(r, 'pioneer.com'), (z) => { assert.equal(z.kind, 'bad_request'); assert.match(z.message, /could belong to 2 companies \(PNFD .*PNGP/); }); assert.deepEqual(amb.supported, ['PNFD', 'PNGP']);
  await refused(run(r, 'no-such-name-here.com'), (z) => { assert.equal(z.status, 404); assert.match(z.message, /not covered, not charged\.$/); });
  assert.deepEqual(docCalls(r.world).filter((u) => !/submissions|company_tickers/.test(u)), [], 'no document was read for either');
  // a bad site never reaches EDGAR
  const bad = setup();
  for (const site of ['127.0.0.1', 'http://example.com', 'localhost', 'user:pw@example.com', 'a b', ['x.com', 'y.com'], 'x'.repeat(2100), 'https://[::1]/']) {
    await refused(run(bad, 'ALDR', site), (z) => { assert.equal(z.kind, 'bad_request', JSON.stringify(site).slice(0, 30)); assert.ok(!z.status); });
  }
  assert.equal(bad.world.calls.length, 0, 'nothing was fetched for a bad site');
  assert.equal(CC.parseSiteParam('  '), null); assert.equal(CC.parseSiteParam(undefined), null);   // control: an empty site is no site, not an error
  assert.equal((await run(setup(), 'ALDR', 'www.example.com')).website.host, 'www.example.com', 'control: a plain host name is a site');
});

test('the website summary is built from the real shape of a site-signals answer (its own constructed example), and a private host or an unresolvable one is a section with a reason', async () => {
  const ex = CC._siteOff.buildExample();
  const t = setup({ site: () => ex });
  const a = await t.run('INDV');
  assert.equal(a.website.ok, true); assert.equal(a.website.host, 'www.indigo-ventures.com', 'the host asked for, not the one the answer names');
  assert.deepEqual([a.website.tls.protocol, a.website.tls.issuer, a.website.tls.days_left, a.website.tls.expired], ['TLSv1.3', 'Example Trust Services', ex.tls.days_left, false]);
  assert.deepEqual([a.website.dns.a, a.website.dns.aaaa, a.website.dns.mx, a.website.dns.spf, a.website.dns.dmarc, a.website.dns.caa], [2, 1, 1, true, 'quarantine', 1]);
  assert.deepEqual([a.website.headers.grade, a.website.headers.score, a.website.headers.max], [ex.headers.grade, ex.headers.score, ex.headers.max]);
  assert.equal('domain' in a.website, false, 'no registration data in the summary');
  const priv = await CC.runSite('127.0.0.1', 'the q parameter', { getSiteSignals: CC._siteOff.getSiteSignals });
  assert.equal(priv.ok, false); assert.match(priv.reason, /private, loopback and reserved/);
});

test('the lane: while a company\'s filings are being read nothing else reads EDGAR, and the insider function runs alone; two calls at once never overlap an insider run with a filing read', async () => {
  const events = []; let busyReads = 0; let insiderRunning = 0; let overlap = 0;
  const t = setup({ world: { delay: (u) => (/Archives|submissions|company_tickers/.test(u) ? 15 : 0), onCall: () => { events.push('read'); } },
    insider: async () => { insiderRunning++; if (busyReads > 0) overlap++; events.push('insider-start'); await new Promise((r) => setTimeout(r, 60)); events.push('insider-end'); insiderRunning--; return INSIDER; } });
  const inner = t.deps.fetch;
  t.deps.fetch = async (u, o) => { busyReads++; if (insiderRunning > 0) overlap++; try { return await inner(u, o); } finally { busyReads--; } };
  const innerS = t.deps.stream; t.deps.stream = async (u, o, cb) => { busyReads++; if (insiderRunning > 0) overlap++; try { return await innerS(u, o, cb); } finally { busyReads--; } };
  const rs = await Promise.all([t.run('ALDR'), t.run('BRLG')]);
  assert.equal(rs.length, 2); assert.equal(overlap, 0, 'no overlap');
  // control: with no lane the same two calls do overlap (the instrumentation can see it)
  const free = { run: (fn) => fn() };
  events.length = 0; busyReads = 0; insiderRunning = 0; overlap = 0;
  const t2 = setup({ world: { delay: (u) => (/Archives|submissions/.test(u) ? 15 : 0) }, deps: { lane: free }, insider: async () => { insiderRunning++; if (busyReads > 0) overlap++; await new Promise((r) => setTimeout(r, 60)); insiderRunning--; return INSIDER; } });
  const inner2 = t2.deps.fetch; t2.deps.fetch = async (u, o) => { busyReads++; if (insiderRunning > 0) overlap++; try { return await inner2(u, o); } finally { busyReads--; } };
  const inner2s = t2.deps.stream; t2.deps.stream = async (u, o, cb) => { busyReads++; if (insiderRunning > 0) overlap++; try { return await inner2s(u, o, cb); } finally { busyReads--; } };
  await Promise.all([t2.run('ALDR'), t2.run('BRLG')]); assert.ok(overlap > 0, 'control: without the lane they overlap');
});

test('in flight: two calls at once; a third that cannot get a slot within the wait is a 503 "Not charged" before it fetches anything; with room for three it is answered (control)', async () => {
  const slowWorld = { delay: (u) => (/submissions\/CIK/.test(u) ? 120 : 0) };
  const t = setup({ world: slowWorld, deps: { gate: CC.makeGate({ max: 2, waitMs: 40 }), lane: { run: (fn) => fn() } } });
  const first = [t.run('ALDR'), t.run('BRLG')];
  await new Promise((r) => setTimeout(r, 5));
  const callsBefore = t.world.calls.length;
  const e = await refused(t.run('CBMN'), (x) => { assert.equal(x.status, 503); assert.equal(x.retryAfter, 5); assert.match(x.message, /company-check is busy\. Not charged\.$/); });
  assert.equal(t.world.calls.length, callsBefore, 'the refused call fetched nothing'); void e;
  await Promise.all(first);
  const t2 = setup({ world: slowWorld, deps: { gate: CC.makeGate({ max: 3, waitMs: 40 }), lane: { run: (fn) => fn() } } });
  const all = await Promise.all([t2.run('ALDR'), t2.run('BRLG'), t2.run('CBMN')]); assert.equal(all.length, 3);
  assert.equal(t.deps.gate.stats().active, 0, 'every slot is released');
  const failing = setup({ world: { status: (u) => (/aldr-20251231/.test(u) ? 503 : null) } }); await refused(failing.run('ALDR'), () => {}); assert.equal(failing.deps.gate.stats().active, 0, 'a refused call releases its slot');
});

test('the cache by accession: a second call reads the filing list again but no document; after 24 hours the documents are read again; a different accession is a different entry', async () => {
  const t = setup();
  await t.run('BRLG'); const docs1 = t.world.calls.filter((u) => /brlg-2025|brlg-2026/.test(u)).length; assert.equal(docs1, 2);
  const a2 = await t.run('BRLG'); assert.equal(t.world.calls.filter((u) => /brlg-2025|brlg-2026/.test(u)).length, 2, 'no document read the second time');
  assert.equal(a2.latest_10k.cached, true); assert.equal(a2.latest_10q.cached, true); assert.equal(a2.flags.going_concern, true, 'a cached answer carries the same flag');
  assert.ok(t.world.calls.filter((u) => /submissions\/CIK0001000002/.test(u)).length >= 2, 'the filing list is always fresh');
  let now = W.NOW + 25 * 3600e3; const t2 = { ...t.deps, now: () => now };
  await CC.companyCheck({ q: 'BRLG' }, t2); assert.equal(t.world.calls.filter((u) => /brlg-2025|brlg-2026/.test(u)).length, 4, 'after 24 h the documents are read again');
  assert.ok(t.deps.cache.size <= 400 && t.deps.cache.bytes <= 512 * 1024);
});

test('determinism: the same company and the same data give the same answer; the flags and the verdict agree for every company the world has (an independent restatement of the verdict from the flags)', async () => {
  const t = setup(); const first = await t.run('BRLG'); const second = await t.run('BRLG');
  assert.deepEqual({ ...first, latest_10k: { ...first.latest_10k, cached: 0 }, latest_10q: { ...first.latest_10q, cached: 0 } }, { ...second, latest_10k: { ...second.latest_10k, cached: 0 }, latest_10q: { ...second.latest_10q, cached: 0 } });
  for (const q of ['ALDR', 'BRLG', 'CBMN', 'DLTA', 'GRND', 'STUB', 'INDV', 'TXTC']) {
    const a = await t.run(q);
    assert.equal(/^Going-concern language in/.test(a.verdict), a.flags.going_concern === true, q);
    assert.equal(/delisting notice 8-K \(Item 3\.01\) on \d{4}-\d{2}-\d{2}/.test(a.verdict), a.flags.delisting_notice_8k === true, q);
    assert.equal(/overdue/.test(a.verdict), a.flags.stale === true, q);
    assert.equal(/filings current/.test(a.verdict), a.flags.stale === false, q);
    assert.ok(!/\b(safe|buy|sell|hold)\b/i.test(a.verdict), q);
    for (const u of secUrls(a)) assert.ok(E.isSecUrl(u), `${q}: ${u}`);
  }
});

test('the route entry runs the real code path with its defaults except the network: the entry\'s run() validates its input before any request', async () => {
  const run = CC.entries[0].run;
  await refused(run({}), (e) => assert.equal(e.kind, 'bad_request'));
  await refused(run({ q: ['a', 'b'] }), (e) => assert.equal(e.kind, 'bad_request'));
  await refused(run(undefined), (e) => assert.equal(e.kind, 'bad_request'));
});

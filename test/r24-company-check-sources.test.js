// test/r24-company-check-sources.test.js: every source URL of a company-check answer is a STATIC EDGAR object (GATES-r24-5-v3.md rule 1): a filing document or index under
// https://www.sec.gov/Archives/edgar/data/<cik>/<accession without dashes>/, https://data.sec.gov/submissions/CIK<ten digits>.json (or an older page of it) or https://data.sec.gov/api/xbrl/...;
// never a browse-edgar page, a cgi-bin page, a search, or any URL with a query string or a fragment (in the v2 gate a cited browse-edgar listing answered HTTP 503 twice).
// The scan reads EVERY answer the synthetic EDGAR can give (all its companies, all kinds of failure inside an answer) and every string that is a URL outside the `website` section (which is a live
// read of the company's own site, not an EDGAR fact). CONTROLS: the scanner is shown to flag a planted browse-edgar URL, a cgi-bin URL, a query string, a fragment, http, a look-alike host and a
// short accession folder; and ops/r24-company-check-mutation-sources.js breaks the URL builders on purpose (R24_CC_INDEX / R24_CC_EDGAR point at the copies) and requires this file to fail.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const CC = require(process.env.R24_CC_INDEX || path.join(__dirname, '..', 'tools', 'r24', 'company-check'));
const E = require(process.env.R24_CC_EDGAR || path.join(__dirname, '..', 'tools', 'r24', 'company-check', 'edgar'));
const R = require('../tools/r24/company-check/resolve');
const W = require('./fixtures/r24/company-check/world');

const URL_KEYS = /^(source|index_url|document_url|quote_url)$/;
/** every URL-valued string of an answer outside `website`: under a url key, or a string that is a whole URL (a quoted sentence is not, and `quote` fields are skipped) */
function urlsIn(answer) {
  const out = [];
  const walk = (o, key, trail) => {
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, key, `${trail}[${i}]`));
    else if (o && typeof o === 'object') { for (const [k, v] of Object.entries(o)) { if (k === 'website' || k === 'quote') continue; walk(v, k, `${trail}.${k}`); } }
    else if (typeof o === 'string' && o && (URL_KEYS.test(key) || /^https?:\/\/\S+$/i.test(o))) out.push({ at: trail, url: o });
  };
  walk(answer, '', '');
  return out;
}
const forbidden = (answer) => urlsIn(answer).filter((u) => !E.isStaticSource(u.url));
const SECTIONS = ['company', 'going_concern', 'latest_10k', 'latest_10q', 'delisting_notice_8k', 'staleness', 'insider_form4'];

function setup(opt = {}) {
  R._reset();
  const world = W.makeWorld(opt);
  return { world, deps: { fetch: world.fetch, stream: world.stream, now: () => W.NOW, gate: CC.makeGate(), lane: CC.makeLane(), cache: CC.makeCache(), form4Cache: CC.makeCache(), getSiteSignals: async () => ({ host: 'x', page: { ok: true }, tls: { ok: true }, dns: { ok: true }, headers: { ok: true } }) } };
}

test('control: the static-source check accepts the shapes of the rule and refuses everything else', () => {
  const ok = ['https://www.sec.gov/Archives/edgar/data/1000001/000000000126000001/aldr-20251231.htm', 'https://www.sec.gov/Archives/edgar/data/1/000000000126000002/0000000001-26-000002-index.htm',
    'https://data.sec.gov/submissions/CIK0001000001.json', 'https://data.sec.gov/submissions/CIK0000019617-submissions-004.json', 'https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/Assets.json'];
  for (const u of ok) assert.equal(E.isStaticSource(u), true, u);
  const bad = ['https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001287098&type=10-K&dateb=&owner=include&count=40', 'https://www.sec.gov/cgi-bin/browse-edgar', 'https://www.sec.gov/cgi-bin/srch-edgar?text=x',
    'https://www.sec.gov/Archives/edgar/data/1000001/000000000126000001/aldr-20251231.htm?x=1', 'https://www.sec.gov/Archives/edgar/data/1000001/000000000126000001/aldr-20251231.htm#p5', 'http://www.sec.gov/Archives/edgar/data/1000001/000000000126000001/x.htm',
    'https://www.sec.gov/Archives/edgar/data/1000001/x.htm', 'https://www.sec.gov/Archives/edgar/data/1000001/', 'https://www.sec.gov/Archives/edgar/data/abc/000000000126000001/x.htm', 'https://www.sec.gov.evil.example/Archives/edgar/data/1/000000000126000001/x.htm',
    'https://user:pw@www.sec.gov/Archives/edgar/data/1/000000000126000001/x.htm', 'https://www.sec.gov:8443/Archives/edgar/data/1/000000000126000001/x.htm', 'https://data.sec.gov/submissions/CIK1.json', 'https://data.sec.gov/submissions/CIK0001000001.json?x=1',
    'https://data.sec.gov/other/CIK0001000001.json', 'https://efts.sec.gov/LATEST/search-index?q=x', 'https://www.sec.gov/cgi-bin/own-disp?action=getissuer&CIK=0000320193', 'https://www.sec.gov/files/company_tickers.json', 'https://www.sec.gov/', 'not a url', ''];
  for (const u of bad) assert.equal(E.isStaticSource(u), false, u);
});

test('the scan: every answer of the synthetic EDGAR (all its companies) carries static sources only, every section has one, and the answers are not trivial', async () => {
  const tickers = ['ALDR', 'BRLG', 'CBMN', 'DLTA', 'GRND', 'STUB', 'INDV', 'TXTC', 'HUGE', 'BNKX', 'FRM4', 'PNFD', 'PNGP', 'DEEP'];
  let answers = 0; let urls = 0;
  for (const t of tickers) {
    const s = setup(); const a = await CC.companyCheck({ q: t }, s.deps); answers++;
    const all = urlsIn(a); urls += all.length;
    assert.ok(all.length >= 8, `${t}: ${all.length} source URLs`);
    assert.deepEqual(forbidden(a), [], t);
    for (const sec of SECTIONS) assert.ok(a[sec] && typeof a[sec].source === 'string' && E.isStaticSource(a[sec].source), `${t}: ${sec} has a static source`);
    for (const r of a.recent_8k) assert.ok(E.isStaticSource(r.source), t);
  }
  assert.equal(answers, tickers.length); assert.ok(urls > 150, `${urls} source URLs scanned`);
  // FRM4 has no 10-Q, DLTA's list is short: the sections that carry no filing still cite the static filing list
  const f = await CC.companyCheck({ q: 'FRM4' }, setup().deps); assert.equal(f.latest_10q.ok, false); assert.match(f.latest_10q.source, /^https:\/\/data\.sec\.gov\/submissions\/CIK0001000015\.json$/);
  const g = await CC.companyCheck({ q: 'ALDR' }, setup().deps); assert.match(g.company.source, /^https:\/\/data\.sec\.gov\/submissions\/CIK0001000001\.json$/); assert.match(g.delisting_notice_8k.source, /^https:\/\/data\.sec\.gov\/submissions\/CIK0001000001\.json$/); assert.match(g.insider_form4.source, /^https:\/\/data\.sec\.gov\/submissions\/CIK0001000001\.json$/);
  const b = await CC.companyCheck({ q: 'BRLG' }, setup().deps); assert.match(b.delisting_notice_8k.source, /-index\.htm$/, 'with a notice the source is the filing\'s own index');
  // a failure inside an answer (insider outage, site failure, an unreadable 10-Q) still cites only static objects
  const down = setup({ status: (u) => (/wk-form4/.test(u) ? 503 : null) }); const d = await CC.companyCheck({ q: 'ALDR' }, down.deps); assert.equal(d.insider_form4.ok, false); assert.deepEqual(forbidden(d), []); assert.match(d.insider_form4.source, /^https:\/\/data\.sec\.gov\/submissions\//);
  const stub = await CC.companyCheck({ q: 'STUB' }, setup().deps); assert.equal(stub.latest_10q.ok, false); assert.deepEqual(forbidden(stub), []);
  // the constructed example (the Bazaar entry) too
  assert.deepEqual(forbidden(CC.buildExample()), []);
  assert.ok(urlsIn(CC.buildExample()).length >= 12);
});

test('PLANTED POSITIVE CONTROL: the scanner finds a browse-edgar listing, a cgi-bin page, a query string, a fragment, http and a look-alike host when they are put into a real answer', async () => {
  const base = await CC.companyCheck({ q: 'ALDR' }, setup().deps);
  assert.deepEqual(forbidden(base), [], 'the clean answer has none');
  const plant = (mutate) => { const a = JSON.parse(JSON.stringify(base)); mutate(a); return forbidden(a); };
  assert.equal(plant((a) => { a.company.source = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001000001&type=10-K&dateb=&owner=include&count=40'; }).length, 1);
  assert.equal(plant((a) => { a.insider_form4.source = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001000001&type=4'; }).length, 1);
  assert.equal(plant((a) => { a.delisting_notice_8k.source = 'https://www.sec.gov/cgi-bin/srch-edgar?text=form-type%3D8-K'; }).length, 1);
  assert.equal(plant((a) => { a.latest_10k.document_url += '?download=1'; }).length, 1);
  assert.equal(plant((a) => { a.recent_8k[0].index_url += '#top'; }).length, 1);
  assert.equal(plant((a) => { a.going_concern.quote_url = 'http://www.sec.gov/Archives/edgar/data/1000001/000000000126000001/x.htm'; a.going_concern.quote = 'a sentence'; }).length, 1, 'http');
  assert.equal(plant((a) => { a.staleness.source = 'https://data.sec.gov.evil.example/submissions/CIK0001000001.json'; }).length, 1);
  assert.equal(plant((a) => { a.recent_8k.push({ filed: 'x', note: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent' }); }).length, 1, 'a URL under any key, not only the usual ones');
  assert.equal(plant((a) => { a.website = { source: 'https://www.sec.gov/cgi-bin/browse-edgar' }; }).length, 0, 'the website section is the company\'s own site, outside the scan');
  assert.equal(plant((a) => { a.latest_10k.going_concern.quote = 'see https://www.sec.gov/cgi-bin/browse-edgar for more'; }).length, 0, 'a quoted sentence is not a source');
});

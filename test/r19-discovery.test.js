// R19 (21 Oct 2026): the queued discovery gaps.
//   1. /openapi.json: three free routes carried the generated placeholder ("Free. fear greed."), which tells an agent nothing about what it gets.
//   2. /llms.txt and SKILL.md: 23 of the 83 data routes sat under "Other", a heading that says nothing; each one now has its real section.
//   3. ops/discovery-check.mjs: the robots.txt check asserted OUR Cache-Control header, which Cloudflare overrides (max-age=14400 on that path);
//      what matters is that the edge asked the origin (cf-cache-status REVALIDATED) and the body carries an ETag.
'use strict';
require('./helpers/box-dbs-scratch');   // R35: a dev machine has no /opt/overhang/overhang.db (tools/overhang.js opens it at require time)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const D = require('../tools/discovery');
const { PRICES, TAGS, BAZAAR_META } = require('../payments');
const H = require('./helpers/real-server');

const FREE_TOOLS = ['get_fear_greed', 'get_last_liquidation', 'get_exit_method', 'get_forecast_record'];
const ctx = { PRICES, TAGS, META: BAZAAR_META, FREE_TOOLS, mpp: { active: false, routes: [] }, tempo: { active: false }, network: 'mainnet' };

test('/openapi.json: no free route keeps the generated "Free. <name>." placeholder; the three that had it say what the caller gets', () => {
  const api = D.buildOpenApi(ctx);
  const free = Object.entries(api.paths).filter(([p, o]) => p.startsWith('/api/') && o.get && Array.isArray(o.get.security) && o.get.security.length === 0);
  assert.ok(free.length >= 5, `control: the free routes are found (${free.length})`);
  const placeholder = /^Free\. [A-Za-z0-9 ]{1,40}\.$/;
  assert.ok(placeholder.test('Free. fear greed.') && placeholder.test('Free. exit method.'), 'control: the placeholder shape is what the pattern matches');
  const bad = free.filter(([, o]) => placeholder.test(o.get.description) || o.get.description.length < 60).map(([p]) => p);
  assert.deepEqual(bad, [], 'free routes still carrying a placeholder or a one-liner');
  const d = (tool) => api.paths[D.freePath(tool)].get.description;
  assert.match(d('get_fear_greed'), /0-100/);
  assert.match(d('get_exit_method'), /sell-direction quotes/);
  assert.match(d('get_exit_method'), /\/api\/exit-quote/, 'it names the paid route it explains');
  assert.match(d('get_forecast_record'), /before its 15-minute window/);
  assert.match(d('get_forecast_record'), /Brier skill/);
  for (const t of ['get_fear_greed', 'get_exit_method', 'get_forecast_record']) {
    assert.ok(d(t).length <= 600, `${t}: ${d(t).length} chars`);
    assert.doesNotMatch(d(t), /\b(since|from) (the )?\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i, `${t}: no start date`);
  }
});

test('llms.txt, SKILL.md and grouped(): every data route has a real section, none is filed under "Other"', () => {
  const { data } = D.splitPaid(PRICES);
  const g = D.grouped({ PRICES: Object.fromEntries(data), TAGS });
  const titles = g.map(([t]) => t);
  assert.ok(data.length >= 80, `control: the whole route table is grouped (${data.length})`);
  assert.equal(g.reduce((n, [, rs]) => n + rs.length, 0), data.length, 'control: grouping loses no route');
  assert.ok(titles.includes('Derivatives') && titles.includes('Solana on-chain'), 'control: the existing sections are still there');
  assert.ok(!titles.includes('Other'), `routes under "Other": ${(g.find(([t]) => t === 'Other') || [, []])[1].map((r) => r.path).join(', ')}`);
  const where = (path_) => (g.find(([, rs]) => rs.some((r) => r.path === path_)) || [])[0];
  assert.equal(where('/api/sec-filings'), 'SEC filings and insider trades');
  assert.equal(where('/api/insider-trades'), 'SEC filings and insider trades');
  assert.equal(where('/api/sanctions-check/:address'), 'Compliance and verification');
  assert.equal(where('/api/injection-check'), 'Compliance and verification');
  assert.equal(where('/api/papers'), 'Research and reference');
  assert.equal(where('/api/wiki'), 'Research and reference');
  assert.equal(where('/api/web-markdown'), 'Web, document and audio extraction');
  assert.equal(where('/api/transcribe'), 'Web, document and audio extraction');
  assert.equal(where('/api/translate'), 'Text and language');
  assert.equal(where('/api/hash'), 'Utilities');
  assert.equal(where('/api/time'), 'Utilities');
  assert.equal(where('/api/tradfi-perps'), 'Derivatives');
  for (const [name, text] of [['llms.txt', D.buildLlmsTxt(ctx)], ['SKILL.md', D.buildSkillMd(ctx)]]) {
    assert.doesNotMatch(text, /^#{2,3} Other\b/m, `${name}: no "Other" heading`);
    assert.match(text, /^#{2,3} SEC filings and insider trades/m, `${name}: the new sections are rendered`);
  }
});

test('discovery-check: robots.txt is judged on a fresh body (the edge asked the origin, plus an ETag), not on the Cache-Control Cloudflare overrides', async () => {
  const { robotsVerdict } = await import(pathToFileURL(path.join(__dirname, '..', 'ops', 'fresh-verdict.mjs')).href);
  const good = { status: 200, cacheControl: 'max-age=14400', etag: 'W/"1bb-x"', cfCacheStatus: 'REVALIDATED', conditionalStatus: 304 };
  // through Cloudflare (what live returned on 21 Oct: max-age=14400, REVALIDATED, a 304 to the conditional GET)
  assert.equal(robotsVerdict(good).ok, true, 'the live shape passes');
  assert.equal(robotsVerdict({ ...good, cfCacheStatus: 'DYNAMIC' }).ok, true);
  assert.equal(robotsVerdict({ ...good, cfCacheStatus: 'BYPASS' }).ok, true);
  // a copy served from the edge without asking the origin can be a pre-change body for hours: that is the failure this check exists to catch
  for (const bad of ['HIT', 'MISS', 'STALE', 'UPDATING']) assert.equal(robotsVerdict({ ...good, cfCacheStatus: bad }).ok, false, `cf-cache-status ${bad}`);
  assert.equal(robotsVerdict({ ...good, etag: null }).ok, false, 'no ETag');
  assert.equal(robotsVerdict({ ...good, status: 500 }).ok, false, 'not a 200');
  assert.equal(robotsVerdict({ ...good, conditionalStatus: 200 }).ok, false, 'a conditional GET with the ETag must be a 304');
  assert.equal(robotsVerdict({ ...good, conditionalStatus: null }).ok, false, 'the conditional GET was not sent');
  // straight to the origin (a local stage): there is no edge, so the origin\'s own no-cache is the freshness statement
  const origin = { status: 200, cacheControl: 'no-cache', etag: 'W/"1bb-x"', cfCacheStatus: null, conditionalStatus: 304 };
  assert.equal(robotsVerdict(origin).ok, true, 'origin direct: no-cache + ETag + 304');
  assert.equal(robotsVerdict({ ...origin, cacheControl: 'public, max-age=14400' }).ok, false, 'origin direct with a long max-age is stale-prone');
  // a reason is always given, so a FAIL line is readable
  assert.match(robotsVerdict({ ...good, cfCacheStatus: 'HIT' }).why, /HIT/);
});

test('discovery-check: ops/discovery-check.mjs judges /robots.txt on a fresh body, not on our Cache-Control header (end to end against the real server.js)', async (t) => {
  const s = await H.boot();
  t.after(() => s.close());
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [require('path').join(__dirname, '..', 'ops', 'discovery-check.mjs'), `http://127.0.0.1:${s.port}`], { encoding: 'utf8', timeout: 120000 });
  const lines = String(r.stdout).split('\n');
  assert.ok(lines.length > 40, `control: the check ran (${lines.length} lines)`);
  assert.ok(lines.some((l) => l.startsWith('OK   /openapi.json: 200, Cache-Control no-cache')), 'control: the unchanged no-cache rule still runs on the other documents');
  assert.ok(lines.some((l) => /^OK   \/robots\.txt: a fresh body \(cf-cache-status none, origin direct, ETag present, conditional GET 304\)/.test(l)), lines.filter((l) => /robots/.test(l)).join(' | '));
  assert.ok(!lines.some((l) => /^FAIL \/robots\.txt/.test(l)));
  assert.ok(!lines.some((l) => l.startsWith('OK   /robots.txt: 200, Cache-Control no-cache')), 'the old header line is gone');
});

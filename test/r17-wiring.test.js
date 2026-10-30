// R17 (19 Oct 2026): the wiring that needs the real price table (expansion.js opens the box databases on require), so, like r15-wiring.test.js, these
// skip with a reason on a machine without them: which skills name an exchange (item 8), the paper route's slash example on every surface (item 9),
// the route count, and where server.js mounts the new pieces.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HAVE_BOX = fs.existsSync('/opt/agentfeed/liquidations.db') && fs.existsSync('/opt/overhang/overhang.db');
const skip = HAVE_BOX ? false : 'needs the box databases (/opt/agentfeed/liquidations.db, /opt/overhang/overhang.db)';
const VENUE = /bybit|okx|binance/i;

test('item 8: the skills that name an exchange are exactly the five whose output names one; the four whose output names none do not; liq-feed names none', { skip }, () => {
  const { PRICES, TAGS } = require('../payments');
  const named = Object.values(PRICES).filter((p) => VENUE.test(`${p.desc} ${(TAGS[p.tool] || []).join(' ')}`)).map((p) => p.tool).sort();
  // venue names in the route's own captured output (checked against /api/sample on 19 Oct 2026): liquidations (exchange per print), liquidation-leaders
  // (exchanges[]), liquidation-stats (by_exchange), liq-history (source), venue-liq-share (venues[]). No venue in: cascade, cascade-scan,
  // cascade-forecast, liq-heatmap.
  assert.deepEqual(named, ['get_liq_history', 'get_liquidation_leaders', 'get_liquidation_stats', 'get_recent_liquidations', 'get_venue_liq_share']);
  for (const route of ['GET /api/cascade', 'GET /api/cascade-scan', 'GET /api/cascade-forecast', 'GET /api/liq-heatmap', 'GET /api/liq-feed']) {
    const p = PRICES[route]; assert.ok(p, route);
    assert.ok(!VENUE.test(`${p.desc} ${(TAGS[p.tool] || []).join(' ')} ${p.challengeNote || ''} ${p.docNote || ''}`), `${route} names no exchange`);
  }
  assert.ok(!/1\.4M|799 symbols/.test(PRICES['GET /api/cascade-forecast'].desc), 'the stale tape figures went with the venue name');
  assert.match(PRICES['GET /api/cascade-forecast'].desc, /FORWARD-LOOKING/, 'the rest of the forecast text is untouched');
});

test('item 8: the agent card carries the fixed text (skills are built from the price table)', { skip }, () => {
  const { PRICES, TAGS } = require('../payments');
  const card = compat().makeAgentCard({ PRICES, TAGS, TITLES: require('../tools/titles').TOOL_TITLES, questionFor: require('../tools/questions').questionFor, version: '1', ORIGIN: 'https://x402.ochinimus.app', railNames: () => 'x', mpp: { active: false, routes: [] }, tempo: { active: false } });
  let body; card({}, { json(b) { body = b; } });
  assert.equal(body.skills.length, Object.keys(PRICES).length);
  const withVenue = body.skills.filter((s) => VENUE.test(`${s.description} ${s.tags.join(' ')}`)).map((s) => s.id).sort();
  assert.deepEqual(withVenue, ['get_liq_history', 'get_liquidation_leaders', 'get_liquidation_stats', 'get_recent_liquidations', 'get_venue_liq_share']);
  assert.ok(!VENUE.test(body.description));
});
const compat = () => require('../lib/compat');

test('item 9: the paper example VALUE is the DOI as written, the published URL is the one-segment form R20f chose, the retired instruction is gone from every surface, route key and price unchanged', { skip }, () => {
  const { PRICES, TAGS, BAZAAR_META } = require('../payments');
  const D = require('../tools/discovery');
  const key = 'GET /api/paper/:doi';
  assert.ok(PRICES[key], 'same route key');
  assert.equal(Object.keys(PRICES).length, 91 + 3 + 2, 'the route count is unchanged by the paper change (91 routes at R20e, plus the three pensio briefs and the two signals-pass purchase routes; the news brief is off)');
  assert.equal(PRICES[key].usd, 0.005, 'same price');
  assert.ok(PRICES[key].desc.length >= 180 && PRICES[key].desc.length <= 255, `${PRICES[key].desc.length} chars`);
  assert.ok(PRICES[key].desc.includes('/api/paper/10.1038/nature14539') && !/%2F/i.test(PRICES[key].desc));
  assert.equal(BAZAAR_META[key].pathParams.doi, '10.1038/nature14539');
  assert.ok(/as written/.test(BAZAAR_META[key].pathParamsSchema.properties.doi.description));
  const ctx = { PRICES, TAGS, META: BAZAAR_META, FREE_TOOLS: ['get_fear_greed'], mpp: { active: false, routes: [] }, tempo: { active: false }, network: 'mainnet' };
  const api = D.buildOpenApi(ctx);
  assert.deepEqual(api.paths['/api/paper/{doi}'].get['x-example-path'], { doi: '10.1038/nature14539' });
  // R17 retired an INSTRUCTION ("send the slash as %2F"). R20f then chose, on purpose, to PUBLISH the URL in one segment (lib/route-urls.js: the form CDP's
  // validate accepts), so every surface that prints a caller's URL prints this one, and the guard's documented 400 quotes it. That URL is no longer "old text".
  const RETIRED = /Send the slash of the DOI|slash sent as %2F/i;
  const ONE_SEGMENT = '/api/paper/10.1038%2Fnature14539';
  assert.ok(!RETIRED.test(JSON.stringify(api.paths['/api/paper/{doi}'])), 'openapi: the retired %2F instruction is gone');
  assert.ok(JSON.stringify(api.paths['/api/paper/{doi}'].get.responses).includes(ONE_SEGMENT), 'openapi: the documented 400 quotes the one-segment URL');
  const entry = D.buildWellKnown(ctx).resourceCatalog.find((r) => r.url.endsWith(ONE_SEGMENT));
  assert.ok(entry, '/.well-known/x402 resourceCatalog lists the route by its one-segment URL');
  assert.deepEqual(entry.path_params_example, { doi: '10.1038/nature14539' }, '/.well-known/x402 resourceCatalog');
  for (const [name, text] of [['llms.txt', D.buildLlmsTxt(ctx)], ['SKILL.md', D.buildSkillMd(ctx)]]) {
    assert.ok(!RETIRED.test(text), `${name}: the retired %2F instruction is gone`);
    assert.ok(text.includes(`GET ${ONE_SEGMENT}`), `${name} prints the one-segment URL R20f publishes`);
  }
  const { MCP_DEFS_ADD } = require('../expansion');
  const def = MCP_DEFS_ADD.find((d) => d.name === 'get_paper');
  assert.ok(def.desc.includes('/api/paper/10.1038/nature14539'));
  assert.match(def.schema.doi.description, /10\.1038\/nature14539, sent in the path as written/);
});

test('item 9: the paper example is a path-shaped URL x402-list accepts (letters, digits and / _ . - ~ only)', { skip }, () => {
  const { BAZAAR_META } = require('../payments');
  const url = `/api/paper/${BAZAAR_META['GET /api/paper/:doi'].pathParams.doi}`;
  assert.match(url, /^[A-Za-z0-9/_.\-~]+$/, url);
});

test('server.js mounts the new pieces in order: slash path right after the network-suffix strip and before the limiter; agent-ready after the aliases; the / negotiation before the HTML root', { skip }, () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = (s) => { const i = src.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at('app.use(compat.stripNetworkSuffix);') < at("app.use(require('./lib/slash-path').slashPathCanonical());"));
  assert.ok(at("app.use(require('./lib/slash-path').slashPathCanonical());") < at('app.use(rateLimiter.middleware);'));
  assert.ok(at('mountDiscoveryAliases(app') < at('mountAgentReady(app'));
  assert.ok(at("app.get('/', require('./lib/agent-ready').rootNegotiation(") < at("app.get('/', (req, res, next) => {"));
  assert.ok(at("app.get('/.well-known/ai-catalog.json', compat.makeAiCatalog("), 'the ai-catalog route is still mounted');
});

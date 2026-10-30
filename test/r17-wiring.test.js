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

test('item 9: the paper route shows the slash form as its example on every surface, the route key and the route count are unchanged', { skip }, () => {
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
  const OLD_INSTRUCTION = /Send the slash of the DOI|slash sent as %2F|10\.1038%2F/i;   // the %2F form still works and is mentioned once, as the alternative
  // The documented 400 (error-responses.json, regenerated in pensio round 2) quotes the guard's own example URL, which R20f publishes as ONE segment on purpose
  // (lib/route-urls.js: 10.1038%2Fnature14539, the form CDP's validate accepts). That URL is the guard's, not the instruction this check retired, so the
  // responses are tested for exactly that form below and the rest of the operation must still be free of the old text.
  const { responses: paperResponses, ...paperOp } = api.paths['/api/paper/{doi}'].get;
  assert.ok(!OLD_INSTRUCTION.test(JSON.stringify({ ...api.paths['/api/paper/{doi}'], get: paperOp })), 'openapi: the old %2F instruction and example are gone');
  assert.ok(JSON.stringify(paperResponses).includes('/api/paper/10.1038%2Fnature14539'), 'the documented 400 carries the one-segment example R20f publishes');
  const entry = D.buildWellKnown(ctx).resourceCatalog.find((r) => /\/api\/paper\/\{doi\}$/.test(r.url));
  assert.deepEqual(entry.path_params_example, { doi: '10.1038/nature14539' }, '/.well-known/x402 resourceCatalog');
  for (const [name, text] of [['llms.txt', D.buildLlmsTxt(ctx)], ['SKILL.md', D.buildSkillMd(ctx)]]) assert.ok(!OLD_INSTRUCTION.test(text), `${name}: the old %2F instruction is gone`);
  assert.ok(D.buildLlmsTxt(ctx).includes('/api/paper/10.1038/nature14539'), 'llms.txt carries the slash example');
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

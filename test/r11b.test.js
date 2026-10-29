// test/r11b.test.js — R11b: the landing page's head and tag line, the service-level descriptions, the top-up header input (14 Oct 2026).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HAVE_BOX = fs.existsSync('/opt/agentfeed/liquidations.db') && fs.existsSync('/opt/overhang/overhang.db');
const skip = HAVE_BOX ? false : 'needs the box databases (payments.js opens them through expansion.js)';
const { SCOPE, SCOPE_SHORT } = require('../tools/scope');
const { httpRailNames } = require('../lib/rails');
const { hfSentence } = require('../lib/hf');
const L = require('../tools/landing');
const attr = (html, sel) => { const m = html.match(new RegExp(`<meta (?:name|property)="${sel}" content="([^"]*)">`)); return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"') : null; };

// a stand-in table for machines without the box: two data routes and one key pack
const FAKE = { 'GET /api/a': { usd: 0.01, tool: 'get_a', desc: 'a' }, 'GET /api/b/:x': { usd: 0.005, tool: 'get_b', desc: 'b' }, 'GET /api/keys/buy-1': { usd: 1, tool: 'buy_key_1', desc: 'k' } };

function checkLanding(PRICES) {
  const html = L.renderLanding(PRICES, 'mainnet', { perp_markets_7d: 883 });
  const head = L.landingHead(PRICES);
  assert.ok(!/Solana or Base\b/.test(html), 'no "Solana or Base" anywhere on the page');
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1].replace(/&amp;/g, '&');
  assert.ok(title.startsWith('AgentFeed') && title.includes('x402'), `title: ${title}`);
  const meta = attr(html, 'description');
  assert.ok(meta && meta.length <= 300, `meta description ${meta && meta.length} characters`);
  assert.ok(meta.includes('No API key is needed to pay per call.'), 'the R9 sentence stays');
  // the HTTP rails, Algorand included where it is on: by name in the meta while they fit, else counted there (R10 Phase A) and named
  // in full in the page footer
  const { httpRails } = require('../lib/rails');
  assert.ok(meta.includes(httpRailNames()) || (meta.includes(`${httpRails().length} networks (Solana`) && html.includes(`USDC settlement on ${httpRailNames()}`)), 'the HTTP rails, Algorand included where it is on');
  for (const word of ['sanctions', 'Solana pre-trade', 'OCR', 'translate']) assert.ok(meta.includes(word), `meta names ${word}`);
  assert.equal(attr(html, 'og:description'), meta, 'og:description is the meta description');
  assert.equal(attr(html, 'og:title'), title);
  assert.equal(attr(html, 'og:url'), 'https://x402.ochinimus.app/');
  assert.equal(attr(html, 'og:type'), 'website');
  assert.equal(attr(html, 'og:image'), 'https://x402.ochinimus.app/icon.png');
  assert.equal(attr(html, 'twitter:card'), 'summary');
  assert.equal(attr(html, 'twitter:image'), 'https://x402.ochinimus.app/icon.png');
  const want = Object.keys(PRICES).filter((r) => !/^GET \/api\/keys\//.test(r)).length;
  assert.equal(head.dataRoutes, want, 'data routes = priced routes minus key packs');
  assert.ok(html.includes(`${want} paid data routes`), 'the page shows the derived count');
  const tag = html.match(/<p class="tag">([\s\S]*?)<\/p>/)[1];
  assert.ok(tag.includes(hfSentence().trim() || 'No accounts'), 'the high-frequency sentence (derived) sits in the tag line');
  assert.ok(tag.includes(httpRailNames()), 'tag line rails from httpRailNames()');
  const foot = html.match(/<div class="foot">([\s\S]*?)<\/div>/)[1];
  assert.ok(foot.includes(`USDC settlement on ${httpRailNames()}`), 'footer rails from httpRailNames()');
  return { html, tag };
}

test('landing: head, og and twitter tags, rails and counts, on a stand-in price table', () => { checkLanding(FAKE); });

test('landing: the same on the real price table, and the half-price line is there on the box', { skip }, () => {
  const { PRICES } = require('../payments');
  // the tier needs PAY_TO_EVM (from .env, which a test run does not load) and the two key files the box has; a stand-in address
  // switches it on here the way .env does for the server
  const before = process.env.PAY_TO_EVM;
  process.env.PAY_TO_EVM = before || '0x' + '22'.repeat(20);
  try {
    assert.match(hfSentence(), /High-frequency callers pay half/, 'with PAY_TO_EVM set the box has the tier');
    const { tag } = checkLanding(PRICES);
    assert.ok(tag.includes(hfSentence().trim()), 'the tag line carries the derived half-price sentence');
  } finally { if (before === undefined) delete process.env.PAY_TO_EVM; else process.env.PAY_TO_EVM = before; }
  assert.ok(L.landingHead(PRICES).dataRoutes >= 82);
});

test('service texts: every service-level description opens with the scope sentence that names sanctions and the language tasks', () => {
  for (const word of ['sanctions', 'language tasks', 'OCR', 'translate', 'summarize', 'extract', 'classify', 'transcribe', 'Solana pre-trade', 'papers']) assert.ok(SCOPE.includes(word), `SCOPE names ${word}`);
  assert.ok(!/:/.test(SCOPE_SHORT), 'no colon in the short form (it sits in SKILL.md front matter)');
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const server = src('server.js');
  // GET / and /.well-known/x402.json are built inline in server.js
  assert.ok(/service: 'agentfeed',\n  description: `\$\{require\('\.\/tools\/scope'\)\.SCOPE\} Paid per-call/.test(server), 'GET / opens with SCOPE');
  assert.ok(/x402Version: 2,\n  service: 'agentfeed',\n  description: `\$\{require\('\.\/tools\/scope'\)\.SCOPE\} Pay per call/.test(server), '/.well-known/x402.json opens with SCOPE');
  for (const gone of ['Live crypto market data for AI agents - liquidations', 'Crypto market, liquidations, and Solana on-chain data for AI agents']) assert.ok(!server.includes(gone), `server.js lost: ${gone}`);
  const mcp = src('mcp.js');
  assert.ok(mcp.includes("description: `${require('./tools/scope').SCOPE} Paid per call"), 'MCP server description');
  assert.ok(mcp.includes("`AgentFeed serves ${require('./tools/scope').SCOPE.charAt(0).toLowerCase()}"), 'MCP instructions');
  const card = src('lib/compat.js');
  assert.ok(card.includes("description: `${require('../tools/scope').SCOPE} Each skill"), 'agent card');
  const D = require('../tools/discovery');
  const ctx = { PRICES: FAKE, TAGS: {}, META: {}, FREE_TOOLS: ['get_fear_greed'], mpp: { active: false, routes: [] }, tempo: { active: false }, network: 'mainnet' };
  assert.ok(D.buildOpenApi(ctx).info.description.startsWith(SCOPE), 'openapi info');
  assert.equal(D.buildLlmsTxt(ctx).split('\n')[2], SCOPE, 'llms.txt opening line');
  assert.ok(D.buildSkillMd(ctx).includes(`description: ${SCOPE_SHORT.replace(/\.$/, '')}, paid per call in USDC over x402, no API key.`), 'SKILL.md front matter');
  assert.ok(src('README.md').split('\n')[5].startsWith('**' + SCOPE), 'README tagline');
});

test('openapi: the two top-up routes declare their key header; no other route gains a parameter', () => {
  const D = require('../tools/discovery');
  const P = { ...FAKE, 'GET /api/keys/topup-5': { usd: 5, tool: 'topup_key_5', desc: 't' }, 'GET /api/keys/topup-20': { usd: 20, tool: 'topup_key_20', desc: 't' } };
  const api = D.buildOpenApi({ PRICES: P, TAGS: {}, META: {}, FREE_TOOLS: [], mpp: { active: false, routes: [] }, tempo: { active: false }, network: 'mainnet' });
  for (const r of ['/api/keys/topup-5', '/api/keys/topup-20']) {
    const ps = api.paths[r].get.parameters || [];
    assert.deepEqual(ps.map((x) => [x.in, x.name, x.required]), [['header', 'X-AgentFeed-Key', true]], r);
  }
  assert.equal(api.paths['/api/a'].get.parameters, undefined, 'an input-less route stays input-less (no invented parameter)');
  assert.deepEqual((api.paths['/api/keys/buy-1'].get.parameters || []).map((x) => x.name), [], 'buy routes unchanged here (their key_hash comes from META)');
});

test('openapi on the real table: exactly the 16 input-less data routes (13, plus the three pensio briefs) are left without parameters', { skip }, () => {
  const { PRICES, TAGS, BAZAAR_META } = require('../payments');
  const D = require('../tools/discovery');
  const api = D.buildOpenApi({ PRICES, TAGS, META: BAZAAR_META, FREE_TOOLS: ['get_fear_greed'], mpp: { active: false, routes: [] }, tempo: { active: false }, network: 'mainnet' });
  const bare = Object.entries(api.paths).filter(([, o]) => o.get && o.get['x-payment-info'] && !(o.get.parameters || []).length && !o.get.requestBody).map(([p]) => p).sort();
  assert.deepEqual(bare, ['/api/anomaly-flag', '/api/base-gas', '/api/btc-price', '/api/eth-price', '/api/funding-pulse', '/api/jito-tips', '/api/liq-pulse', '/api/liquidation-stats', '/api/market-snapshot', '/api/morning-brief', '/api/move-alert', '/api/positioning', '/api/priority-fees', '/api/sol-network', '/api/sol-price', '/api/trade-context']);
});

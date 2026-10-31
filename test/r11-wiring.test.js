// test/r11-wiring.test.js — R11: the twenty new routes wired in (14 Oct 2026).
//
// The tools are tested on their own (r11.test.js, r11-sol.test.js, r11-llm.test.js, r11-region.test.js). This file pins the
// WIRING: the launch prices, every amount derived from them (exact rails and v1 and MPP tempo at the list price, batch-settlement
// and Gateway and key debits at half, never below $0.0005), the challenge text, the MCP list, the Bazaar entries and where the
// region gate sits in server.js. Like r9-wiring.test.js it needs the box's data files (expansion.js opens the liquidation, peg and
// overhang databases on require), so the table tests skip with a reason on a machine without them.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HAVE_BOX = fs.existsSync('/opt/agentfeed/liquidations.db') && fs.existsSync('/opt/overhang/overhang.db');
const skip = HAVE_BOX ? false : 'needs the box databases (/opt/agentfeed/liquidations.db, /opt/overhang/overhang.db)';

// the go file's launch prices (AF-R11-go-20261014.md, step 4)
const R11 = {
  'GET /api/sanctions-check/:address': [0.008, 'get_sanctions_check'], 'GET /api/papers': [0.015, 'get_papers'],
  'GET /api/sol-token-check/:mint': [0.025, 'get_sol_token_check'], 'GET /api/sol-token-flow/:mint': [0.008, 'get_sol_token_flow'],
  'GET /api/sol-holder-clusters/:mint': [0.008, 'get_sol_holder_clusters'],
  'GET /api/email-verify': [0.005, 'get_email_verify'], 'GET /api/domain/:domain': [0.005, 'get_domain'], 'GET /api/paper/:doi': [0.005, 'get_paper'],
  'GET /api/wiki': [0.005, 'get_wiki'], 'GET /api/qr': [0.005, 'get_qr'], 'GET /api/hash': [0.005, 'get_hash'], 'GET /api/time': [0.005, 'get_time'],
  'GET /api/convert': [0.005, 'get_convert'],
  'GET /api/ocr': [0.04, 'get_ocr'], 'GET /api/summarize': [0.02, 'get_summarize'], 'GET /api/extract': [0.025, 'get_extract'],
  'GET /api/translate': [0.04, 'get_translate'], 'GET /api/classify': [0.005, 'get_classify'], 'GET /api/injection-check': [0.004, 'get_injection_check'],
  'GET /api/transcribe': [0.02, 'get_transcribe'],
};
const PHASE_B = ['GET /api/ocr', 'GET /api/summarize', 'GET /api/extract', 'GET /api/translate', 'GET /api/classify', 'GET /api/injection-check', 'GET /api/transcribe', 'GET /api/claim-check'];
// the derived price, worked out by hand for each list price (half, minimum $0.0005)
const HALF = { 0.004: 0.002, 0.005: 0.0025, 0.008: 0.004, 0.015: 0.0075, 0.02: 0.01, 0.025: 0.0125, 0.04: 0.02 };

test('price table: the twenty routes at the launch prices, none of them noHf, each with tags', { skip }, () => {
  const { PRICES, TAGS } = require('../payments');
  for (const [route, [usd, tool]] of Object.entries(R11)) {
    assert.ok(PRICES[route], route);
    assert.equal(PRICES[route].usd, usd, route);
    assert.equal(PRICES[route].tool, tool, route);
    assert.ok(!PRICES[route].noHf, `${route} keeps the high-frequency tier`);
    assert.ok(Array.isArray(TAGS[tool]) && TAGS[tool].length >= 4, `${route} has its own tags`);
  }
  assert.equal(Object.keys(R11).length, 20);
});

test('derived amounts: every exact rail at the list price, batch-settlement and Gateway at half, the hand-worked halves', { skip }, () => {
  const { PRICES, routeAccepts } = require('../payments');
  const { hfAccepts, hfUsd } = require('../lib/hf');
  const HF = { batch: { networks: ['eip155:8453', 'eip155:137'], receiver: '0x' + '22'.repeat(20) }, gateway: { networks: ['eip155:8453', 'eip155:5042'], payTo: '0x' + 'a8'.repeat(20) } };
  const EVM = [{ network: 'eip155:8453', name: 'Base' }, { network: 'eip155:137', name: 'Polygon' }, { network: 'eip155:42161', name: 'Arbitrum' }, { network: 'eip155:5042', name: 'Arc', asset: { address: '0x3600000000000000000000000000000000000000', decimals: 6 } }];
  const { railPrice } = require('../lib/rails');
  const ctx = { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payTo: 'TREASURYsol', EVM, ALGO: { network: 'algorand:mainnet', payTo: 'ALGOPAYTO' }, HF,
    railPrice, railPayTo: () => '0x' + '22'.repeat(20), hfAccepts };
  for (const [route, [usd]] of Object.entries(R11)) {
    const acc = routeAccepts(PRICES[route], ctx);
    assert.equal(acc.length, 10, `${route}: 6 exact + 2 batch-settlement + 2 Gateway in this fixture (the live 402 has 13: three more batch/Gateway networks)`);
    const exact = acc.filter((a) => a.scheme === 'exact' && !(a.extra && a.extra.name === 'GatewayWalletBatched'));
    const hf = acc.filter((a) => !exact.includes(a));
    assert.equal(exact.length, 6, `${route}: Solana, Base, Polygon, Arbitrum, Arc and Algorand exact`);
    for (const a of exact) {
      if (typeof a.price === 'string') assert.equal(a.price, `$${usd}`, `${route} ${a.network}`);
      else assert.equal(a.price.amount, String(Math.round(usd * 1e6)), `${route} ${a.network} (atomic units)`);
    }
    assert.equal(hf.length, 4, `${route}: 2 batch-settlement + 2 Gateway`);
    assert.equal(hfUsd(usd), HALF[usd], `${route}: half of ${usd}`);
    for (const a of hf) assert.equal(a.price, `$${HALF[usd]}`, `${route} ${a.scheme} ${a.network} at half`);
    assert.equal(acc.filter((a) => a.network === 'eip155:5042').length, 2, `${route}: two accepts on Arc (exact + Gateway)`);
  }
  assert.equal(hfUsd(0.0004), 0.0005, 'the floor: never below $0.0005');
});

test('derived amounts: MPP tempo charges the list price, a key debit is half, x402 v1 reads the same table', { skip }, () => {
  const { PRICES } = require('../payments');
  const tempo = require('../mpp/tempo');
  const { hfUsd } = require('../lib/hf');
  for (const [route, [usd]] of Object.entries(R11)) {
    assert.equal(tempo._usdToUnits(PRICES[route].usd), String(Math.round(usd * 1e6)), `${route}: tempo at the list price`);
    assert.equal(hfUsd(PRICES[route].usd), HALF[usd], `${route}: a key pays half`);
  }
  // x402 v1 has no table of its own: its body is built from the route's own v2 challenge (the accepts above), bound to the layer
  const v1src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402v1.js'), 'utf8');
  assert.ok(v1src.includes('built\n//      from the very challenge in its PAYMENT-REQUIRED header'), 'x402 v1 copies the v2 challenge');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').includes('x402v1.bind(layer)'), 'x402 v1 is bound to the same payment layer');
});

test('challenge: each new route opens with its title, keeps its question, fits 400 characters', { skip }, () => {
  const { PRICES, challengeLead, challengeDesc, CHALLENGE_DESC_MAX } = require('../payments');
  const { TOOL_TITLES } = require('../tools/titles');
  const { QUESTIONS } = require('../tools/questions');
  for (const route of Object.keys(R11)) {
    const p = PRICES[route];
    assert.ok(TOOL_TITLES[p.tool], `${p.tool} has a title`);
    assert.ok(QUESTIONS[p.tool], `${p.tool} has a question`);
    const d = challengeDesc(challengeLead(p));
    assert.ok(d.length <= CHALLENGE_DESC_MAX, `${route}: ${d.length}`);
    assert.ok(d.startsWith(`${TOOL_TITLES[p.tool]}: `), `${route} opens with its title: ${d.slice(0, 60)}`);
    assert.ok(d.includes(`Use when you need to answer: ${QUESTIONS[p.tool]}`), `${route} keeps its question`);
    assert.ok(p.desc.length >= 180 && p.desc.length <= 255, `${route}: catalogue description ${p.desc.length} chars`);
  }
});

test('MCP: the twenty tools are listed at their prices', { skip }, () => {
  const { TOOL_DEFS } = require('../mcp');
  for (const [, [usd, tool]] of Object.entries(R11)) {
    const d = TOOL_DEFS.find((x) => x.name === tool);
    assert.ok(d, `${tool} is an MCP tool`);
    assert.equal(d.usd, usd, tool);
  }
});

test('Bazaar: every new route has a live-captured output example (none constructed)', { skip }, () => {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bazaar-examples.json'), 'utf8')).routes;
  for (const route of Object.keys(R11)) {
    assert.ok(meta[route] && meta[route].output && meta[route].output.example, `${route} has an output example`);
    assert.ok(!meta[route].static, `${route} is a capture, not a constructed example`);
  }
});

test('server.js: the region gate is mounted once, right after the network-suffix rewrite and before keys and every payment layer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = (s) => { const i = src.indexOf(s); assert.ok(i >= 0, `server.js lost: ${s}`); return i; };
  const strip = at('app.use(compat.stripNetworkSuffix);');
  const gate = at("app.use(require('./tools/llm/region-gate').regionGate);");
  const identify = at('app.use(keys.identify);');
  assert.equal((src.match(/region-gate'\)\.regionGate/g) || []).length, 1, 'mounted once');
  assert.ok(strip < gate && gate < identify, 'after the suffix rewrite (so alias paths are clean), before the key rail');
  for (const later of ['app.use(keys.charge);', 'x402v1.payments', 'req.x402v1 || req.tempoPending || req.keyPaid ? next() : gate(req, res, next)', "require('./expansion').register(app, tool);"]) assert.ok(gate < at(later), `the gate precedes ${later}`);
  const { PHASE_B_PATHS } = require('../tools/llm/region-gate');
  assert.deepEqual([...PHASE_B_PATHS].sort(), PHASE_B.map((r) => r.replace('GET ', '')).sort(), 'the gate covers exactly the eight language-model routes (the seven Phase B routes and R23 claim-check)');
});

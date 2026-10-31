'use strict';
// R10 Phase A (14 Oct 2026): the EVM networks after the first thirteen accepts (lib/ext-rails.js).
//   routing   the REAL buildPaymentLayer with a stub behind every facilitator URL, each stub claiming every network: a payment
//             on each network reaches its own facilitator and no other; a bad payload is a clean 402 and never reaches a handler
//   lists     the default 402 = today's accepts unchanged and first, then the inDefault rows; /api/<route>|<network> = today's
//             accepts + that network; PayAI rows only on routes priced >= $0.005
//   tokens    every row's explicit price: amount in the token's decimals, the on-chain EIP-712 name/version, the right asset
//   size      a production-shaped 402 (Solana, Base, Polygon, Arbitrum, Arc, Algorand, batch-settlement, Gateway + the ext rows)
//             for every route, default and every suffix: PAYMENT-REQUIRED <= 12,000 bytes; the model reproduces today's
//             largest header (trade-context) within 8 bytes of the 10,916 measured through Cloudflare
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactSvmScheme } = require('@x402/svm/exact/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { ExactAvmScheme } = require('@x402/avm/exact/server');
const { SOLANA_MAINNET_CAIP2 } = require('@x402/svm');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');

const payments = require('../payments');
const { PRICES, routeAccepts } = payments;
const rails = require('../lib/rails');
const hf = require('../lib/hf');
const compat = require('../lib/compat');
const { EXT_RAILS, extRails, extAccept, extAllowed, FACILITATOR_URLS } = require('../lib/ext-rails');
const { railContext, acceptsFor } = require('../lib/rail-ctx');
const { ARC } = require('../lib/circle-arc');

const PAY_TO = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const PAY_TO_EVM = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const ALGO = rails.algoRail({});
const FEE_PAYER = 'D6ZhtNQ5nT9ZnTHUbqXZsTx5MH2rPFiBBggX4hY1WePM'; // a 44-character base58 key, as CDP's are

const dec = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const concrete = (pattern) => pattern.replace(/^GET /, '').replace(/:[A-Za-z0-9_]+/g, 'x');

/** A facilitator stub that claims EVERY network, and records which payments reach it. */
function stub(name, calls) {
  const evm = ['eip155:8453', 'eip155:137', 'eip155:42161', ...EXT_RAILS.map((r) => r.network)];
  const kinds = [
    { x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET_CAIP2, extra: { feePayer: FEE_PAYER } },
    ...evm.map((network) => ({ x402Version: 2, scheme: 'exact', network })),
    { x402Version: 2, scheme: 'exact', network: ALGO.network, extra: { feePayer: 'QWOWU2E6BB76HEQRRMXWZ2MU4HAQIYZWEPP2W7Y377ZRDIW7ZKD4MMMEPM' } },
  ];
  return {
    name,
    async getSupported() { return { kinds, extensions: [], signers: {} }; },
    async verify(_p, req) { calls.push(['verify', name, req.network]); return { isValid: false, invalidReason: 'stub_refused', invalidMessage: 'stub' }; },
    async settle(_p, req) { calls.push(['settle', name, req.network]); return { success: false, errorReason: 'stub', transaction: '', network: req.network }; },
  };
}
const nameFor = (cfg) => (cfg && cfg.url === FACILITATOR_URLS.ultravioleta ? 'ultravioleta' : cfg && cfg.url === FACILITATOR_URLS.payai ? 'payai' : cfg && cfg.url === ALGO.facilitator ? 'goplausible' : 'cdp');

/** The real payment layer (no Arc, no high-frequency tier: those need key files and live Circle clients), stubs behind it. */
async function realLayer(t) {
  const keep = {};
  const ENV = { X402_NETWORK: 'mainnet', FACILITATOR_URL: 'https://stub-cdp.invalid/x402', PAY_TO, PAY_TO_EVM, X402_HF: 'off', X402_ARC: 'off', X402_EXT: '', X402_EXT_NETWORKS: '', X402_PAYAI: '', X402_ULTRAVIOLETA: '', X402_EVM_NETWORKS: '', X402_ALGO: '' };
  for (const k of Object.keys(ENV)) { keep[k] = process.env[k]; if (ENV[k] === '') delete process.env[k]; else process.env[k] = ENV[k]; }
  t.after(() => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const calls = [];
  const layer = payments.buildPaymentLayer({ makeClient: (cfg) => stub(nameFor(cfg), calls) });
  const served = [];
  const app = express();
  app.use(compat.stripNetworkSuffix);
  app.use(railContext);
  app.use(layer.middleware);
  for (const pattern of Object.keys(PRICES)) app.get(pattern.slice(4), (req, res) => { served.push(req.path); res.json({ ok: true }); });
  const srv = app.listen(0); t.after(() => srv.close());
  await new Promise((r) => srv.once('listening', r));
  return { layer, calls, served, base: `http://127.0.0.1:${srv.address().port}` };
}

test('Phase A: today\'s accepts stay first and unchanged; the default 402 appends the inDefault rows; a suffix appends one network', async (t) => {
  const { base } = await realLayer(t);
  const EVM = rails.evmRails({ PAY_TO_EVM, X402_ARC: 'off' }); // as realLayer: no Arc, whatever key file the machine has
  const today = (p) => routeAccepts(p, { network: SOLANA_MAINNET_CAIP2, payTo: PAY_TO, EVM, ALGO, HF: { batch: null, gateway: null }, railPrice: rails.railPrice, railPayTo: (r) => rails.railPayTo(r, { PAY_TO_EVM }), hfAccepts: hf.hfAccepts });
  const ext = extRails({ PAY_TO_EVM });
  const def = ext.filter((r) => r.inDefault).map((r) => r.network);
  assert.deepEqual(def, ['eip155:10', 'eip155:143', 'eip155:43114']);
  for (const [pattern, usd] of [['GET /api/sol-price', 0.001], ['GET /api/perp', 0.005], ['GET /api/keys/buy-1', 1]]) {
    const c = dec((await fetch(base + concrete(pattern))).headers.get('payment-required'));
    const nets = c.accepts.map((a) => a.network);
    const n0 = today(PRICES[pattern]).length;
    assert.deepEqual(nets.slice(0, n0), today(PRICES[pattern]).map((a) => a.network), `${pattern}: today's accepts first, same order`);
    assert.deepEqual(nets.slice(n0), def, `${pattern}: then the default ext rows`);
    for (const r of ext.filter((x) => !x.inDefault)) {
      const s = dec((await fetch(base + concrete(pattern) + '|' + r.network)).headers.get('payment-required'));
      const sn = s.accepts.map((a) => a.network);
      if (extAllowed(r, usd)) assert.deepEqual(sn, [...nets.slice(0, n0), r.network], `${pattern}|${r.network}`);
      else assert.deepEqual(sn, nets, `${pattern}|${r.network}: below the row's minimum, the default list`);
      assert.equal(s.resource.url.includes('|') || s.resource.url.includes('%7C'), false, 'the resource URL is the clean one');
    }
    const pct = dec((await fetch(base + concrete(pattern) + '%7Ceip155:42220')).headers.get('payment-required'));
    assert.equal(pct.accepts[pct.accepts.length - 1].network, 'eip155:42220', '%7C works as |');
  }
  // PayAI's rows: never on a route under $0.005, on every route from $0.005
  const cheap = Object.keys(PRICES).filter((k) => PRICES[k].usd < 0.005);
  assert.ok(cheap.length > 0);
  for (const pattern of cheap) {
    const s = dec((await fetch(base + concrete(pattern) + '|eip155:1329')).headers.get('payment-required'));
    assert.ok(!s.accepts.some((a) => a.network === 'eip155:1329'), pattern);
  }
});

test('Phase A: each row\'s accept carries the on-chain token: asset, amount in its decimals, EIP-712 name and version', async (t) => {
  const { base } = await realLayer(t);
  for (const r of EXT_RAILS) {
    const c = dec((await fetch(`${base}/api/perp|${r.network}`)).headers.get('payment-required'));
    const a = c.accepts.find((x) => x.network === r.network);
    assert.ok(a, r.network);
    assert.equal(a.scheme, 'exact');
    assert.equal(a.asset, r.token.address);
    assert.equal(a.amount, String(0.005 * 10 ** r.token.decimals));
    assert.deepEqual({ name: a.extra.name, version: a.extra.version }, { name: r.token.name, version: r.token.version });
    assert.equal(a.payTo, PAY_TO_EVM);
  }
  // the three tokens that are not plain USDC, as read on-chain
  const t56 = EXT_RAILS.find((r) => r.network === 'eip155:56').token;
  assert.deepEqual([t56.symbol, t56.name, t56.version], ['AUSD', 'Agora Dollar', '1']);
  const t4663 = EXT_RAILS.find((r) => r.network === 'eip155:4663').token;
  assert.deepEqual([t4663.symbol, t4663.name, t4663.version], ['USDG', 'Global Dollar', '1']);
  assert.ok(EXT_RAILS.every((r) => r.token.decimals === 6), 'no 18-decimal token (BNB\'s Binance-Peg USDC is not offered)');
});

test('Phase A: a payment on every network reaches its own facilitator and no other; a refused one is a 402 and never served', async (t) => {
  const { base, calls, served } = await realLayer(t);
  const expect = { [SOLANA_MAINNET_CAIP2]: 'cdp', 'eip155:8453': 'cdp', 'eip155:137': 'cdp', 'eip155:42161': 'cdp', [ALGO.network]: 'goplausible' };
  for (const r of EXT_RAILS) expect[r.network] = r.facilitator === 'cdp' ? 'cdp' : r.facilitator;
  for (const [net, fac] of Object.entries(expect)) {
    calls.length = 0;
    const onRequest = EXT_RAILS.some((r) => r.network === net && !r.inDefault);
    const c = dec((await fetch(`${base}/api/perp${onRequest ? `|${net}` : ''}`)).headers.get('payment-required'));
    const accepted = c.accepts.find((a) => a.network === net && a.scheme === 'exact');
    assert.ok(accepted, net);
    const payload = net.startsWith('eip155:')
      ? { signature: '0x' + 'ab'.repeat(65), authorization: { from: '0x05B3000000000000000000000000000000000001', to: accepted.payTo, value: accepted.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: '0x' + '11'.repeat(32) } }
      : { transaction: 'AAAA' };
    // paid on the PLAIN url: the network the payer chose decides the list (lib/rail-ctx.js), not the suffix
    const r = await fetch(`${base}/api/perp`, { headers: { 'payment-signature': enc({ x402Version: 2, resource: c.resource, accepted, payload }) } });
    assert.equal(r.status, 402, `${net}: refused payment answers 402`);
    const verifies = calls.filter((x) => x[0] === 'verify');
    assert.deepEqual(verifies.map((x) => [x[1], x[2]]), [[fac, net]], `${net} verified by ${fac} only`);
    assert.equal(calls.filter((x) => x[0] === 'settle').length, 0, `${net}: nothing settled`);
  }
  assert.equal(served.length, 0, 'no refused payment reached a handler');
});

// ---- the 12,000-byte cap, on a production-shaped 402 -----------------------------------------------------------------
// gatewayNetworks: the Gateway accept's chains. The default is the tier as it is now (Arc only since R14); the model check below passes
// the four chains the header of 14 Oct was measured with, because that measurement is what it validates.
async function prodShaped(t, { withExt, gatewayNetworks = hf.GATEWAY_NETWORKS }) {
  const authorizer = privateKeyToAccount(generatePrivateKey());
  const EVM = [...rails.evmRails({ PAY_TO_EVM, X402_ARC: 'off' }), { network: ARC.network, name: 'Arc', usdc: ARC.usdc, payTo: '0x0Cf44185564F2b72E291050DC79E578429E52f83', facilitator: 'circle', asset: { address: ARC.usdc, decimals: 6, extra: ARC.extra } }];
  const HF = { batch: { networks: hf.BATCH_NETWORKS, receiver: PAY_TO_EVM, authorizer }, gateway: { networks: gatewayNetworks, payTo: '0xC1dC5f1c3D2b0B3e2a9d8F7a6b5C4d3E2F1a0B9c' } };
  const EXT = withExt ? extRails({ PAY_TO_EVM }) : [];
  const nets = [...new Set([...EVM.map((r) => r.network), ...gatewayNetworks, ...EXT.map((r) => r.network)])];
  const kinds = [
    { x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET_CAIP2, extra: { feePayer: FEE_PAYER } },
    ...nets.map((network) => ({ x402Version: 2, scheme: 'exact', network })),
    { x402Version: 2, scheme: 'exact', network: ALGO.network, extra: { feePayer: 'QWOWU2E6BB76HEQRRMXWZ2MU4HAQIYZWEPP2W7Y377ZRDIW7ZKD4MMMEPM' } },
    ...hf.BATCH_NETWORKS.map((network) => ({ x402Version: 2, scheme: 'batch-settlement', network, extra: { receiverAuthorizer: authorizer.address } })),
  ];
  const rs = new x402ResourceServer([{ async getSupported() { return { kinds, extensions: [], signers: {} }; } }]).register(SOLANA_MAINNET_CAIP2, new ExactSvmScheme());
  for (const n of nets) rs.register(n, new ExactEvmScheme());
  rs.register(ALGO.network, new ExactAvmScheme());
  for (const { network, scheme } of hf.batchSchemes(HF.batch, new Database(':memory:'))) rs.register(network, scheme);
  rs.registerExtension(require('@x402/extensions/bazaar').bazaarResourceServerExtension);
  const { challengeDesc, challengeLead, TAGS, ICON_URL, BAZAAR_META } = payments;
  const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
  const inDefault = new Set(EXT.filter((r) => r.inDefault).map((r) => r.network));
  const routes = {};
  for (const [pattern, p] of Object.entries(PRICES)) {
    const base = routeAccepts(p, { network: SOLANA_MAINNET_CAIP2, payTo: PAY_TO, EVM, ALGO, HF, railPrice: rails.railPrice, railPayTo: (r) => rails.railPayTo(r, { PAY_TO_EVM }), hfAccepts: hf.hfAccepts });
    const ext = EXT.filter((r) => extAllowed(r, p.usd)).map((r) => extAccept(r, p.usd, PAY_TO_EVM));
    const m = BAZAAR_META[pattern] || {};
    routes[pattern] = {
      get accepts() { return acceptsFor(base, ext, (n) => inDefault.has(n)); },
      description: challengeDesc(challengeLead(p)), serviceName: 'AgentFeed', tags: TAGS[p.tool] || ['crypto', 'trading'], mimeType: 'application/json', iconUrl: ICON_URL,
      extensions: declareDiscoveryExtension({ input: m.input || {}, inputSchema: m.inputSchema || { properties: {} }, ...(m.pathParamsSchema ? { pathParamsSchema: m.pathParamsSchema } : {}), ...(m.output && m.output.example ? { output: m.output } : {}) }),
    };
  }
  const app = express();
  app.set('trust proxy', 1);
  app.use(compat.stripNetworkSuffix);
  app.use((req, _res, next) => { req.headers['x-forwarded-proto'] = 'https'; next(); });
  app.use(railContext);
  app.use(paymentMiddleware(routes, rs));
  const srv = app.listen(0); t.after(() => srv.close());
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  // GET with the public Host, as Cloudflare forwards it, so resource.url is as long as the live one
  const prLen = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: 'x402.ochinimus.app' } }, (res) => { res.resume(); resolve(String(res.headers['payment-required'] || '').length); }).on('error', reject);
  });
  return { prLen, EXT };
}

test('Phase A: the model reproduces today\'s largest 402 header (trade-context, 10,916 bytes through Cloudflare) within 8 bytes', async (t) => {
  const { prLen } = await prodShaped(t, { withExt: false, gatewayNetworks: ['eip155:8453', 'eip155:137', 'eip155:42161', 'eip155:5042'] });
  const n = await prLen('/api/trade-context');
  assert.ok(Math.abs(n - 10916) <= 8, `model ${n} vs measured 10916`);
});

test('R14: with the Gateway accept on Arc only the same header is smaller, by the three accepts that left', async (t) => {
  const four = await prodShaped(t, { withExt: false, gatewayNetworks: ['eip155:8453', 'eip155:137', 'eip155:42161', 'eip155:5042'] });
  const one = await prodShaped(t, { withExt: false });
  const a = await four.prLen('/api/trade-context'), b = await one.prLen('/api/trade-context');
  assert.ok(b < a - 3 * 400, `Arc only ${b} bytes vs four chains ${a}: three Gateway accepts of roughly 450 bytes each are gone`);
  t.diagnostic(`trade-context PAYMENT-REQUIRED: ${a} bytes with four Gateway chains, ${b} with Arc only`);
});

test('Phase A: PAYMENT-REQUIRED stays at or under 12,000 bytes on every route, default and every suffix', async (t) => {
  const { prLen, EXT } = await prodShaped(t, { withExt: true });
  let max = 0, at = '';
  for (const pattern of Object.keys(PRICES)) {
    const p = concrete(pattern).replace(/\/x(?=\/|$)/, '/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');   // only the '/x' placeholder segment: R23 routes begin with 'x402'
    for (const suffix of ['', ...EXT.filter((r) => !r.inDefault).map((r) => `|${r.network}`)]) {
      const n = await prLen(p + suffix);
      assert.ok(n > 0, `${p}${suffix} has a challenge`);
      if (n > max) { max = n; at = p + suffix; }
    }
  }
  assert.ok(max <= 12000, `largest PAYMENT-REQUIRED ${max} bytes at ${at}`);
  t.diagnostic(`largest PAYMENT-REQUIRED ${max} bytes at ${at}`);
});

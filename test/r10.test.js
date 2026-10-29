'use strict';
// R10 Phase 0 (14 Oct 2026): the nine fixes found in live traffic.
//   F1 the manifest's accepts are the 402's own (lib/manifest.js), for every priced route
//   F2 counts and totals split data routes from key packs; F3 every rail surface names Algorand
//   F4 /.well-known/x402 has one resource per route, path parameters as {name}
//   F5 /api/keys/balance is in openapi.json; F6 injection-check's example is plain text
//   F7 HEAD on a free /api route is answered like GET (source wiring here; behaviour in the scratch boot)
//   F8 robots.txt, sitemap.xml, agent.json, the MCP server card and the AI catalog
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactSvmScheme } = require('@x402/svm/exact/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { ExactAvmScheme } = require('@x402/avm/exact/server');
const { SOLANA_MAINNET_CAIP2 } = require('@x402/svm');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');

const ROOT = path.join(__dirname, '..');
const { PRICES, TAGS, BAZAAR_META, routeAccepts } = require('../payments');
const rails = require('../lib/rails');
const hf = require('../lib/hf');
const discovery = require('../tools/discovery');
const compat = require('../lib/compat');
const { makeManifestAccepts } = require('../lib/manifest');
const { extRails, extAccept, extAllowed } = require('../lib/ext-rails');
const { railContext, acceptsFor } = require('../lib/rail-ctx');

const PAY_TO = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';
const PAY_TO_EVM = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const ENV = { PAY_TO_EVM, X402_NETWORK: 'mainnet' };
const FREE_TOOLS = ['get_fear_greed', 'get_last_liquidation', 'get_exit_method', 'get_forecast_record'];

/** The production accept table (payments.routeAccepts) behind the real middleware, with one stub facilitator for every kind. */
async function layer() {
  const EVM = rails.evmRails(ENV);
  const ALGO = rails.algoRail(ENV);
  const authorizer = privateKeyToAccount(generatePrivateKey());
  const HF = { batch: { networks: hf.BATCH_NETWORKS, receiver: PAY_TO_EVM, authorizer }, gateway: { networks: hf.GATEWAY_NETWORKS, payTo: '0x00000000000000000000000000000000000000a1' } };
  const EXT = extRails(ENV);
  const evmNets = [...new Set([...EVM.map((r) => r.network), ...hf.GATEWAY_NETWORKS, ...EXT.map((r) => r.network)])];
  const kinds = [
    { x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET_CAIP2, extra: { feePayer: 'BFK9TLC3edb13K6v4YyH3DwPb5DSUpkWvb7XnqCL9b4F' } },
    ...evmNets.map((network) => ({ x402Version: 2, scheme: 'exact', network })),
    { x402Version: 2, scheme: 'exact', network: ALGO.network, extra: { feePayer: 'QWOWU2E6BB76HEQRRMXWZ2MU4HAQIYZWEPP2W7Y377ZRDIW7ZKD4MMMEPM' } },
    ...hf.BATCH_NETWORKS.map((network) => ({ x402Version: 2, scheme: 'batch-settlement', network, extra: { receiverAuthorizer: authorizer.address } })),
  ];
  const fac = { async getSupported() { return { kinds, extensions: [], signers: {} }; }, async verify() { return { isValid: false, invalidReason: 'stub' }; }, async settle() { return { success: false }; } };
  const rs = new x402ResourceServer([fac]).register(SOLANA_MAINNET_CAIP2, new ExactSvmScheme());
  for (const n of evmNets) rs.register(n, new ExactEvmScheme());
  rs.register(ALGO.network, new ExactAvmScheme());
  for (const { network, scheme } of hf.batchSchemes(HF.batch, new Database(':memory:'))) rs.register(network, scheme);
  const routes = {};
  const inDefault = new Set(EXT.filter((r) => r.inDefault).map((r) => r.network));
  for (const [pattern, p] of Object.entries(PRICES)) {
    const base = routeAccepts(p, { network: SOLANA_MAINNET_CAIP2, payTo: PAY_TO, EVM, ALGO, HF, railPrice: rails.railPrice, railPayTo: (r) => rails.railPayTo(r, ENV), hfAccepts: hf.hfAccepts });
    const ext = EXT.filter((r) => extAllowed(r, p.usd)).map((r) => extAccept(r, p.usd, PAY_TO_EVM));
    routes[pattern] = { get accepts() { return acceptsFor(base, ext, (n) => inDefault.has(n)); }, description: p.tool, mimeType: 'application/json' };
  }
  await rs.initialize();
  return { routes, resourceServer: rs };
}

const concrete = (pattern) => pattern.replace(/^GET /, '').replace(/:[A-Za-z0-9_]+/g, 'x');
const five = (a) => ({ scheme: a.scheme, network: a.network, amount: a.amount, asset: a.asset, payTo: a.payTo });

test('F1: for every priced route the manifest accepts equal the 402 accepts (scheme, network, amount, asset, payTo), in order', async (t) => {
  const L = await layer();
  const app = express();
  app.use(compat.stripNetworkSuffix);
  app.use(railContext);
  app.use(paymentMiddleware(L.routes, L.resourceServer));
  const srv = app.listen(0); t.after(() => srv.close());
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const manifest = await makeManifestAccepts({ getLayer: () => L })();
  assert.equal(manifest.size, Object.keys(PRICES).length);
  let compared = 0;
  for (const pattern of Object.keys(PRICES)) {
    const r = await fetch(base + concrete(pattern));
    assert.equal(r.status, 402, pattern);
    const challenge = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
    // the default 402 = the manifest's accepts without an on_request marker, same order
    assert.deepEqual(manifest.get(pattern).filter((a) => !a.on_request).map(five), challenge.accepts.map(five), pattern);
    compared += challenge.accepts.length;
    // each on-request accept = the last accept of the 402 at its suffix (R10 Phase A)
    for (const a of manifest.get(pattern).filter((x) => x.on_request)) {
      const s = await fetch(base + concrete(pattern) + a.on_request);
      const sc = JSON.parse(Buffer.from(s.headers.get('payment-required'), 'base64').toString('utf8'));
      assert.deepEqual(five(sc.accepts[sc.accepts.length - 1]), five(a), `${pattern}${a.on_request}`);
      compared++;
    }
  }
  // the rails the 402 offers today, Algorand among them, are all in the manifest (the defect F1 fixes)
  const nets = new Set(manifest.get('GET /api/sol-price').map((a) => a.network));
  for (const r of rails.httpRails(ENV)) assert.ok(nets.has(r.network), r.name);
  const sol = manifest.get('GET /api/sol-price');
  assert.deepEqual(sol.map((a) => a.scheme).slice(0, 5), ['exact', 'exact', 'exact', 'exact', 'exact']);
  assert.ok(sol.some((a) => a.scheme === 'batch-settlement') && sol.some((a) => a.extra && a.extra.name === 'GatewayWalletBatched'));
  assert.equal(sol[0].price_usd, 0.001);
  // key packs carry exact accepts only, as the 402 does
  assert.ok(manifest.get('GET /api/keys/buy-1').every((a) => a.scheme === 'exact' && !(a.extra && a.extra.name === 'GatewayWalletBatched')));
  assert.ok(compared > Object.keys(PRICES).length * 5);
});

test('F1: the manifest builder is not cached on failure and returns nothing with payments off', async () => {
  let n = 0;
  const flaky = { routes: { 'GET /a': { accepts: [{}] } }, resourceServer: { async buildPaymentRequirementsFromOptions() { n++; if (n === 1) throw new Error('not initialised'); return [{ scheme: 'exact', network: 'eip155:8453', amount: '1000', asset: '0xa', payTo: '0xb', maxTimeoutSeconds: 300, extra: {} }]; } } };
  const m = makeManifestAccepts({ getLayer: () => flaky });
  await assert.rejects(m());
  const out = await m();
  assert.equal(out.get('GET /a')[0].price_usd, 0.001);
  assert.equal(out.get('GET /a')[0].asset_symbol, 'USDC');
  assert.equal((await makeManifestAccepts({ getLayer: () => null })()).size, 0);
});

test('F2: llms.txt and SKILL.md count data routes and key packs apart and never add a key pack to the total', () => {
  const { data, keys, total } = discovery.splitPaid(PRICES);
  assert.equal(data.length + keys.length, Object.keys(PRICES).length);
  assert.ok(keys.length > 0 && keys.every(([r]) => r.startsWith('GET /api/keys/')));
  const all = Object.values(PRICES).reduce((n, p) => n + p.usd, 0);
  const ctx = { PRICES, TAGS, META: BAZAAR_META, FREE_TOOLS, mpp: { active: true, routes: ['GET /api/sol-price', 'GET /api/btc-price'] }, tempo: { active: true }, network: 'mainnet' };
  const free = discovery.freeHttp(FREE_TOOLS).length;
  assert.equal(free, 7);
  const llms = discovery.buildLlmsTxt(ctx);
  const skill = discovery.buildSkillMd(ctx);
  for (const doc of [llms, skill]) {
    assert.ok(doc.includes(`${data.length} paid data routes`), 'data count');
    assert.ok(doc.includes(`${keys.length} prepaid key packs`), 'key pack count');
    assert.ok(doc.includes(`$${total.toFixed(3)}`), 'data total');
    assert.ok(!doc.includes(`$${all.toFixed(3)}`), 'never the all-in sum');
    assert.ok(!doc.includes(`${Object.keys(PRICES).length} paid`), 'never the all-in count');
  }
  assert.ok(llms.includes(`${free} free routes`) && skill.includes(`## Free routes (${free})`));
  assert.ok(llms.includes('- GET /api/keys/balance — free') && skill.includes('`GET /api/keys/balance`'));
});

test('F3: openapi, llms.txt, SKILL.md, the agent card and GET / chains name every HTTP rail, Algorand included', (t) => {
  const prev = process.env.PAY_TO_EVM; process.env.PAY_TO_EVM = PAY_TO_EVM;
  t.after(() => { if (prev === undefined) delete process.env.PAY_TO_EVM; else process.env.PAY_TO_EVM = prev; });
  const names = rails.httpRails().map((r) => r.name);
  assert.ok(names.includes('Algorand') && names[0] === 'Solana');
  const ctx = { PRICES, TAGS, META: BAZAAR_META, FREE_TOOLS, mpp: { active: false, routes: [] }, tempo: { active: false }, network: 'mainnet' };
  const guide = discovery.buildOpenApi(ctx).info['x-guidance'];
  assert.ok(guide.includes(`USDC on ${rails.httpRailNames('Solana mainnet')}.`));
  for (const n of names) {
    assert.ok(guide.includes(n), `x-guidance ${n}`);
    assert.ok(discovery.buildLlmsTxt(ctx).includes(`- ${n} (`), `llms ${n}`);
    assert.ok(discovery.buildSkillMd(ctx).includes(`**USDC on ${n}**`), `SKILL ${n}`);
  }
  let body;
  compat.makeAgentCard({ PRICES, TAGS, TITLES: {}, questionFor: () => '', version: '1', ORIGIN: discovery.ORIGIN, railNames: () => rails.httpRailNames(), mpp: { active: false, routes: [] }, tempo: { active: false } })({}, { json: (b) => { body = b; } });
  assert.ok(body.description.includes('Algorand'));
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes("railNames: () => require('./lib/rails').httpRailNames()"), 'server.js hands the card the HTTP rails');
  assert.ok(src.includes("chains: require('./lib/rails').httpRails().map((r) => r.network)"), 'GET / chains from the rail table');
});

test('F4 (reversed by R20e, 29 Oct 2026): /.well-known/x402 lists one resource per priced route; a path-parameter route is its CONCRETE example URL, the {name} template and the example values sit beside', () => {
  // R10 F4 published the {name} template only, so an indexer would not list a route twice. The param guard (lib/param-guard.js) now answers a 400 to a template
  // spelling, so a flat list that names one would hand every validator a dead URL: the list carries the URL that works and the template beside it.
  const wk = discovery.buildWellKnown({ PRICES, META: BAZAAR_META });
  assert.equal(wk.resources.length, Object.keys(PRICES).length);
  assert.equal(new Set(wk.resources).size, wk.resources.length);
  assert.equal(wk.resourceCatalog.length, wk.resources.length);
  const pp = Object.keys(PRICES).filter((r) => r.includes('/:'));
  assert.equal(pp.length, 12);
  for (const r of pp) {
    const template = discovery.ORIGIN + r.replace('GET ', '').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const c = wk.resourceCatalog.find((e) => e.url_template === template);
    assert.ok(c, `${template} is kept as url_template`);
    assert.ok(wk.resources.includes(c.url), `${c.url} is in the flat list`);
    assert.ok(!/[{}:]/.test(c.url.replace('https://', '')), `${c.url} is a working URL, not a template`);
    assert.ok(c.path_params_example && typeof c.path_params_example === 'object', `${c.url} keeps its example values`);
    assert.ok(c.path_params && Object.keys(c.path_params).length, `${c.url} publishes the schema of its path parameter`);
  }
  assert.ok(!wk.resources.some((u) => /\{[A-Za-z]+\}/.test(u)), 'no {template} in the flat list');
  const json = JSON.stringify(wk.resources) + JSON.stringify(wk.resourceCatalog.map((c) => c.url));
  assert.ok(!/\/:[A-Za-z]/.test(json), 'no :param form');
});

test('F5: GET /api/keys/balance is a free openapi operation that declares X-AgentFeed-Key', () => {
  const o = discovery.buildOpenApi({ PRICES, TAGS, META: BAZAAR_META, FREE_TOOLS, mpp: { active: false, routes: [] }, tempo: { active: false } });
  const op = o.paths['/api/keys/balance'] && o.paths['/api/keys/balance'].get;
  assert.ok(op, 'present');
  assert.deepEqual(op.security, []);
  assert.ok(!op['x-payment-info'], 'not priced');
  const h = (op.parameters || []).find((p) => p.in === 'header' && p.name === 'X-AgentFeed-Key');
  assert.ok(h && h.required === true);
  assert.ok(op.responses[200] && op.responses[401]);
  assert.ok(!Object.keys(PRICES).includes('GET /api/keys/balance'));
});

test('F6: injection-check\'s Bazaar example is plain text, with the answer captured for that same text', () => {
  const m = BAZAAR_META['GET /api/injection-check'];
  assert.ok(!/ignore (all )?previous/i.test(m.input.text));
  const d = m.output.example.data;
  assert.equal(d.input_characters, [...m.input.text].length);
  assert.equal(d.verdict, 'no_injection_found');
  assert.equal(m.output.example.tool, 'get_injection_check');
  assert.ok(fs.readFileSync(path.join(ROOT, 'gen-bazaar-meta.js'), 'utf8').includes(`get_injection_check: '${m.input.text}'`), 'the generator makes the same example');
});

test('F7: every HEAD under /api/ (any spelling, R19a) is handed on as a GET with the payment headers removed: a priced route answers its plain challenge, a free route answers like a GET with no body; the bare 405 is gone', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const guard = src.slice(src.indexOf("if (req.method !== 'HEAD' || !isApiPath(req.path)) return next();"), src.indexOf('// Paid routes are GET-only'));
  assert.ok(guard.includes('req.headOnly = true;') && guard.includes("req.method = 'GET';"), 'a HEAD becomes a GET with headOnly set');
  assert.ok(!/status\(405\)/.test(guard) && !guard.includes('head_probe'), 'no 405, no head_probe row');
  assert.ok(!guard.includes('isPricedPath('), 'R19a: the guard does not ask whether the route looks priced, so no spelling can slip past it');
  for (const h of ['payment-signature', 'x-payment', 'payment-authorization']) assert.ok(guard.includes(`'${h}'`), `${h} is removed`);
  const limiter = fs.readFileSync(path.join(ROOT, 'lib', 'ratelimit.js'), 'utf8'); // the limiter moved out of server.js in R13
  assert.ok(limiter.includes("(req.method === 'HEAD' && isApiPath(req.path) && !isPricedPath(req.path))"), 'metered with GET');
  const err = require('../error-responses.json').shared.find((e) => e.status === 405);
  assert.ok(/HEAD on a free route answers like GET/.test(err.when));
});

test('F8: robots.txt allows all and names the machine-readable documents; the sitemap lists the public pages', () => {
  for (const p of ['/llms.txt', '/openapi.json', '/.well-known/x402.json', '/sitemap.xml']) assert.ok(compat.ROBOTS.includes(`https://x402.ochinimus.app${p}`), p);
  assert.ok(/^User-agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: \/\n/.test(compat.ROBOTS));   // R17: the content signal sits inside the group
  assert.ok(/\nSitemap: https:\/\/x402\.ochinimus\.app\/sitemap\.xml\n/.test(compat.ROBOTS));
  assert.deepEqual(compat.SITEMAP_PATHS, ['/', '/keys', '/pricing', '/terms', '/llms.txt', '/openapi.json']);
  let type, body;
  compat.sitemapXml({}, { type(t) { type = t; return this; }, set() { return this; }, send(b) { body = b; } });
  assert.match(type, /xml/);
  assert.equal((body.match(/<loc>/g) || []).length, 6);
});

test('F8: the MCP server card is SEP-2127 shaped, built from server.json, served at three paths; agent.json is the agent card', () => {
  const sj = require('../server.json');
  let out, type;
  const res = { set() { return this; }, type(t) { type = t; return this; }, send(b) { out = JSON.parse(b); } };
  const h = compat.makeMcpServerCard({ serverJson: sj, protocolVersions: ['2025-11-25', '2025-06-18'] });
  h({ headers: {} }, res);
  assert.equal(type, 'application/json');
  assert.equal(out.$schema, 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json');
  assert.equal(out.name, sj.name);
  assert.equal(out.version, sj.version);
  assert.ok(out.description.length >= 1 && out.description.length <= 100);
  assert.deepEqual(out.remotes.map((r) => [r.type, r.url]), sj.remotes.map((r) => [r.type, r.url]));
  assert.deepEqual(out.remotes[0].supportedProtocolVersions, ['2025-11-25', '2025-06-18']);
  assert.ok(!('tools' in out), 'no primitives in a card');
  h({ headers: { accept: 'application/mcp-server-card+json' } }, res);
  assert.equal(type, 'application/mcp-server-card+json');
  assert.deepEqual(compat.MCP_CARD_PATHS, ['/mcp/server-card', '/.well-known/mcp/server-card.json', '/.well-known/mcp.json']);
  let cat;
  compat.makeAiCatalog({ ORIGIN: discovery.ORIGIN })({}, { set() { return this; }, type() { return this; }, send(b) { cat = JSON.parse(b); } });
  assert.equal(cat.entries[0].url, `${discovery.ORIGIN}/mcp/server-card`);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes("app.get('/.well-known/agent-card.json', agentCard);") && src.includes("app.get('/.well-known/agent.json', agentCard);"));
  for (const p of ["app.get('/robots.txt', compat.robotsTxt);", "app.get('/sitemap.xml', compat.sitemapXml);", 'for (const p of compat.MCP_CARD_PATHS) app.get(p, card);', "app.get('/.well-known/ai-catalog.json'"]) assert.ok(src.includes(p), p);
});

test('F9: solana/charge stays on two routes, with the reason written beside the list', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes("const MPP_ROUTES = ['GET /api/sol-price', 'GET /api/btc-price'];"));
  const at = src.indexOf('const MPP_ROUTES');
  assert.ok(/getLatestBlockhash/.test(src.slice(at - 1200, at)), 'the reason sits above the list');
});

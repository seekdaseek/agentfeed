// R23 T3: x402-lint (31 Oct 2026). The code under test is the real lint and the real lib/safe-fetch.js over a stubbed socket; the seller is test/fixtures/r23/x402/seller.js.
// Every check of the rubric has a baseline that passes it and a scenario that fails it (the second is the negative control of the first); every verdict path has a test.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('./fixtures/r23/x402/seller');
const R = require('../tools/r23/x402/rubric');
const P = require('../tools/r23/x402/parse');
const L = require('../tools/r23/x402/lint');
const EX = require('../tools/r23/x402/example');
const lintRoute = require('../tools/r23/x402-lint');

const FIXED = Date.UTC(2026, 9, 31, 12, 0, 0);
const URL_ = `https://${S.HOST}${S.PATH}`;
const base = () => S.challengeV2([S.offer('base', 2), S.offer('solana', 2)]);
const servedV2 = (ch, extra = {}) => ({ status: 402, headers: { 'payment-required': S.b64(ch), 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }, body: '{}' });
const servedV1 = (ch, extra = {}) => ({ status: 402, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }, body: JSON.stringify(ch) });
const resp = (status, body = '', headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body });

async function lint(cfg = {}, { url = URL_, method, deps } = {}) {
  const sel = S.makeSeller(cfg); const tr = S.stubTransport(sel.script);
  try { const out = await L.lintEndpoint({ url, ...(method ? { method } : {}) }, { now: () => FIXED, ...deps }); return { out, seller: sel, calls: tr.calls }; } finally { tr.restore(); }
}
const chk = (out, id) => out.checks.find((c) => c.id === id);
const failed = (out) => out.checks.filter((c) => !c.pass && c.severity !== 'info').map((c) => c.id);

// ================= the rubric as data
test('rubric: ids are unique, every error and warn check has a weight, info checks have none, and every id the lint reports is in the table (regex proven on a known positive first)', () => {
  const ids = R.CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of R.CHECKS) {
    assert.ok(['error', 'warn', 'info'].includes(c.severity), c.id);
    assert.ok(c.title && c.tests && c.group, c.id);
    if (c.severity === 'info') assert.equal(c.weight, 0, c.id); else assert.ok(c.weight > 0 && c.weight <= 100, c.id);
  }
  // G1: the regex that reads ids out of the source must match a known positive before it is believed on the real file
  const re = /\b(?:C\.add\(|C\.untested\(|gradeProbe\(C,|verdictFor\()\s*'([a-z_0-9]+)'/g;
  const sample = "C.add('http_402', x); verdictFor('entry_scheme', y); gradeProbe(C, 'head_unpaid', 'a', p, true); C.untested('x_y', 'w')";
  assert.deepEqual([...sample.matchAll(re)].map((m) => m[1]), ['http_402', 'entry_scheme', 'head_unpaid', 'x_y'], 'the id regex matches a known positive');
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'r23', 'x402', 'lint.js'), 'utf8');
  const used = new Set([...src.matchAll(re)].map((m) => m[1]));
  assert.ok(used.size >= 28, `the regex found ${used.size} ids in lint.js`);
  for (const u of used) assert.ok(ids.includes(u), `${u} is reported by lint.js but is not in the rubric`);
  for (const i of ids) assert.ok(used.has(i), `${i} is in the rubric but lint.js never reports it`);
});

test('rubric drift: the network, asset and extension lists match the installed x402 packages', () => {
  const v1 = require('@x402/evm/v1');
  assert.deepEqual(Object.keys(R.V1_CHAIN_IDS).sort(), [...v1.NETWORKS].sort());
  for (const n of v1.NETWORKS) assert.equal(R.V1_CHAIN_IDS[n], v1.EVM_NETWORK_CHAIN_ID_MAP[n], n);
  const svm = require('@x402/svm');
  assert.deepEqual(Object.fromEntries(R.V1_SOLANA.map((n) => [n, `solana:${n === 'solana' ? R.SOLANA_REFS.mainnet : n === 'solana-devnet' ? R.SOLANA_REFS.devnet : R.SOLANA_REFS.testnet}`])), svm.V1_TO_V2_NETWORK_MAP);
  assert.equal(R.USDC[`solana:${R.SOLANA_REFS.mainnet}`], svm.USDC_MAINNET_ADDRESS); assert.equal(R.USDC[`solana:${R.SOLANA_REFS.devnet}`], svm.USDC_DEVNET_ADDRESS);
  const evm = new (require('@x402/evm/exact/client').ExactEvmScheme)({});
  for (const [net, addr] of Object.entries(R.USDC)) if (net.startsWith('eip155:')) assert.ok(evm.findDefaultAsset(addr, net), `${net} USDC is a default asset of @x402/evm`);
  assert.equal(R.PAYABLE.base.asset, R.USDC['eip155:8453']); assert.equal(R.PAYABLE.solana.asset, svm.USDC_MAINNET_ADDRESS);
  // the extension keys: three are constants of @x402/extensions, the rest are named in its source (the search is proven on a known positive)
  const src = fs.readFileSync(require.resolve('@x402/extensions'), 'utf8');
  assert.ok(/"bazaar"/.test('x = "bazaar"'), 'the key regex matches a known positive');
  for (const k of R.EXTENSIONS) assert.ok(new RegExp(`["']${k}["']`).test(src), `${k} appears in @x402/extensions`);
});

// ================= the parsing helpers
test('parse: Solana addresses (real ones decode to 32 bytes), EVM addresses, atomic amounts, base64 JSON', () => {
  for (const a of ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']) assert.equal(P.isSolAddr(a), true, a);
  for (const a of ['', 'abc', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'O0Il'.repeat(10), 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 5, null]) assert.equal(P.isSolAddr(a), false, String(a));
  assert.equal(P.b58Len('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 32); assert.equal(P.b58Len('1112'), 4); assert.equal(P.b58Len('0'), -1);
  assert.equal(P.isEvmAddr('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), true); assert.equal(P.isEvmAddr('0x83'), false); assert.equal(P.isEvmAddr('833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), false);
  assert.equal(P.isEvmAddr('0xZZ3589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), false);
  for (const ok of ['1', '5000', '9'.repeat(77)]) assert.equal(P.isAtomic(ok), true, ok);
  for (const no of ['0', '05', '-5', '1.5', '1e3', ' 5', '', 5000, null, '9'.repeat(79)]) assert.equal(P.isAtomic(no), false, String(no));
  assert.deepEqual(P.decodeB64Json(S.b64({ a: 1 })), { ok: true, value: { a: 1 } });
  assert.equal(P.decodeB64Json('!!!').why, 'not base64'); assert.equal(P.decodeB64Json(Buffer.from('nope').toString('base64')).why, 'base64 text is not JSON'); assert.equal(P.decodeB64Json(Buffer.from('[1]').toString('base64')).why, 'JSON but not an object');
  assert.equal(P.decodeB64Json(Buffer.from('{"a":1}').toString('base64url')).ok, true, 'base64url is read too');
  assert.equal(P.hasPaymentScheme('Payment id="x", realm="y"'), true); assert.equal(P.hasPaymentScheme('Bearer realm="x", Payment id="y"'), true); assert.equal(P.hasPaymentScheme('Bearer realm="x"'), false); assert.equal(P.hasPaymentScheme('PaymentX id'), false);
  assert.equal(P.plainUrl('https://a.example/p?token=SECRET#frag'), 'https://a.example/p'); assert.equal(P.show('a\nb\u0000c'.repeat(40), 20).length, 23);
});

// ================= verdict paths
test('verdict valid: a clean v2 challenge (Base and Solana, resource, description, bazaar), a HEAD and the other spellings not served -> valid, 100, and every probe was made', async () => {
  const { out, seller } = await lint({});
  assert.equal(out.verdict, 'valid'); assert.equal(out.score, 100); assert.equal(out.version, 2); assert.deepEqual(out.networks, [S.BASE_NET.v2, S.SOL_NET.v2]);
  assert.deepEqual(failed(out), []); assert.equal(out.checked_at, new Date(FIXED).toISOString()); assert.equal(chk(out, 'discovery_metadata').detail, 'recognised: bazaar');
  const seen = seller.log.map((l) => `${l.method} ${new URL(l.url).pathname}`).sort();
  assert.deepEqual(seen, ['GET /API/DATA', 'GET /api/data', 'GET /api/data/', 'HEAD /api/data'], 'the request, a HEAD, the upper-case and the trailing-slash spellings');
});
test('verdict valid: a clean v1 challenge in the body', async () => {
  const { out } = await lint({ version: 1 });
  assert.equal(out.verdict, 'valid', JSON.stringify(failed(out))); assert.equal(out.version, 1); assert.deepEqual(out.networks, ['base', 'solana']); assert.equal(chk(out, 'version_location').pass, true);
});
test('verdict warnings: only warn checks fail -> warnings, and the score is 100 minus their weights', async () => {
  const ch = base(); delete ch.resource.description; delete ch.resource.mimeType;
  const { out } = await lint({ unpaid: () => servedV2(ch) });
  assert.equal(out.verdict, 'warnings'); assert.deepEqual(failed(out).sort(), ['description_present', 'mime_type_present']);
  assert.equal(out.score, 100 - R.BY_ID.get('description_present').weight - R.BY_ID.get('mime_type_present').weight);
});
test('verdict invalid: an error check fails -> invalid, and an error outweighs warnings', async () => {
  const ch = base(); ch.accepts[0].payTo = '0x123'; delete ch.resource.description;
  const { out } = await lint({ unpaid: () => servedV2(ch) });
  assert.equal(out.verdict, 'invalid'); assert.deepEqual(failed(out).sort(), ['description_present', 'entry_payto']); assert.equal(out.score, 100 - 25 - 3);
});
test('verdict no-402: the endpoint answers something else, and each answer is explained', async () => {
  const cases = [
    ['200 free', resp(200, '{"free":true}'), /HTTP 200.*answered an unpaid request with its content.*not asking for payment/s],
    ['401', resp(401, '{"error":"auth"}'), /login or permission wall, not a payment request/],
    ['403', resp(403, ''), /HTTP 403/],
    ['404', resp(404, 'no'), /no handler for this method and path/],
    ['405', resp(405, ''), /POST-only endpoint answers GET with 405/],
    ['429', resp(429, ''), /rate-limited the request before it asked for payment/],
    ['500', resp(500, ''), /failed before it could ask for payment/],
  ];
  for (const [what, r, re] of cases) {
    const { out, seller } = await lint({ unpaid: () => r });
    assert.equal(out.verdict, 'no-402', what); assert.equal(out.score, 0, what); assert.match(chk(out, 'http_402').detail, re, what); assert.equal(chk(out, 'http_402').pass, false); assert.equal(out.version, null);
    assert.equal(seller.log.length, 1, `${what}: no probes for an endpoint that does not ask for payment`); assert.equal(out.raw.status, r.status); assert.equal(out.raw.challenge, null);
  }
});
test('verdict no-402: a redirect to a login page is explained (the redirect, its target without the query, and that it looks like a login page)', async () => {
  const { out } = await lint({
    unpaid: () => ({ status: 302, headers: { location: 'https://login.example.test/signin?next=/api/data&token=SECRET' }, body: '' }),
    other: () => resp(200, '<html><form><input type="password" name="p"></form>Sign in</html>', { 'content-type': 'text/html' }),
  });
  assert.equal(out.verdict, 'no-402'); const d = chk(out, 'http_402').detail;
  assert.match(d, /looks like a login page/); assert.match(d, /redirected to https:\/\/login\.example\.test\/signin/); assert.ok(!/SECRET|token/.test(JSON.stringify(out)), 'the redirect query is never echoed');
  assert.equal(chk(out, 'no_redirect').pass, false); assert.equal(out.raw.final_url, 'https://login.example.test/signin');
});
test('verdict no-402: a 402 that carries only a WWW-Authenticate: Payment challenge (MPP) is reported and not graded', async () => {
  const { out } = await lint({ unpaid: () => resp(402, '{"detail":"pay"}', { 'www-authenticate': 'Payment id="a", realm="r", method="tempo", intent="charge"' }) });
  assert.equal(out.verdict, 'no-402'); assert.equal(chk(out, 'mpp_detected').pass, true); assert.equal(chk(out, 'http_402').pass, true); assert.equal(chk(out, 'challenge_found').pass, false);
  // control: the same MPP header beside a real x402 challenge does not change the grade of the x402 part
  const both = await lint({ unpaid: () => servedV2(base(), { 'www-authenticate': 'Payment id="a", realm="r"' }) });
  assert.equal(both.out.verdict, 'valid'); assert.equal(chk(both.out, 'mpp_detected').pass, true);
});
test('verdict invalid: a 402 with nothing readable in it (HTML, or JSON without accepts) -> invalid, score 0, and it says what was missing', async () => {
  for (const [what, r, re] of [['html', resp(402, '<html>Pay</html>', { 'content-type': 'text/html' }), /no PAYMENT-REQUIRED header and no JSON body with accepts/],
    ['json without accepts', resp(402, '{"error":"payment required"}'), /no JSON body with accepts/], ['empty', resp(402, ''), /no PAYMENT-REQUIRED header/],
    ['bad header', resp(402, '', { 'payment-required': 'this is not base64!' }), /header is not base64/]]) {
    const { out } = await lint({ unpaid: () => r });
    assert.equal(out.verdict, 'invalid', what); assert.equal(out.score, 0, what); assert.match(chk(out, 'challenge_found').detail, re, what);
  }
});

// ================= every check: a baseline that passes it and a scenario that fails it
const dup = (o) => ({ ...o, extra: { ...o.extra } });
const v2 = (f) => () => { const ch = base(); f(ch); return servedV2(ch); };
const v1 = (f) => () => { const ch = S.challengeV1([S.offer('base', 1), S.offer('solana', 1)]); f(ch); return servedV1(ch); };
const SCEN = {
  no_redirect: { cfg: { unpaid: () => ({ status: 302, headers: { location: `https://${S.HOST}/moved` }, body: '' }), spelling: (st, c) => (c.u.pathname === '/moved' ? servedV2(base()) : undefined) } },
  challenge_size: { cfg: { unpaid: v2((ch) => { for (let i = 0; i < 40; i++) ch.accepts.push({ ...S.offer('base', 2), payTo: `0x${String(i).padStart(40, '0')}`, extra: { name: 'USD Coin', version: '2', note: 'x'.repeat(60) } }); }) } },
  challenge_not_cached: { cfg: { unpaid: () => servedV2(base(), { 'cache-control': 'public, max-age=3600' }) } },
  challenge_found: { cfg: { unpaid: () => resp(402, 'nothing') } },
  header_decodes: { cfg: { unpaid: () => ({ ...servedV1(S.challengeV1([S.offer('base', 1)])), headers: { 'payment-required': '@@bad@@', 'content-type': 'application/json' } }) }, expectVerdict: 'invalid' },
  version_known: { cfg: { unpaid: v2((ch) => { ch.x402Version = 3; }) } },
  version_location: { cfg: { unpaid: v1((ch) => { ch.x402Version = 2; }) } },
  versions_agree: { cfg: { unpaid: () => ({ ...servedV2(base()), body: JSON.stringify({ ...base(), accepts: [S.offer('base', 2, { amount: 9999 })] }) }) }, needBody: true },
  accepts_present: { cfg: { unpaid: v2((ch) => { ch.accepts = []; }) } },
  entry_scheme: { cfg: { unpaid: v2((ch) => { delete ch.accepts[0].scheme; }) } },
  scheme_known: { cfg: { unpaid: v2((ch) => { ch.accepts[0].scheme = 'weird'; }) } },
  entry_network: { cfg: { unpaid: v2((ch) => { ch.accepts[0].network = 'base'; }) } },
  network_known: { cfg: { unpaid: v2((ch) => { ch.accepts[0].network = 'eip155:abc'; }) } },
  entry_amount: { cfg: { unpaid: v2((ch) => { ch.accepts[0].amount = 5000; }) } },
  amount_range: { cfg: { unpaid: v2((ch) => { ch.accepts[0].amount = '200000000'; }) } },
  entry_asset: { cfg: { unpaid: v2((ch) => { ch.accepts[0].asset = 'USDC'; }) } },
  entry_payto: { cfg: { unpaid: v2((ch) => { ch.accepts[1].payTo = '0xnotsolana'; }) } },
  entry_timeout: { cfg: { unpaid: v2((ch) => { ch.accepts[0].maxTimeoutSeconds = '300'; }) } },
  timeout_range: { cfg: { unpaid: v2((ch) => { ch.accepts[0].maxTimeoutSeconds = 604900; }) } },
  exact_extra: { cfg: { unpaid: v2((ch) => { delete ch.accepts[1].extra.feePayer; }) } },
  entry_duplicate: { cfg: { unpaid: v2((ch) => { ch.accepts.push(dup(ch.accepts[0])); }) } },
  mainnet_offered: { cfg: { unpaid: v2((ch) => { ch.accepts = [{ ...S.offer('base', 2), network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }]; }) } },
  resource_url: { cfg: { unpaid: v2((ch) => { ch.resource.url = 'https://other.example/api/data'; }) } },
  description_present: { cfg: { unpaid: v2((ch) => { delete ch.resource.description; }) } },
  mime_type_present: { cfg: { unpaid: v2((ch) => { ch.resource.mimeType = 'json'; }) } },
  extensions_shape: { cfg: { unpaid: v2((ch) => { ch.extensions = 'bazaar'; }) } },
  head_unpaid: { cfg: { spelling: (st, c) => (c.opts.method === 'HEAD' ? { status: 200, headers: { 'content-type': 'application/json', 'content-length': '214' } } : undefined) } },
  case_variant_unpaid: { cfg: { spelling: (st, c) => (c.u.pathname === '/API/DATA' ? resp(200, '{"leak":true}') : undefined) } },
  slash_variant_unpaid: { cfg: { spelling: (st, c) => (c.u.pathname === '/api/data/' ? resp(200, '{"leak":true}') : undefined) } },
};
const INFO_OR_OWN_TEST = ['http_402', 'mpp_detected', 'discovery_metadata'];   // http_402 and mpp_detected have their verdict tests above, discovery_metadata its own below

test('every check of the rubric is covered below or above (so a new check cannot be added without a test)', () => {
  const covered = new Set([...Object.keys(SCEN), ...INFO_OR_OWN_TEST]);
  for (const c of R.CHECKS) assert.ok(covered.has(c.id), `${c.id} has no failing scenario`);
  for (const id of covered) assert.ok(R.BY_ID.has(id), id);
});
for (const [id, sc] of Object.entries(SCEN)) {
  test(`check ${id}: passes on a clean challenge, fails on its scenario (${R.BY_ID.get(id).severity}, weight ${R.BY_ID.get(id).weight})`, async () => {
    const baseCfg = sc.baseline || (sc.needBody ? { unpaid: () => ({ ...servedV2(base()), body: JSON.stringify(base()) }) } : {});
    const clean = await lint(baseCfg);
    const c0 = chk(clean.out, id);
    assert.ok(c0, `${id} is reported on a clean challenge`); assert.equal(c0.pass, true, `${id} passes on a clean challenge: ${c0.detail}`);
    const bad = await lint(sc.cfg);
    const c1 = chk(bad.out, id);
    assert.ok(c1, `${id} is reported on its scenario`); assert.equal(c1.pass, false, `${id} fails on its scenario`); assert.equal(c1.severity, R.BY_ID.get(id).severity);
    const want = sc.expectVerdict || (R.BY_ID.get(id).severity === 'error' ? 'invalid' : 'warnings');
    if (R.BY_ID.get(id).severity === 'error' || !failed(bad.out).some((x) => R.BY_ID.get(x).severity === 'error')) assert.equal(bad.out.verdict, want, `${id}: ${bad.out.verdict} ${JSON.stringify(failed(bad.out))}`);
    assert.ok(bad.out.score < clean.out.score, `${id}: failing it lowers the score`);
  });
}

test('v1 offers: the price is maxAmountRequired; a v1 challenge written with CAIP-2 names, or a v2 one using maxAmountRequired, is flagged', async () => {
  let r = await lint({ unpaid: v1((ch) => { delete ch.accepts[0].maxAmountRequired; ch.accepts[0].amount = '5000'; }) });
  assert.match(chk(r.out, 'entry_amount').detail, /has amount, but a v1 offer states its price in maxAmountRequired/);
  r = await lint({ unpaid: v1((ch) => { ch.accepts[0].network = 'eip155:8453'; }) });
  assert.match(chk(r.out, 'network_known').detail, /v1 challenge names networks like base or solana/);
  r = await lint({ unpaid: v2((ch) => { ch.accepts[0].maxAmountRequired = ch.accepts[0].amount; delete ch.accepts[0].amount; }) });
  assert.match(chk(r.out, 'entry_amount').detail, /has maxAmountRequired, but a v2 offer states its price in amount/);
  r = await lint({ unpaid: v1((ch) => { ch.accepts[0].outputSchema = { input: {}, output: {} }; }) });
  assert.match(chk(r.out, 'discovery_metadata').detail, /recognised: outputSchema/);
});
test('discovery_metadata (info): lists what it recognises, says so when there is none, and never moves the verdict or the score', async () => {
  let r = await lint({ unpaid: v2((ch) => { ch.extensions = { bazaar: {}, 'sign-in-with-x': {}, 'my-own-thing': {} }; }) });
  assert.equal(chk(r.out, 'discovery_metadata').detail, 'recognised: bazaar, sign-in-with-x; not recognised here: my-own-thing'); assert.equal(r.out.verdict, 'valid');
  r = await lint({ unpaid: v2((ch) => { delete ch.extensions; }) });
  const d = chk(r.out, 'discovery_metadata'); assert.equal(d.pass, false); assert.equal(d.severity, 'info'); assert.match(d.detail, /none recognised/); assert.equal(r.out.verdict, 'valid'); assert.equal(r.out.score, 100);
});
test('a challenge with the header (v2) and a body (v1) is graded on the header and says the two were not compared; two v2 copies that differ are flagged', async () => {
  const both = await lint({ unpaid: () => ({ ...servedV2(base()), body: JSON.stringify(S.challengeV1([S.offer('base', 1)])) }) });
  assert.equal(both.out.version, 2); assert.match(chk(both.out, 'versions_agree').detail, /v1 challenge in the body \(1 offers\) beside the v2 challenge in the header: two versions, not compared/);
});
test('testnet offers beside a mainnet one are fine; a network of another family is recognised and not format-checked', async () => {
  const r = await lint({ unpaid: v2((ch) => { ch.accepts.push({ scheme: 'exact', network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k', amount: '5000', asset: '31566704', payTo: 'ALGOADDR', maxTimeoutSeconds: 60, extra: {} }, { ...S.offer('base', 2), network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }); }) });
  assert.equal(chk(r.out, 'mainnet_offered').pass, true); assert.equal(chk(r.out, 'entry_payto').pass, true, 'an Algorand payTo is not format-checked'); assert.equal(chk(r.out, 'network_known').pass, true);
  assert.equal(r.out.verdict, 'valid', JSON.stringify(failed(r.out)));
});

// ================= the paywall probes
test('probes: a HEAD that answers 200 with no content, a spelling redirected somewhere, or a 5xx is not a bypass; a 200 with content is', async () => {
  const empty = await lint({ spelling: (st, c) => (c.opts.method === 'HEAD' ? { status: 200, headers: { 'content-length': '0' } } : undefined) });
  assert.equal(chk(empty.out, 'head_unpaid').pass, true); assert.match(chk(empty.out, 'head_unpaid').detail, /with no content/);
  const moved = await lint({ spelling: (st, c) => (c.u.pathname === '/api/data/' ? { status: 301, headers: { location: `https://${S.HOST}/landing` }, body: '' } : c.u.pathname === '/landing' ? resp(200, '<html>home</html>') : undefined) });
  assert.equal(chk(moved.out, 'slash_variant_unpaid').pass, true); assert.match(chk(moved.out, 'slash_variant_unpaid').detail, /redirected to https:\/\/seller\.test\/landing.*not counted as served content/);
  const five = await lint({ spelling: (st, c) => (c.u.pathname === '/API/DATA' ? resp(500, 'boom') : undefined) });
  assert.equal(chk(five.out, 'case_variant_unpaid').pass, true); assert.match(chk(five.out, 'case_variant_unpaid').detail, /answered HTTP 500/);
  const leak = await lint({ spelling: (st, c) => (c.opts.method === 'HEAD' ? { status: 200, headers: { 'content-length': '5' } } : undefined) });
  assert.equal(chk(leak.out, 'head_unpaid').pass, false); assert.equal(leak.out.verdict, 'invalid');
});
test('probes: a probe that cannot be sent is "not tested", severity info, and moves neither the verdict nor the score', async () => {
  const { out } = await lint({ spelling: (st, c) => (c.opts.method === 'HEAD' ? Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) : undefined) });
  const h = chk(out, 'head_unpaid'); assert.deepEqual([h.severity, h.pass], ['info', false]); assert.match(h.detail, /^not tested: a HEAD request could not be sent/);
  assert.equal(out.verdict, 'valid'); assert.equal(out.score, 100);
});
test('probes: a POST lint probes with POST (and HEAD with HEAD); a path with no letters has no case spelling and a root path has no slash spelling', async () => {
  const post = await lint({}, { method: 'POST' });
  const ms = post.seller.log.map((l) => l.method).sort(); assert.deepEqual(ms, ['HEAD', 'POST', 'POST', 'POST']);
  assert.equal(post.calls.find((c) => c.opts.method === 'POST').opts.headers['content-type'], 'application/json');
  const digits = L.variants(new URL('https://a.example/123/456')); assert.equal(digits.upper, null); assert.equal(digits.slash, 'https://a.example/123/456/');
  const root = L.variants(new URL('https://a.example/')); assert.equal(root.slash, null); assert.equal(root.upper, null);
  const q = L.variants(new URL('https://a.example/api/x/?a=b')); assert.equal(q.slash, 'https://a.example/api/x?a=b'); assert.equal(q.upper, 'https://a.example/API/X/?a=b');
});

// ================= the output
test('output shape: exactly the documented fields; raw.headers is an allow-list; the long header is replaced by its size; a huge challenge is capped', async () => {
  const { out } = await lint({ unpaid: () => servedV2(base(), { 'set-cookie': 'sid=SECRET', 'x-internal': 'leak', 'access-control-allow-origin': '*' }) });
  assert.deepEqual(Object.keys(out), ['url', 'checked_at', 'verdict', 'score', 'version', 'networks', 'checks', 'raw']);
  assert.deepEqual(Object.keys(out.raw).sort(), ['challenge', 'headers', 'latency_ms', 'status']);
  assert.ok(Object.keys(out.raw.headers).every((k) => R.HEADER_ALLOW.includes(k)), JSON.stringify(Object.keys(out.raw.headers)));
  assert.ok(!JSON.stringify(out).includes('SECRET') && !JSON.stringify(out).includes('x-internal'));
  assert.match(out.raw.headers['payment-required'], /^\(\d+ characters of base64, decoded in raw\.challenge\)$/); assert.equal(out.raw.headers['access-control-allow-origin'], '*');
  for (const c of out.checks) assert.deepEqual(Object.keys(c), ['id', 'severity', 'pass', 'detail']);
  assert.deepEqual(out.checks.map((c) => c.id), R.CHECKS.filter((c) => out.checks.some((x) => x.id === c.id)).map((c) => c.id), 'checks come in rubric order');
  const big = await lint({ unpaid: v2((ch) => { for (let i = 0; i < 80; i++) ch.accepts.push({ ...S.offer('base', 2), payTo: `0x${String(i + 1).padStart(40, '0')}`, extra: { name: 'USD Coin', version: '2', note: 'y'.repeat(100) } }); }) });
  assert.equal(big.out.raw.challenge.truncated, true); assert.equal(big.out.raw.challenge.accepts.length, 5); assert.ok(JSON.stringify(big.out.raw.challenge).length < R.LIMITS.challengeJsonBytes);
  assert.ok(JSON.stringify(big.out).length < 60000, 'the whole answer stays small');
});
test('a seller\'s deeply nested JSON cannot overflow the stack or break the grade', async () => {
  let deep = {}; const root = deep; for (let i = 0; i < 4000; i++) { deep.n = {}; deep = deep.n; }
  const { out } = await lint({ unpaid: v2((ch) => { ch.accepts[0].extra = { name: 'USD Coin', version: '2', deep: root }; ch.accepts.push(JSON.parse(JSON.stringify(ch.accepts[0]))); }) });
  assert.ok(['valid', 'warnings', 'invalid'].includes(out.verdict)); assert.equal(chk(out, 'entry_duplicate').pass, false, 'the duplicate is still seen');
  const huge = `${'['.repeat(100000)}${']'.repeat(100000)}`;
  const r2 = await lint({ unpaid: () => resp(402, huge) }); assert.equal(r2.out.verdict, 'invalid');
});
test('a text echoed from the seller is cut and stripped of control characters', async () => {
  const { out } = await lint({ unpaid: v2((ch) => { ch.accepts[0].scheme = `bad\n${'x'.repeat(500)}`; }) });
  const d = chk(out, 'scheme_known').detail; assert.ok(d.length < 220, d.length); assert.ok(!/[\u0000-\u001f]/.test(d));
});

// ================= the live proof, replayed from the captured response, and the route entry
test('the response captured live from https://x402.ochinimus.app/api/time (31 Oct 2026) grades as warnings: its 12-offer header, v1 body, MPP header and bazaar extension are read, and the one-week window of the Gateway offer is the single warning', async () => {
  const cap = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'r23', 'x402', 'live-time-402.json'), 'utf8'));
  // replayed through an injected fetch: the mock seller is bound to seller.test
  const fetch = async (url, o) => {
    const u = new URL(url);
    if (o.method === 'HEAD') return { url, status: 402, contentType: 'application/json', headers: cap.headers, body: Buffer.alloc(0) };
    if (u.pathname !== '/api/time') return { url, status: 404, contentType: 'text/plain', headers: {}, body: Buffer.from('nf') };
    return { url, status: 402, contentType: 'application/json', headers: cap.headers, body: Buffer.from(cap.body) };
  };
  const live = await L.lintEndpoint({ url: cap.url }, { fetch, now: () => FIXED });
  assert.equal(live.verdict, 'warnings'); assert.equal(live.version, 2); assert.equal(live.networks.length, 8);
  assert.deepEqual(failed(live), ['timeout_range']); assert.match(chk(live, 'timeout_range').detail, /eip155:5042.*604900/);
  assert.equal(chk(live, 'mpp_detected').pass, true); assert.match(chk(live, 'versions_agree').detail, /two versions, not compared/); assert.equal(chk(live, 'discovery_metadata').detail, 'recognised: bazaar');
  assert.equal(chk(live, 'challenge_size').pass, true);
});
test('route entry: shape, price, description rules (180 to 255 characters, "Use when an agent needs", the counts come from code), banned words, schema and the constructed example', () => {
  const [e] = lintRoute.entries;
  assert.deepEqual([e.name, e.route, e.usd], ['get_x402_lint', 'GET /api/x402-lint', 0.05]);
  assert.ok(e.desc.length >= 180 && e.desc.length <= 255, e.desc.length); assert.ok(e.desc.startsWith('Use when an agent needs')); assert.ok(e.desc.includes(String(R.CHECKS.length)), 'the check count in the text is the rubric length');
  assert.match(e.desc, /503/); assert.ok(e.tags.every((t) => t === t.toLowerCase()));
  assert.deepEqual(Object.keys(e.schema), ['url', 'method']);
  assert.ok(e.title && e.question.endsWith('?') && typeof e.run === 'function');
  assert.ok(!/\{[^}]*:[a-z]+\}/.test(e.route), 'a query-parameter route: no path parameter');
  // the example is exactly the shape of a real answer
  const keys = (o) => JSON.stringify(Object.keys(o));
  assert.equal(keys(e.example), keys(EX.lintExample())); assert.equal(e.example.verdict, 'valid'); assert.equal(e.example.score, 100);
});
test('route entry: run reads the query (a repeated parameter, a missing url, a bad method are 400; the method is case-insensitive) and passes deps to the lint', async () => {
  for (const [what, q] of [['no url', {}], ['empty url', { url: ' ' }], ['array url', { url: [URL_, URL_] }], ['too long', { url: `https://a.example/${'x'.repeat(2100)}` }], ['bad method', { url: URL_, method: 'PUT' }], ['array method', { url: URL_, method: ['GET', 'POST'] }], ['an unencoded url leaves a stray parameter', { url: 'https://a.example/p?x=1', y: '2' }]]) {
    await assert.rejects(lintRoute.makeEntries({}).at(0).run(q), (e) => e.kind === 'bad_request', what);
  }
  const sel = S.makeSeller({}); const tr = S.stubTransport(sel.script);
  try { const out = await lintRoute.makeEntries({ now: () => FIXED })[0].run({ url: URL_, method: 'get' }); assert.equal(out.verdict, 'valid'); assert.equal(out.checked_at, new Date(FIXED).toISOString()); } finally { tr.restore(); }
});
test('no text a customer reads contains a person\'s name, a start date, advice to trade, "rug" or a promise (rubric, descriptions, every check detail and reason produced by these tests)', async () => {
  const banned = [/\brug/i, /guarantee/i, /\b(buy|sell|hold)\b/i, /\bsince\b/i, /\b(20\d\d)-\d\d-\d\d\b/];
  const texts = [];
  for (const c of R.CHECKS) texts.push(c.title, c.tests);
  texts.push(lintRoute.DESC, require('../tools/r23/x402-test').DESC, lintRoute.entries[0].question, require('../tools/r23/x402-test').entries[0].question);
  for (const sc of [{}, { version: 1 }, { unpaid: () => resp(200, '{}') }, { unpaid: () => resp(401, '') }, { unpaid: v2((ch) => { ch.accepts[0].payTo = 'x'; delete ch.resource.description; }) }]) {
    const { out } = await lint(sc); for (const c of out.checks) texts.push(c.detail);
  }
  assert.ok(texts.length > 80);
  for (const t of texts) for (const re of banned) assert.ok(!re.test(t), `${re} in: ${t}`);
  // control: the scan matches a known positive
  assert.ok(banned.some((re) => re.test('a rug pull since 2024-01-01 guaranteed, buy now')));
});

// R23 T3: x402-test, the money path, end to end with NO real funds (31 Oct 2026).
// Real code: lib/safe-fetch.js (over a stubbed socket), the lint, the spend ledger, @x402/fetch's client classes with @x402/evm and @x402/svm, producing REAL signed payloads
// from ephemeral in-memory wallets. Mock: the seller, its stub facilitator (which verifies each payment structurally and independently) and a loopback Solana RPC.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const S = require('./fixtures/r23/x402/seller');
const T = require('../tools/r23/x402/test');
const PAY = require('../tools/r23/x402/pay');
const { makeSpend } = require('../tools/r23/spend');
const { makeEntries } = require('../tools/r23/x402-test');

const URL_ = `https://${S.HOST}${S.PATH}`;
const CAPS = { perCall: 0.05, perDay: 2 };
let rpc; let wallets; const dirs = [];
test.before(async () => { rpc = await S.startSolanaRpc(); wallets = await S.ephemeral(); });
test.after(() => { rpc.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function ledger(caps = { x402test: CAPS }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402pay-')); dirs.push(dir);
  const file = path.join(dir, 'spend.db');
  const spend = makeSpend({ file, caps });
  return { spend, rows: () => { const d = new Database(file, { readonly: true }); try { return d.prepare('SELECT state, usd_reserved, usd_final FROM spend ORDER BY id').all(); } finally { d.close(); } }, close: () => spend.close() };
}
const rich = { base: async () => 10n ** 8n, solana: async () => 10n ** 8n };

/** one run of x402-test against a mock seller. -> { out, err, seller, rows, paid, calls } */
async function scenario(cfg, { args = {}, deps = {}, caps } = {}) {
  const seller = S.makeSeller(cfg);
  const tr = S.stubTransport(seller.script);
  const L = ledger(caps);
  let loads = 0;
  try {
    let out = null; let err = null;
    try { out = await T.runTest({ url: URL_, ...args }, { loadWallets: async () => { loads++; return wallets; }, balance: rich, spend: L.spend, caps: CAPS, solanaRpcUrl: rpc.url, ...deps }); } catch (e) { err = e; }
    const paid = seller.log.filter((l) => l.paid);
    assert.ok(paid.length <= 1, 'a payment is never sent twice');
    return { out, err, seller, rows: L.rows(), paid, calls: tr.calls, loads };
  } finally { tr.restore(); L.close(); }
}
const total = (rows) => rows.filter((r) => r.state === 'settled').reduce((a, r) => a + r.usd_final, 0);

// ---- the good paths: v2 and v1, Base and Solana
for (const [version, chain] of [[2, 'base'], [2, 'solana'], [1, 'base'], [1, 'solana']]) {
  test(`PASS: a good v${version} seller on ${chain}: ONE paid request, settled once at the offer's price, the receipt names the test wallet, the spend is settled`, async () => {
    const r = await scenario({ version, accepts: [S.offer(chain, version)] });
    assert.equal(r.err, null, r.err && r.err.message);
    assert.equal(r.out.verdict, 'PASS', JSON.stringify(r.out.reasons));
    assert.equal(r.paid.length, 1); assert.equal(r.seller.settles.length, 1);
    const w = wallets[chain];
    assert.equal(r.out.payment.payer, w.address); assert.equal(r.out.payment.amount_atomic, '5000'); assert.equal(r.out.payment.amount_usd, 0.005);
    assert.equal(r.out.payment.pay_to, chain === 'base' ? S.PAY_TO_BASE : S.PAY_TO_SOL);
    assert.equal(r.seller.settles[0].accepted.payTo, r.out.payment.pay_to, 'the facilitator was asked to pay the linted payTo');
    assert.equal(r.seller.settles[0].payer.toLowerCase(), w.address.toLowerCase());
    assert.equal(r.out.settlement.success, true); assert.equal(r.out.settlement.payer_is_test_wallet, true); assert.ok(r.out.settlement.transaction);
    assert.deepEqual(r.rows.map((x) => x.state), ['settled']); assert.equal(total(r.rows), 0.005);
    assert.equal(typeof r.out.timing.time_to_402_ms, 'number'); assert.equal(typeof r.out.timing.time_to_paid_response_ms, 'number');
    assert.deepEqual([r.out.response.status, r.out.response.valid_json, r.out.response.json_type], [200, true, 'object']); assert.ok(r.out.response.json_keys.includes('rows'));
    // the paid request: the linted URL, one payment header of the version, redirects off, https only
    const call = r.calls.find((c) => c.opts.headers && (c.opts.headers['PAYMENT-SIGNATURE'] || c.opts.headers['X-PAYMENT']));
    assert.ok(call.opts.headers[version === 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT']); assert.equal(call.url, URL_);
    if (chain === 'solana') assert.ok(rpc.calls.includes('getLatestBlockhash'));
  });
}

test('PASS: a POST endpoint is paid with a POST', async () => {
  const r = await scenario({}, { args: { method: 'POST' } });
  assert.equal(r.out.verdict, 'PASS'); assert.equal(r.paid[0].method, 'POST'); assert.equal(r.out.method, 'POST');
});

// ---- the seller's faults: found, charged (a 200 answer), and nothing paid unless a payment was already sent
const resp = (status, body = '', headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body });
test('FAIL: no 402 at all (the endpoint serves the answer free) -> nothing is paid, nothing reserved', async () => {
  const r = await scenario({ unpaid: () => resp(200, '{"free":true}') });
  assert.equal(r.out.verdict, 'FAIL'); assert.match(r.out.reasons[0], /did not get an x402 challenge.*HTTP 200/); assert.equal(r.paid.length, 0); assert.deepEqual(r.rows, []);
  assert.equal(r.out.lint.verdict, 'no-402'); assert.equal(r.out.payment, null);
});
test('FAIL: a malformed challenge (the price is not an integer string) -> nothing is paid, nothing reserved', async () => {
  const r = await scenario({ accepts: [S.offer('base', 2, { amount: '12.5' })] });
  assert.equal(r.out.verdict, 'FAIL'); assert.match(r.out.reasons.join(' '), /malformed/); assert.equal(r.paid.length, 0); assert.deepEqual(r.rows, []);
  const r2 = await scenario({ accepts: [S.offer('solana', 2, { set: { payTo: 'not-a-solana-address' } })] });
  assert.equal(r2.out.verdict, 'FAIL'); assert.equal(r2.paid.length, 0);
});
test('FAIL: a 402 with nothing readable in it -> nothing is paid', async () => {
  const r = await scenario({ unpaid: () => resp(402, '<html>pay us</html>', { 'content-type': 'text/html' }) });
  assert.equal(r.out.verdict, 'FAIL'); assert.match(r.out.reasons[0], /no x402 requirement can be read/); assert.equal(r.paid.length, 0);
});
test('FAIL: the payTo of the second unpaid answer differs from the one that was linted -> NOTHING is paid, nothing reserved (wrong payTo versus its own earlier answer)', async () => {
  const r = await scenario({ unpaid: (st) => (st.unpaid >= 2 ? S.served(2, [S.offer('base', 2, { set: { payTo: S.PAY_TO_BASE_2 } })]) : undefined), accepts: [S.offer('base', 2)] });
  assert.equal(r.out.verdict, 'FAIL'); assert.match(r.out.reasons[0], /changed between two unpaid requests.*payTo was 0x5555.* is now 0x6666/); assert.equal(r.paid.length, 0); assert.deepEqual(r.rows, []);
  // control: the same seller that does NOT change its payTo is paid (so the FAIL above is the payTo check and nothing else)
  const c = await scenario({ accepts: [S.offer('base', 2)] });
  assert.equal(c.out.verdict, 'PASS');
});
test('FAIL: the amount changes between the two unpaid answers -> nothing is paid', async () => {
  const r = await scenario({ unpaid: (st) => (st.unpaid >= 2 ? S.served(2, [S.offer('base', 2, { amount: 6000 })]) : undefined), accepts: [S.offer('base', 2)] });
  assert.equal(r.out.verdict, 'FAIL'); assert.match(r.out.reasons[0], /amount was 5000 and is now 6000/); assert.equal(r.paid.length, 0);
});
test('FAIL: the second unpaid answer is not a 402 any more -> nothing is paid', async () => {
  const r = await scenario({ unpaid: (st) => (st.unpaid >= 2 ? resp(200, '{}') : undefined) });
  assert.equal(r.out.verdict, 'FAIL'); assert.match(r.out.reasons[0], /answered HTTP 200, not the 402/); assert.equal(r.paid.length, 0);
});
test('FAIL: the unpaid request is redirected -> a payment is never sent across a redirect, nothing is paid', async () => {
  const r = await scenario({ unpaid: () => ({ status: 302, headers: { location: `https://${S.HOST}/other` }, body: '' }), spelling: (st, c) => (c.u.pathname === '/other' ? S.served(2, [S.offer('base', 2)]) : undefined) });
  assert.equal(r.out.verdict, 'FAIL'); assert.match(r.out.reasons[0], /redirected/); assert.equal(r.paid.length, 0); assert.deepEqual(r.rows, []);
});
test('INCONCLUSIVE: the paid request times out -> the payment may have settled, so it is counted as spent; the request was sent once', async () => {
  const r = await scenario({ afterPay: () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) });
  assert.equal(r.out.verdict, 'INCONCLUSIVE'); assert.match(r.out.reasons[0], /may or may not have settled/); assert.equal(r.paid.length, 1);
  assert.deepEqual(r.rows.map((x) => x.state), ['settled']); assert.equal(total(r.rows), 0.005); assert.equal(r.out.payment.sent, true);
});
test('FAIL: a 5xx after payment -> counted as spent; the request is NOT retried (one paid request)', async () => {
  const r = await scenario({ afterPay: () => resp(503, '{"error":"upstream"}') });
  assert.equal(r.out.verdict, 'FAIL'); assert.match(r.out.reasons[0], /HTTP 503 after the payment/); assert.equal(r.paid.length, 1);
  assert.equal(total(r.rows), 0.005); assert.equal(r.seller.settles.length, 0);
});
test('FAIL: a redirect on the paid request -> the payment header goes only to the linted URL; the redirect target is never contacted', async () => {
  const r = await scenario({ afterPay: () => ({ status: 302, headers: { location: 'https://elsewhere.test/steal' }, body: '' }) });
  assert.equal(r.out.verdict, 'FAIL'); assert.match(r.out.reasons[0], /redirect/);
  assert.equal(r.seller.log.filter((l) => l.host === 'elsewhere.test').length, 0, 'elsewhere.test was never contacted');
  assert.equal(r.paid.length, 1);
  const paidCall = r.calls.find((c) => c.opts.headers && c.opts.headers['PAYMENT-SIGNATURE']); assert.equal(paidCall.url, URL_);
});
test('negative control: the SAME paid request through safe-fetch WITHOUT maxRedirects: 0 follows the redirect and hands the payment header to the other host', async () => {
  const seller = S.makeSeller({ afterPay: () => ({ status: 302, headers: { location: 'https://elsewhere.test/steal' }, body: '' }) });
  const tr = S.stubTransport(seller.script);
  try {
    const made = await PAY.createPayment({ challenge: S.challengeV2([S.offer('base', 2)]), offer: { entry: S.offer('base', 2) }, ver: 2, wallets, maxUsd: 0.05 });
    const SF = require('../lib/safe-fetch');
    await SF.safeFetch(URL_, { maxBytes: 1e6, userAgent: 't', httpsOnly: true, acceptStatus: () => true, headers: made.headers });   // the default 3 redirects
    const leaked = seller.log.filter((l) => l.host === 'elsewhere.test' && l.paid);
    assert.equal(leaked.length, 1, 'without maxRedirects: 0 the payment header reaches the other host');
  } finally { tr.restore(); }
});
test('FAIL: the paid answer is 200 but carries no settlement receipt / a failed one / another payer / a malformed transaction', async () => {
  const mk = (rec) => ({ afterPay: (st, c) => (c.verified.ok ? resp(200, '{"ok":true}', rec === null ? {} : { 'payment-response': S.b64(rec(c)) }) : undefined) });
  const cases = [
    ['no receipt', mk(null), /carries no settlement receipt/],
    ['success false', mk((c) => ({ success: false, errorReason: 'insufficient_funds', network: c.verified.accepted.network, payer: c.verified.payer })), /settlement failed/],
    ['another payer', mk((c) => ({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: c.verified.accepted.network, payer: '0x1111111111111111111111111111111111111111' })), /not the test wallet/],
    ['bad transaction', mk((c) => ({ success: true, transaction: '0x12', network: c.verified.accepted.network, payer: c.verified.payer })), /not a transaction hash/],
    ['another network', mk((c) => ({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:137', payer: c.verified.payer })), /names network/],
  ];
  for (const [what, cfg, re] of cases) {
    const r = await scenario({ ...cfg, accepts: [S.offer('base', 2)] });
    assert.equal(r.out.verdict, 'FAIL', what); assert.match(r.out.reasons.join(' '), re, what); assert.equal(r.paid.length, 1, what); assert.equal(total(r.rows), 0.005, `${what}: counted as spent`);
  }
});
test('FAIL: the seller answers the signed payment with a 402 again and a different payTo -> the payment was not settled, the spend is RELEASED', async () => {
  const r = await scenario({ afterPay: () => ({ status: 402, headers: { 'payment-required': S.b64({ ...S.challengeV2([S.offer('base', 2, { set: { payTo: S.PAY_TO_BASE_2 } })]), error: 'swapped' }), 'content-type': 'application/json' }, body: '{}' }), accepts: [S.offer('base', 2)] });
  assert.equal(r.out.verdict, 'FAIL'); assert.match(r.out.reasons.join(' '), /402 again.*swapped/); assert.match(r.out.reasons.join(' '), /payTo for eip155:8453 is now 0x6666/);
  assert.deepEqual(r.rows.map((x) => x.state), ['released']); assert.equal(r.seller.settles.length, 0);
});
test('INCONCLUSIVE: the paid request is refused by the address guard before it is sent (the name now resolves privately) -> released', () => {
  const v = T.judge({ res: null, err: Object.assign(new Error('refused: seller.test resolves to a private or reserved address'), { kind: 'bad_request' }), offer: { network: 'eip155:8453', family: 'evm' }, payer: '0x0', ver: 2 });
  assert.equal(v.verdict, 'INCONCLUSIVE'); assert.equal(v.spend, 'release');
  const v2 = T.judge({ res: null, err: Object.assign(new Error('document is over the 5242880-byte limit'), { kind: 'bad_request' }), offer: {}, payer: '0x0', ver: 2 });
  assert.equal(v2.verdict, 'FAIL'); assert.equal(v2.spend, 'settle');
});

// ---- refusals that are NOT a verdict: not charged
const status = (e) => e && e.status;
test('404 not covered: the cheapest payable offer is over the per-call cap -> nothing reserved or paid', async () => {
  const r = await scenario({ accepts: [S.offer('base', 2, { amount: 60000 })] });
  assert.equal(status(r.err), 404); assert.match(r.err.message, /0\.06 USD, over the 0\.05 USD.*not covered, not charged\.$/); assert.equal(r.paid.length, 0); assert.deepEqual(r.rows, []);
  // control: at exactly the cap it is paid
  const c = await scenario({ accepts: [S.offer('base', 2, { amount: 50000 })] });
  assert.equal(c.out.verdict, 'PASS'); assert.equal(total(c.rows), 0.05);
});
test('404 not covered: the cap is read from X402TEST_PER_CALL_USD (and an unusable value falls back to 0.05)', async () => {
  const seller = S.makeSeller({ accepts: [S.offer('base', 2)] }); const tr = S.stubTransport(seller.script); const L = ledger({ x402test: { perCall: 0.001, perDay: 2 } });
  try {
    const e = await T.runTest({ url: URL_ }, { env: { X402TEST_PER_CALL_USD: '0.001' }, loadWallets: async () => wallets, balance: rich, spend: L.spend }).catch((x) => x);
    assert.equal(e.status, 404); assert.match(e.message, /0\.005 USD, over the 0\.001 USD/);
    assert.deepEqual(T.depsOf({ env: { X402TEST_PER_CALL_USD: 'abc', X402TEST_PER_DAY_USD: '' } }).caps, { perCall: 0.05, perDay: 2 });
  } finally { tr.restore(); L.close(); }
});
test('404 not covered: no Base or Solana option / no exact USDC / a payment flow this test does not make / MPP only', async () => {
  const other = (net, extra = {}) => ({ ...S.offer('base', 2), network: net, ...extra });
  const cases = [
    ['unsupported network', { accepts: [other('eip155:137', { asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' }), other('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k')] }, /no payment on Base or Solana USDC/],
    ['not USDC', { accepts: [S.offer('base', 2, { set: { asset: '0x4200000000000000000000000000000000000006' } })] }, /no exact USDC payment/],
    ['upto scheme', { accepts: [S.offer('base', 2, { set: { scheme: 'upto' } })] }, /no exact USDC payment/],
    ['permit2 flow', { accepts: [S.offer('base', 2, { set: { extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' } } })] }, /payment flow/],
    ['hour-long window', { accepts: [S.offer('base', 2, { set: { maxTimeoutSeconds: 604900 } })] }, /more than an hour/],
    ['MPP only', { unpaid: () => resp(402, '{}', { 'www-authenticate': 'Payment id="x", realm="r", method="tempo"' }) }, /MPP/],
  ];
  for (const [what, cfg, re] of cases) {
    const r = await scenario(cfg);
    assert.equal(status(r.err), 404, `${what}: ${r.err ? r.err.message : JSON.stringify(r.out)}`); assert.match(r.err.message, re, what); assert.equal(r.paid.length, 0, what); assert.deepEqual(r.rows, [], what);
  }
});
test('503 not charged: no wallet files / wallet files refused / no key for the chain the seller accepts -> and no request is made to the seller at all', async () => {
  for (const [what, w, re] of [
    ['not set up', { base: null, solana: null, problems: [] }, /not set up/],
    ['refused', { base: null, solana: null, problems: [{ chain: 'base', reason: 'the address in the key file is a treasury address' }] }, /not usable/],
  ]) {
    const r = await scenario({}, { deps: { loadWallets: async () => w } });
    assert.equal(status(r.err), 503, what); assert.match(r.err.message, re); assert.match(r.err.message, /Not charged\.$/); assert.equal(r.seller.log.length, 0, `${what}: the seller was not contacted`); assert.deepEqual(r.rows, []);
  }
  const r = await scenario({ accepts: [S.offer('solana', 2)] }, { deps: { loadWallets: async () => ({ base: wallets.base, solana: null, problems: [] }) } });
  assert.equal(status(r.err), 503); assert.match(r.err.message, /no key for the chain/); assert.equal(r.paid.length, 0);
});
test('503 not charged: the wallet is unfunded (balance below the price) or the balance read fails -> nothing reserved, nothing paid; a read error is never "unfunded = pass"', async () => {
  let r = await scenario({}, { deps: { balance: { base: async () => 4999n, solana: async () => 0n } } });
  assert.equal(status(r.err), 503); assert.match(r.err.message, /holds less USDC than this endpoint asks for/); assert.equal(r.paid.length, 0); assert.deepEqual(r.rows, []);
  r = await scenario({}, { deps: { balance: { base: async () => 5000n, solana: async () => 0n } } });
  assert.equal(r.out.verdict, 'PASS', 'a balance equal to the price is enough');
  r = await scenario({}, { deps: { balance: { base: async () => { throw new Error('socket hang up'); }, solana: async () => 10n ** 8n } } });
  assert.equal(status(r.err), 503); assert.match(r.err.message, /balance of the test wallet could not be read/); assert.equal(r.paid.length, 0);
  r = await scenario({}, { deps: { balance: { base: async () => { throw Object.assign(new Error('Base rpc down. Not charged.'), { status: 503 }); }, solana: async () => 10n ** 8n } } });
  assert.equal(status(r.err), 503); assert.equal(r.paid.length, 0);
  // a seller that accepts both chains: the unfunded one is skipped, the funded one is paid
  r = await scenario({}, { deps: { balance: { base: async () => 0n, solana: async () => 10n ** 8n } } });
  assert.equal(r.out.verdict, 'PASS'); assert.equal(r.out.payment.network, S.SOL_NET.v2);
});
test('503 not charged: the daily cap is reached / the per-call cap of the ledger is lower -> nothing is signed or paid (reserve comes BEFORE the payment)', async () => {
  const L = ledger({ x402test: { perCall: 0.05, perDay: 0.006 } });
  const seller = S.makeSeller({ accepts: [S.offer('base', 2)] }); const tr = S.stubTransport(seller.script);
  try {
    L.spend.reserve('x402test', 0.002);                        // 0.004 left of 0.006
    let signed = 0;
    const e = await T.runTest({ url: URL_ }, { loadWallets: async () => wallets, balance: rich, spend: L.spend, caps: CAPS, createPayment: async () => { signed++; throw new Error('must not be called'); } }).catch((x) => x);
    assert.equal(e.status, 503); assert.match(e.message, /daily spend cap of 0\.006 USD.*Not charged\.$/); assert.equal(signed, 0, 'no payment was even signed'); assert.equal(seller.log.filter((l) => l.paid).length, 0);
    assert.deepEqual(L.rows().map((x) => x.state), ['reserved'], 'only the earlier reservation exists');
  } finally { tr.restore(); L.close(); }
  const L2 = ledger({ x402test: { perCall: 0.004, perDay: 2 } });
  const tr2 = S.stubTransport(S.makeSeller({ accepts: [S.offer('base', 2)] }).script);
  try {
    const e = await T.runTest({ url: URL_ }, { loadWallets: async () => wallets, balance: rich, spend: L2.spend, caps: CAPS }).catch((x) => x);
    assert.equal(e.status, 503); assert.match(e.message, /per-call cap of 0\.004 USD/); assert.deepEqual(L2.rows(), []);
  } finally { tr2.restore(); L2.close(); }
});
test('daily cap arithmetic: 40 tests at 0.05 fill a 2 USD day, the 41st is refused, and a release gives the money back', async () => {
  const L = ledger({ x402test: CAPS });
  try {
    const ids = []; for (let i = 0; i < 40; i++) ids.push(L.spend.reserve('x402test', 0.05));
    assert.throws(() => L.spend.reserve('x402test', 0.05), (e) => e.status === 503 && /daily spend cap/.test(e.message));
    L.spend.release(ids[0]); assert.doesNotThrow(() => L.spend.reserve('x402test', 0.05));
  } finally { L.close(); }
});
test('503 not charged: a payment that does not pay exactly the linted offer is never sent (the check on the signed payload) and the reservation is released', async () => {
  const seller = S.makeSeller({ accepts: [S.offer('base', 2)] }); const tr = S.stubTransport(seller.script); const L = ledger();
  try {
    // a payment signed for ANOTHER payTo (what a bug or a swapped offer would produce)
    const createPayment = (a) => PAY.createPayment({ ...a, offer: { ...a.offer, entry: { ...a.offer.entry, payTo: S.PAY_TO_BASE_2 } } });
    const e = await T.runTest({ url: URL_ }, { loadWallets: async () => wallets, balance: rich, spend: L.spend, caps: CAPS, createPayment }).catch((x) => x);
    assert.equal(e.status, 503); assert.match(e.message, /payment could not be prepared.*does not accept the linted offer/); assert.equal(seller.log.filter((l) => l.paid).length, 0, 'nothing was sent');
    assert.deepEqual(L.rows().map((x) => x.state), ['released']);
  } finally { tr.restore(); L.close(); }
});
test('400: a bad URL or method is refused before the wallet is read, the seller contacted or anything reserved', async () => {
  for (const [what, args] of [['http', { url: 'http://seller.test/api/data' }], ['loopback', { url: 'https://127.0.0.1/x' }], ['private', { url: 'https://10.1.2.3/x' }], ['metadata', { url: 'https://169.254.169.254/latest' }],
    ['credentials', { url: 'https://u:p@seller.test/x' }], ['port', { url: 'https://seller.test:8443/x' }], ['no url', {}], ['bad method', { url: URL_, method: 'DELETE' }], ['not a url', { url: 'seller' }], ['stray parameter from an unencoded url', { url: 'https://seller.test/api/data?x=1', y: '2' }], ['repeated url', { url: [URL_, URL_] }]]) {
    const r = await scenario({}, { args: { ...args, ...(what === 'no url' ? { url: undefined } : {}) } });
    assert.equal(r.err && r.err.kind, 'bad_request', what); assert.equal(r.loads, 0, `${what}: the wallet was not read`); assert.equal(r.seller.log.length, 0, `${what}: no request`); assert.deepEqual(r.rows, []);
  }
});
// ---- the payload check, directly: a known positive and a tampered payload for every field
test('assertPays: a real payload for the offer passes; each tampered field is refused (EVM and Solana)', async () => {
  const evmOffer = (() => { const e = S.offer('base', 2); return { index: 0, entry: e, scheme: 'exact', network: e.network, family: 'evm', asset: e.asset, payTo: e.payTo, amount: '5000' }; })();
  const solOffer = (() => { const e = S.offer('solana', 2); return { index: 0, entry: e, scheme: 'exact', network: e.network, family: 'solana', asset: e.asset, payTo: e.payTo, amount: '5000' }; })();
  const mk = (offer) => PAY.createPayment({ challenge: S.challengeV2([offer.entry]), offer, ver: 2, wallets, solanaRpcUrl: rpc.url, maxUsd: 0.05 });
  const e = await mk(evmOffer); const s = await mk(solOffer);
  assert.equal(await PAY.assertPays({ payload: e.payload, offer: evmOffer, ver: 2, payer: wallets.base.address }), true, 'known positive: EVM');
  assert.equal(await PAY.assertPays({ payload: s.payload, offer: solOffer, ver: 2, payer: wallets.solana.address }), true, 'known positive: Solana');
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const bads = [
    ['evm: another payTo', async () => { const p = clone(e.payload); p.payload.authorization.to = S.PAY_TO_BASE_2; return PAY.assertPays({ payload: p, offer: evmOffer, ver: 2, payer: wallets.base.address }); }],
    ['evm: another amount', async () => { const p = clone(e.payload); p.payload.authorization.value = '5001'; return PAY.assertPays({ payload: p, offer: evmOffer, ver: 2, payer: wallets.base.address }); }],
    ['evm: another payer', async () => PAY.assertPays({ payload: e.payload, offer: evmOffer, ver: 2, payer: '0x1111111111111111111111111111111111111111' })],
    ['evm: a window longer than the offer', async () => { const p = clone(e.payload); p.payload.authorization.validBefore = String(Math.floor(Date.now() / 1000) + 99999); return PAY.assertPays({ payload: p, offer: evmOffer, ver: 2, payer: wallets.base.address }); }],
    ['evm: accepted is another offer', async () => { const p = clone(e.payload); p.accepted.amount = '1'; return PAY.assertPays({ payload: p, offer: evmOffer, ver: 2, payer: wallets.base.address }); }],
    ['evm: wrong version', async () => PAY.assertPays({ payload: e.payload, offer: evmOffer, ver: 1, payer: wallets.base.address })],
    ['solana: another payTo in the offer', async () => PAY.assertPays({ payload: s.payload, offer: { ...solOffer, payTo: S.PAY_TO_SOL_2 }, ver: 2, payer: wallets.solana.address })],
    ['solana: another amount in the offer', async () => PAY.assertPays({ payload: s.payload, offer: { ...solOffer, amount: '5001' }, ver: 2, payer: wallets.solana.address })],
    ['solana: another payer', async () => PAY.assertPays({ payload: s.payload, offer: solOffer, ver: 2, payer: S.PAY_TO_SOL_2 })],
    ['solana: another fee payer in the offer', async () => PAY.assertPays({ payload: s.payload, offer: { ...solOffer, entry: { ...solOffer.entry, extra: { feePayer: S.PAY_TO_SOL_2 } } }, ver: 2, payer: wallets.solana.address })],
  ];
  for (const [what, fn] of bads) await assert.rejects(fn, /payment check failed/, what);
});

// ---- the route entries
test('makeEntries: the route entry runs the same flow and passes its deps through; the default entry carries no injected dependency', async () => {
  const seller = S.makeSeller({}); const tr = S.stubTransport(seller.script); const L = ledger();
  try {
    const [entry] = makeEntries({ loadWallets: async () => wallets, balance: rich, spend: L.spend, caps: CAPS, solanaRpcUrl: rpc.url });
    assert.equal(entry.name, 'get_x402_test'); assert.equal(entry.route, 'GET /api/x402-test'); assert.equal(entry.usd, 1);
    const out = await entry.run({ url: URL_, method: 'get' });
    assert.equal(out.verdict, 'PASS');
  } finally { tr.restore(); L.close(); }
});

// ---- memory: only the chain that is paid is loaded
test('buildClient registers only the paid chain, and a Base payment in a fresh process loads none of the Solana signing libraries (the Solana path costs tens of MB on first use)', async () => {
  const { spawnSync } = require('child_process');
  const both = PAY.buildClient({ wallets, maxUsd: 0.05 }).client;
  const nets = (c) => [...c.registeredClientSchemes.values()].flatMap((m) => [...m.keys()]).sort();
  assert.deepEqual(nets(both), ['base', 'eip155:8453', 'solana', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']);
  assert.deepEqual(nets(PAY.buildClient({ wallets, chain: 'base', maxUsd: 0.05 }).client), ['base', 'eip155:8453']);
  assert.deepEqual(nets(PAY.buildClient({ wallets, chain: 'solana', maxUsd: 0.05, solanaRpcUrl: rpc.url }).client), ['solana', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']);
  const probe = (chain) => `
    const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts'); const P = require(${JSON.stringify(path.join(__dirname, '..', 'tools/r23/x402/pay.js'))});
    const acct = privateKeyToAccount(generatePrivateKey());
    const entry = { scheme: 'exact', network: 'eip155:8453', amount: '5000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x' + '55'.repeat(20), maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } };
    ${chain === 'control' ? "require('@x402/svm/exact/client');" : ''}
    P.createPayment({ challenge: { x402Version: 2, resource: { url: 'https://a.test/x' } }, offer: { entry }, ver: 2, wallets: { base: { signer: acct }, solana: { signer: {} } }, chain: 'base', maxUsd: 0.05 })
      .then(() => process.stdout.write(JSON.stringify(Object.keys(require.cache).filter((k) => /svm[/\\\\]dist[/\\\\]cjs[/\\\\]exact[/\\\\]client/.test(k)).length)));`;
  const run = (c) => spawnSync(process.execPath, ['-e', probe(c)], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const ctl = run('control'); assert.equal(ctl.status, 0, ctl.stderr); assert.ok(Number(ctl.stdout) >= 1, 'known positive: the cache search finds the Solana client when it is required');
  const base = run('base'); assert.equal(base.status, 0, base.stderr); assert.equal(Number(base.stdout), 0, 'a Base payment loads no Solana signing library');
});
test('X402TEST_CHAINS switches a chain off: a Solana-only seller is then a 503 "no key for the chain" and nothing is paid', async () => {
  const r = await scenario({ accepts: [S.offer('solana', 2)] }, { deps: { env: { X402TEST_CHAINS: 'base' } } });
  assert.equal(r.err.status, 503); assert.match(r.err.message, /no key for the chain/); assert.equal(r.paid.length, 0);
  const ok = await scenario({ accepts: [S.offer('base', 2)] }, { deps: { env: { X402TEST_CHAINS: 'Base , ' } } });
  assert.equal(ok.out.verdict, 'PASS');
});
test('the route hands the payment library the chain of the offer it pays (so only that chain\'s libraries are loaded)', async () => {
  for (const chain of ['base', 'solana']) {
    const seen = [];
    const r = await scenario({ accepts: [S.offer(chain, 2)] }, { deps: { createPayment: async (a) => { seen.push(a.chain); return PAY.createPayment(a); } } });
    assert.equal(r.out.verdict, 'PASS'); assert.deepEqual(seen, [chain]);
  }
});

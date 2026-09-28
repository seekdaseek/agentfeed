// test/refusals.test.js — lib/refusals.js: a payment that is presented and still
// answered 402 is ONE payment_refused row carrying the reason; an unpaid
// challenge writes nothing.
//
// Mounts the REAL recorder in front of a stand-in for the two payment layers
// that answers the way they do (@x402/express 2.17.0 and mpp/index.js: which
// header or body carries the reason), and drives it over a real HTTP socket.
//
// Run:  node --test test/refusals.test.js        (from the service root)

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { makeRefusalRecorder, _scrub: scrub } = require('../lib/refusals');

const PRICES = {
  'GET /api/priced': { usd: 0.01, tool: 'get_priced', desc: 'priced' },
  'GET /api/priced-param/:id': { usd: 0.02, tool: 'get_priced_param', desc: 'priced param' },
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const EVM_FROM = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const MPP_SOURCE = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const evmPayment = b64({
  x402Version: 2,
  accepted: { scheme: 'exact', network: 'eip155:8453' },
  payload: { signature: `0x${'ab'.repeat(65)}`, authorization: { from: EVM_FROM, value: '10000' } },
});

// mode decides how the stand-in payment layer answers a PRESENTED payment
async function run(mode, { path = '/api/priced', headers = {} } = {}) {
  const rows = [];
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '203.0.113.7'; next(); });
  app.use(makeRefusalRecorder({ logCall: (r) => rows.push(r), PRICES, mppPayer: () => MPP_SOURCE }));
  app.use((req, res, next) => {
    const x402 = req.headers['payment-signature'] || req.headers['x-payment'];
    const mpp = /^payment\s/i.test(req.headers.authorization || '');
    if (!x402 && !mpp) { // the challenge: exactly what an unpaid request gets
      res.status(402).setHeader('PAYMENT-REQUIRED', b64({ x402Version: 2, error: 'Payment required', accepts: [] }));
      return res.json({});
    }
    if (mode === 'accept') return next();
    if (mode === 'mpp') { // mpp/index.js sendProblem()
      res.status(402).setHeader('Content-Type', 'application/problem+json');
      return res.end(JSON.stringify({ type: 'https://paymentauth.org/problems/verification-failed', title: 'Verification Failed', status: 402, detail: 'Payment verification failed: the transfer does not match the challenge, or the transaction is not confirmed.' }));
    }
    if (mode === 'verify') { // payment-error: createPaymentRequiredResponse(..., invalidReason)
      res.status(402).setHeader('PAYMENT-REQUIRED', b64({ x402Version: 2, error: 'invalid_exact_evm_payload_signature', accepts: [] }));
      return res.json({});
    }
    if (mode === 'settle') { // processSettlement failure: createSettlementHeaders(settleResponse)
      res.status(402).setHeader('PAYMENT-RESPONSE', b64({ success: false, errorReason: 'insufficient_funds', payer: EVM_FROM, transaction: '', network: 'eip155:8453' }));
      return res.json({});
    }
    if (mode === 'threw') return res.status(402).json({}); // the catch in paymentMiddleware
    if (mode === 'unread') { // extractPayment() returned null: the plain challenge
      res.status(402).setHeader('PAYMENT-REQUIRED', b64({ x402Version: 2, error: 'Payment required', accepts: [] }));
      return res.json({});
    }
    return next();
  });
  app.get('/api/priced', (_req, res) => res.json({ ok: true }));
  app.get('/api/priced-param/:id', (req, res) => res.json({ id: req.params.id }));

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
    await r.text();
    for (let i = 0; i < 20 && !rows.length; i++) await new Promise((w) => setTimeout(w, 10)); // 'finish' can trail the client
    return { status: r.status, rows };
  } finally {
    server.close();
  }
}

test('an unpaid challenge writes no row', async () => {
  const { status, rows } = await run('verify');
  assert.equal(status, 402);
  assert.deepEqual(rows, []);
});

test('x402 verify refusal: one row, the verifier reason, the payer from the authorization', async () => {
  const { status, rows } = await run('verify', { headers: { 'payment-signature': evmPayment, 'user-agent': 'agent/1.0' } });
  assert.equal(status, 402);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.status, 'payment_refused');
  assert.equal(r.tool, 'get_priced');
  assert.equal(r.payer_wallet, EVM_FROM);
  assert.equal(r.error_msg, 'verification refused: invalid_exact_evm_payload_signature');
  assert.equal(r.req_path, '/api/priced');
  assert.equal(r.method, 'GET');
  assert.equal(r.ip, '203.0.113.7');
  assert.equal(r.user_agent, 'agent/1.0');
  assert.equal(r.tx_sig, undefined, 'no signature is recorded');
  assert.ok(!JSON.stringify(r).includes('abababab'), 'no payload is recorded');
});

test('x402 settle refusal: the settlement reason', async () => {
  const { rows } = await run('settle', { headers: { 'payment-signature': evmPayment } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].error_msg, 'settlement refused: insufficient_funds');
});

test('a settlement that threw is still one row, and says it has no reason', async () => {
  const { rows } = await run('threw', { headers: { 'payment-signature': evmPayment } });
  assert.equal(rows.length, 1);
  assert.match(rows[0].error_msg, /^refused with no reason in the response/);
});

test('MPP refusal: the problem+json reason and the credential payer', async () => {
  const { status, rows } = await run('mpp', { headers: { authorization: 'Payment eyJmYWtlIjoxfQ' } });
  assert.equal(status, 402);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payer_wallet, MPP_SOURCE);
  assert.equal(rows[0].error_msg, 'verification-failed: Verification Failed: Payment verification failed: the transfer does not match the challenge, or the transaction is not confirmed.');
});

test('the v1 X-PAYMENT header and a path-parameter route are recognised', async () => {
  const { rows } = await run('verify', { path: '/api/priced-param/abc', headers: { 'x-payment': evmPayment } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'get_priced_param');
});

test('a payment header that is not a payment still records the refusal, payer unknown', async () => {
  const { rows } = await run('verify', { headers: { 'payment-signature': 'not base64 json' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payer_wallet, null);
});

test('the plain challenge answered to an unreadable payment says so', async () => {
  // what @x402/core answers when extractPayment() cannot decode the header
  const { rows } = await run('unread', { headers: { 'payment-signature': 'bm90LWEtcGF5bWVudA==' } });
  assert.equal(rows.length, 1);
  assert.match(rows[0].error_msg, /^verification refused: Payment required \(the payment header was not a decodable x402 v2 PAYMENT-SIGNATURE/);
});

test('a payment that is accepted writes no refusal row', async () => {
  const { status, rows } = await run('accept', { headers: { 'payment-signature': evmPayment } });
  assert.equal(status, 200);
  assert.deepEqual(rows, []);
});

test('a reason never carries a signature, a hash or a payload', () => {
  const sig = '5'.repeat(40) + 'KXy7'.repeat(12);
  assert.equal(scrub(`transaction ${sig} failed`), 'transaction <signature> failed');
  assert.equal(scrub(`tx 0x${'a1'.repeat(32)} reverted`), 'tx <hash> reverted');
  assert.equal(scrub(`payer ${MPP_SOURCE} and ${EVM_FROM}`), `payer ${MPP_SOURCE} and ${EVM_FROM}`, 'addresses are kept');
});

'use strict';
// lib/x402v1.js against a stand-in facilitator: the v1 body, the held response, settle
// only below 400, a failed settle answers 402, and everything not v1 is left alone.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { makeV1 } = require('../lib/x402v1');

const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString());
const V2REQ = { scheme: 'exact', network: SOL, amount: '20000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', maxTimeoutSeconds: 300, extra: { feePayer: 'V2FEEPAYER' } };

function boot({ verify = { isValid: true }, settle = { success: true, transaction: 'TX1', network: 'solana', payer: 'BUYER' }, status = 200 } = {}) {
  const calls = { verify: 0, settle: 0 };
  const v1 = makeV1({ shapeOf: () => 'X-PAYMENT shape' });
  const deps = {
    routes: { 'GET /api/thing': { accepts: [{ scheme: 'exact', network: SOL, price: '$0.02', payTo: V2REQ.payTo }], description: 'a thing', mimeType: 'application/json' } },
    resourceServer: { buildPaymentRequirements: async () => [V2REQ] },
    facilitator: {
      getSupported: async () => ({ kinds: [{ x402Version: 1, scheme: 'exact', network: 'solana', extra: { feePayer: 'V1FEEPAYER' } }, { x402Version: 1, scheme: 'exact', network: 'base' }] }),
      verify: async () => { calls.verify++; if (verify instanceof Error) throw verify; return verify; },
      settle: async () => { calls.settle++; if (settle instanceof Error) throw settle; return settle; },
    },
  };
  const app = express();
  app.use(v1.challengeBody);
  app.use(v1.payments);
  // stand-in paywall: a v1-verified request passes; anything else gets the plain challenge
  app.use((req, res, next) => {
    if (req.x402v1) return next();
    res.setHeader('PAYMENT-REQUIRED', b64({ x402Version: 2, error: req.x402PlainReason || 'Payment required', resource: { url: 'https://h/api/thing', description: 'a thing', mimeType: 'application/json' }, accepts: [V2REQ, { ...V2REQ, network: 'eip155:42161' }] }));
    res.status(402).json({});
  });
  app.get('/api/thing', (_req, res) => res.status(status).json({ ok: status < 400 }));
  return { app, calls, ready: v1.bind(deps) };
}

async function run(t, opts, headers) {
  const { app, calls, ready } = boot(opts);
  assert.deepStrictEqual(await ready, ['solana', 'base']);
  const srv = app.listen(0); t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/thing`, { headers });
  return { r, calls, body: await r.json() };
}
const V1PAY = { 'X-PAYMENT': b64({ x402Version: 1, scheme: 'exact', network: 'solana', payload: { transaction: 'AA' } }) };

test('a 402 carries the v1 body built from its header, v1 rails only, v1 feePayer', async (t) => {
  const { r, body } = await run(t, {}, {});
  assert.equal(r.status, 402);
  assert.ok(r.headers.get('payment-required'), 'v2 header unchanged');
  assert.equal(body.x402Version, 1);
  assert.deepStrictEqual(body.accepts.map((a) => a.network), ['solana'], 'arbitrum left out');
  assert.equal(body.accepts[0].maxAmountRequired, '20000');
  assert.equal(body.accepts[0].extra.feePayer, 'V1FEEPAYER');
});

test('v1 payment: verified, handler 200, settled once, X-PAYMENT-RESPONSE + PAYMENT-RESPONSE', async (t) => {
  const { r, calls, body } = await run(t, {}, V1PAY);
  assert.equal(r.status, 200);
  assert.deepStrictEqual(body, { ok: true });
  assert.equal(calls.settle, 1);
  assert.equal(unb64(r.headers.get('x-payment-response')).transaction, 'TX1');
  assert.ok(r.headers.get('payment-response'), 'the audit row reads PAYMENT-RESPONSE');
});

test('v1 payment: handler 400 is sent unsettled', async (t) => {
  const { r, calls } = await run(t, { status: 400 }, V1PAY);
  assert.equal(r.status, 400);
  assert.equal(calls.settle, 0);
  assert.equal(r.headers.get('x-payment-response'), null);
});

test('v1 payment: a refused settlement answers 402 with the reason, never the data', async (t) => {
  const { r, body } = await run(t, { settle: { success: false, errorReason: 'insufficient_funds' } }, V1PAY);
  assert.equal(r.status, 402);
  assert.match(body.error, /settlement refused: insufficient_funds/);
  assert.equal(unb64(r.headers.get('x-payment-response')).success, false);
  assert.equal(body.ok, undefined);
});

test('v1 payment: a throwing settle is a 402 too', async (t) => {
  const { r } = await run(t, { settle: new Error('boom') }, V1PAY);
  assert.equal(r.status, 402);
});

test('v1 payment: an invalid one falls through to the challenge with a plain reason', async (t) => {
  const { r, calls, body } = await run(t, { verify: { isValid: false, invalidReason: 'insufficient_funds' } }, V1PAY);
  assert.equal(r.status, 402);
  assert.equal(calls.settle, 0);
  assert.match(unb64(r.headers.get('payment-required')).error, /^x402 v1 verification refused: insufficient_funds/);
  assert.equal(body.x402Version, 1);
});

test('v1 on a network without a v1 kind never reaches the facilitator', async (t) => {
  const { r, calls } = await run(t, {}, { 'X-PAYMENT': b64({ x402Version: 1, scheme: 'exact', network: 'polygon', payload: {} }) });
  assert.equal(r.status, 402);
  assert.equal(calls.verify, 0);
  assert.match(unb64(r.headers.get('payment-required')).error, /v1 is accepted on solana and base only/);
});

test('a v2 PAYMENT-SIGNATURE is not touched by the v1 layer', async (t) => {
  const { r, calls } = await run(t, {}, { 'PAYMENT-SIGNATURE': b64({ x402Version: 2, accepted: V2REQ, payload: {} }) });
  assert.equal(calls.verify, 0);
  assert.equal(unb64(r.headers.get('payment-required')).error, 'Payment required', 'the paywall saw it, not v1');
});

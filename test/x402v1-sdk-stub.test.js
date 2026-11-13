'use strict';
// R27 (13 Nov 2026): the v1 body must come back on the 402 whatever stub body the SDK sends. @x402/express 2.17 to 2.28 send {}; 2.31 sends { error: 'Payment required' } and lib/x402v1.js only acted on {} exactly,
// so on 2.31 the v1 body (x402Version 1 + accepts with maxAmountRequired, which x402-fetch 1.x reads) was gone on all 105 routes (R26).
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { makeV1 } = require('../lib/x402v1');

const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const V2REQ = { scheme: 'exact', network: SOL, amount: '20000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', maxTimeoutSeconds: 300, extra: { feePayer: 'FEEPAYER1', transactionVersions: [0, 1] } };

async function boot(t) {
  const v1 = makeV1({});
  await v1.bind({
    routes: { 'GET /api/thing': { accepts: [{ scheme: 'exact', network: SOL, price: '$0.02', payTo: V2REQ.payTo }], description: 'a thing', mimeType: 'application/json' } },
    resourceServer: { buildPaymentRequirements: async () => [V2REQ] },
    facilitator: { getSupported: async () => ({ kinds: [{ x402Version: 1, scheme: 'exact', network: 'solana', extra: { feePayer: 'V1FEEPAYER' } }] }) },
  });
  const app = express();
  app.use(v1.challengeBody);
  const challenge = (error) => b64({ x402Version: 2, error, resource: { url: 'https://h/api/thing', description: 'a thing', mimeType: 'application/json' }, accepts: [V2REQ] });
  const paywall = (body, withHeader = true, error = 'Payment required') => (_req, res) => { if (withHeader) res.setHeader('PAYMENT-REQUIRED', challenge(error)); res.status(402).json(body); };
  app.get('/empty', paywall({}));                                   // @x402/express 2.17 to 2.28
  app.get('/error-stub', paywall({ error: 'Payment required' }));   // @x402/express 2.31
  app.get('/error-stub-reason', paywall({ error: 'a plain refusal reason' }, true, 'a plain refusal reason'));
  app.get('/other-keys', paywall({ error: 'x', detail: 1 }));       // not the SDK stub: left alone
  app.get('/non-string-error', paywall({ error: { code: 1 } }));    // not the SDK stub: left alone
  app.get('/no-header', paywall({ error: 'settlement_failed' }, false));   // a 402 that is not an x402 challenge: left alone
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
const get = async (base, p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };

test('the v1 body is produced for {} and for the 2.31 stub {error}, and the two bodies are byte for byte the same', async (t) => {
  const base = await boot(t);
  const a = await get(base, '/empty'), b = await get(base, '/error-stub');
  assert.strictEqual(a.status, 402); assert.strictEqual(b.status, 402);
  const j = JSON.parse(b.text);
  assert.strictEqual(j.x402Version, 1); assert.strictEqual(j.error, 'Payment required');
  assert.strictEqual(j.accepts[0].network, 'solana'); assert.strictEqual(j.accepts[0].maxAmountRequired, '20000'); assert.strictEqual(j.accepts[0].payTo, V2REQ.payTo);
  assert.strictEqual(a.text, b.text, 'identical bytes whichever stub the SDK sent');
  assert.ok(b.text.length > 300, `a full v1 body, not the 28-byte stub (${b.text.length} bytes)`);
});

test('the v1 accepts do not carry the v2-only extra.transactionVersions (the v1 body stays what v1 clients have always seen)', async (t) => {
  const base = await boot(t);
  const j = JSON.parse((await get(base, '/error-stub')).text);
  assert.strictEqual(j.accepts[0].extra.feePayer, 'V1FEEPAYER');
  assert.ok(!('transactionVersions' in j.accepts[0].extra), JSON.stringify(j.accepts[0].extra));
});

test('the body error is the one in the PAYMENT-REQUIRED header (a plain refusal reason keeps its text)', async (t) => {
  const base = await boot(t);
  const j = JSON.parse((await get(base, '/error-stub-reason')).text);
  assert.strictEqual(j.x402Version, 1); assert.strictEqual(j.error, 'a plain refusal reason');
});

test('controls: a body with other keys, a non-string error, a 402 without a v2 challenge header and a 200 are left as they are', async (t) => {
  const base = await boot(t);
  assert.deepStrictEqual(JSON.parse((await get(base, '/other-keys')).text), { error: 'x', detail: 1 });
  assert.deepStrictEqual(JSON.parse((await get(base, '/non-string-error')).text), { error: { code: 1 } });
  assert.deepStrictEqual(JSON.parse((await get(base, '/no-header')).text), { error: 'settlement_failed' });
  assert.deepStrictEqual(JSON.parse((await get(base, '/ok')).text), { ok: true });
});

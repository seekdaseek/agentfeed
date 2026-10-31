// tools/r23/x402/example.js: the constructed examples the lead publishes for the two routes (R23 T3). Both are built by the route's own code (assessMain and judge, the same functions the
// routes run) from CANNED answers of an invented seller on a reserved name, api.example.com, with invented payTo, feePayer and wallet addresses that are not a wallet anyone holds.
// Nothing here touches the network. test/r23-x402-lint.test.js checks that these objects have exactly the shape of a real answer.
'use strict';
const L = require('./lint');
const T = require('./test');

const URL_ = 'https://api.example.com/v1/quote';
const PAY_TO_EVM = '0x1a2b3c4d5e1a2b3c4d5e1a2b3c4d5e1a2b3c4d5e';
const PAY_TO_SOL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const FEE_PAYER = 'ComputeBudget111111111111111111111111111111';
const TEST_WALLET_EVM = '0x9f8e7d6c5b9f8e7d6c5b9f8e7d6c5b9f8e7d6c5b';
const TX_EVM = `0x${'ab12'.repeat(16)}`;
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

const challenge = () => ({
  x402Version: 2, error: 'Payment required',
  resource: { url: URL_, description: 'Quote for one trading pair: bid, ask and the time it was taken', mimeType: 'application/json' },
  accepts: [
    { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO_EVM, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
    { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '10000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: PAY_TO_SOL, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } },
  ],
  extensions: { bazaar: { info: { input: { type: 'http', method: 'GET' }, output: { type: 'json' } } } },
});
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

function canned() {
  const res0 = { url: URL_, status: 402, contentType: 'application/json', headers: { 'payment-required': b64(challenge()), 'content-type': 'application/json', 'cache-control': 'no-store' }, body: Buffer.from('{}') };
  const probe = (status) => ({ status, finalUrl: URL_, headers: {}, bodyLen: 0, requested: URL_ });
  return { res0, probes: { head: probe(402), upper: { ...probe(404), requested: URL_.toUpperCase() }, slash: { ...probe(404), requested: `${URL_}/` } } };
}

/** the lint of the invented seller: what GET /api/x402-lint returns for a clean v2 challenge */
function lintExample() {
  const { res0, probes } = canned();
  const a = L.assessMain({ url: URL_, href: URL_, method: 'GET', res0, latencyMs: 142, now: NOW });
  return a.pending.finish(probes).output;
}

/** the paid test of the same seller: what GET /api/x402-test returns when the payment settles */
function testExample() {
  const lint = lintExample();
  const offer = { index: 0, entry: challenge().accepts[0], scheme: 'exact', network: 'eip155:8453', family: 'evm', asset: challenge().accepts[0].asset, payTo: PAY_TO_EVM, amount: '10000', usd: 0.01 };
  const receipt = b64({ success: true, transaction: TX_EVM, network: 'eip155:8453', payer: TEST_WALLET_EVM });
  const body = Buffer.from(JSON.stringify({ pair: 'ETH-USD', bid: 3012.4, ask: 3012.9, at: '2026-10-31T12:00:00Z' }));
  const v = T.judge({ res: { status: 200, contentType: 'application/json', headers: { 'payment-response': receipt }, body }, err: null, offer, payer: TEST_WALLET_EVM, ver: 2 });
  return T.buildResult({ url: URL_, method: 'GET', lint, timing: { time_to_402_ms: lint.raw.latency_ms, time_to_paid_response_ms: 388 }, verdict: v.verdict, reasons: v.reasons, notes: v.notes,
    payment: T.paymentOf({ offer, usd: offer.usd }, TEST_WALLET_EVM, true), response: v.response, settlement: v.settlement });
}

module.exports = { lintExample, testExample, challenge, canned, URL_ };

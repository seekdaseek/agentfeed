// tools/r23/x402-test.js: GET /api/x402-test, one real paid call to an x402 endpoint from AgentFeed's own test wallet (R23 T3, 31 Oct 2026). $1.00 to the caller.
// The seller's price is paid by the test wallet on Base or Solana USDC, never above X402TEST_PER_CALL_USD (default 0.05) and X402TEST_PER_DAY_USD (default 2) a day.
// Logic: tools/r23/x402/test.js. The wallet is made by ops/r23-x402-wallet-gen.mjs; with no wallet, no balance or a spend cap reached the route answers 503 "Not charged".
'use strict';
const { z } = require('zod');
const { runTest, parseArgs, DEFAULT_CAPS } = require('./x402/test');
const EX = require('./x402/example');

const USD = 1;
const NAME = 'get_x402_test';
const ROUTE = 'GET /api/x402-test';

const DESC = `Use when an agent needs proof that an x402 endpoint takes a real payment. Returns PASS, FAIL or INCONCLUSIVE with the receipt after paying it once from our own wallet, up to $${DEFAULT_CAPS.perCall}, in Base or Solana USDC. A 503 or 404 is not charged.`;

/** the route entry; `deps` (fetch, wallets, balances, spend, ...) lets a test inject fakes, the real server passes none */
function makeEntries(deps = {}) {
  return [{
    name: NAME, route: ROUTE, usd: USD,
    tags: ['x402', 'testing', 'settlement', 'developer', 'payments'],
    desc: DESC,
    schema: {
      url: z.string().describe('the x402 endpoint to pay once, URL-encoded: https only, a public host, port 443; the paid request goes to exactly this URL'),
      method: z.enum(['GET', 'POST']).optional().describe('HTTP method to pay with, default GET (a POST is sent with an empty body)'),
    },
    title: 'x402 paid test',
    question: 'Does this x402 endpoint accept a real payment, serve the answer and report the settlement?',
    example: EX.testExample(),
    run: async (args) => runTest(args, deps),
  }];
}

module.exports = { entries: makeEntries(), makeEntries, parseArgs, NAME, ROUTE, USD, DESC };

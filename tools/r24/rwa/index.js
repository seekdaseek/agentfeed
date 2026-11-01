// tools/r24/rwa/index.js: get_rwa_yields ($0.02), GET /api/rwa-yields. R24, item 3.
//
// Realized 7-day and 30-day yields of tokenized treasury and credit products, computed here from the on-chain price each issuer's own documentation names (products.js): no yield figure is
// ever read from an issuer, an aggregator or a data vendor. The prices come from our own Ethereum RPC reads (rpc.js); the old points from our daily snapshots (snapshots.js) where they
// reach back far enough, else from eth_call at the old block. Failure semantics (tools/r23/common.js): a bad `product` is a 400 thrown before any read; an RPC read that fails or cannot be
// trusted, a price outside its plausible band, an oracle whose own update is too old, or an exhausted RPC budget is a 503 "Not charged". Nothing answers 200 with an error inside it.
'use strict';
const { z } = require('zod');
const E = require('./evaluate');
const P = require('./products');
const { buildExample } = require('./example');

const ids = () => E.servedIds().join(', ');

/** the route handler: args.product is one served product id, or absent for all of them */
async function getRwaYields(args = {}, deps = {}) {
  const products = E.pick(args.product);            // 400 before anything is read
  return E.evaluate({ products, deps });
}

const DESC = 'Use when an agent needs the realized 7-day and 30-day yield of tokenized treasury and credit products, computed from issuer on-chain prices. Returns NAV, yields, contract and method. A failed read answers 503, not charged.';

const entries = [
  { name: 'get_rwa_yields', route: 'GET /api/rwa-yields', usd: 0.02,
    tags: ['rwa', 'yield', 'tokenized-treasuries', 'nav', 'onchain', 'ethereum', 'treasury-bills', 'credit', 'research'],
    desc: DESC,
    schema: { product: z.string().optional().describe(`one product id (${ids()}); omit it for every product`) },
    title: 'RWA yields',
    question: 'What annualized yield have tokenized treasury and credit products realized over the last 7 and 30 days, computed from their on-chain prices?',
    example: buildExample(),
    run: (args) => getRwaYields(args || {}) },
];

module.exports = { entries, getRwaYields, DESC, ids, ...P };

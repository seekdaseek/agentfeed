// tools/r24/rwa/reader.js: one product's price at one block, from the register in products.js.
// Reads with eth_call at an explicit block number (old state for the history points). Everything the contract returns is checked before it is believed:
//   - the result is a hex string with the right number of 32-byte words, the price is a positive integer below 2^255 (a Chainlink answer is signed)
//   - a feed's updatedAt is a positive time that is not after the block it was read at
//   - the decimals() of a feed are the ones the register says (checked once an hour per process), because a wrong decimals value is the one error that stays plausible
// Failures are the 503 "Not charged" refusal (unavailable): a read that cannot be trusted is never sold.
'use strict';

const { unavailable } = require('../../r23/common');
const { hex } = require('./rpc');

const SEL_DECIMALS = '0x313ce567';
const SEL_LATEST_ROUND = '0xfeaf968c';
const DECIMALS_OK_MS = 60 * 60 * 1000;
const MAX_INT255 = (1n << 255n) - 1n;

const fail = (p, why, detail) => Object.assign(unavailable(`the on-chain price of ${p.name} could not be read right now (${why})`, 300), { detail: detail || why, product: p.id });

/** a revert is this product's contract answering: name the product, keep the 503 "Not charged" form; every other refusal passes through untouched */
const asProduct = (p) => (e) => { throw e && e.revert ? fail(p, 'the contract call reverted', 'revert') : e; };

function words(res, n) {
  if (typeof res !== 'string' || !/^0x[0-9a-fA-F]*$/.test(res) || res.length !== 2 + 64 * n) return null;
  const out = []; for (let i = 0; i < n; i++) out.push(BigInt('0x' + res.slice(2 + 64 * i, 2 + 64 * (i + 1))));
  return out;
}

/**
 * @param {object} rpc    makeRpc() result
 * @param {object} p      a product from products.js
 * @param {number} block  block number
 * @param {number} blockTs  that block's timestamp
 * @returns {Promise<{raw: bigint, updatedAt: number|null, block: number, blockTs: number}>}
 */
async function readAt(rpc, p, block, blockTs, { archive = false } = {}) {
  const tag = hex(block);
  const n = p.read.kind === 'round' ? 5 : 1;
  const res = await rpc.call('eth_call', [{ to: p.contract, data: p.read.kind === 'round' ? SEL_LATEST_ROUND : p.read.data }, tag], { archive, accept: (r) => words(r, n) !== null }).catch(asProduct(p));
  if (p.read.kind === 'uint') {
    const w = words(res, 1);
    if (!w) throw fail(p, 'unreadable result', 'shape');
    if (w[0] <= 0n || w[0] > MAX_INT255) throw fail(p, 'price is not positive', 'range');
    return { raw: w[0], updatedAt: null, block, blockTs };
  }
  const w = words(res, 5);
  if (!w) throw fail(p, 'unreadable result', 'shape');
  const answer = w[1]; const updatedAt = Number(w[3]);
  if (answer <= 0n || answer > MAX_INT255) throw fail(p, 'price is not positive', 'range');
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0 || updatedAt > blockTs + 60) throw fail(p, 'update time is not valid', 'updatedAt');
  return { raw: answer, updatedAt, block, blockTs };
}

const DECIMALS = new Map();      // product id -> time of the last successful check (at most one entry per product in the register)
async function checkDecimals(rpc, p, block, now = Date.now) {
  if (p.read.kind !== 'round') return;
  if (now() - (DECIMALS.get(p.id) || 0) < DECIMALS_OK_MS) return;
  const res = await rpc.call('eth_call', [{ to: p.contract, data: SEL_DECIMALS }, hex(block)], { accept: (r) => words(r, 1) !== null }).catch(asProduct(p));
  const w = words(res, 1);
  if (!w || w[0] !== BigInt(p.read.decimals)) throw fail(p, 'decimals differ from the register', 'decimals');
  DECIMALS.set(p.id, now());
}

module.exports = { readAt, checkDecimals, words, SEL_DECIMALS, SEL_LATEST_ROUND, _decimalsMemo: DECIMALS };

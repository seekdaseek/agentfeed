// tools/r24/txprecheck/example.js: the constructed example the lead publishes for GET /api/tx-precheck (R24 item 4). It is built by the route's own assessment code (assessSolana, the function the
// route runs) from CANNED facts of an invented transaction: a wallet with invented addresses sets a delegate on its USDC token account for the largest possible amount. Nothing touches the network.
// test/r24-txprecheck-solana.test.js checks that this object has exactly the shape of a real answer.
'use strict';
const crypto = require('crypto');
const K = require('@solana/kit');
const O = require('./sol-ops');
const A = require('./sol-assess');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const invented = (label) => K.getAddressDecoder().decode(crypto.createHash('sha256').update(`r24 txprecheck example ${label}`).digest());
const tokenAccount = (owner, amount, delegate, delegated) => ({
  lamports: 2039280, owner: O.TOKEN, executable: false, space: 165,
  data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { isNative: false, mint: USDC, owner, state: 'initialized', tokenAmount: { amount: String(amount), decimals: 6, uiAmount: amount / 1e6, uiAmountString: String(amount / 1e6) }, ...(delegate ? { delegate, delegatedAmount: { amount: String(delegated), decimals: 6, uiAmount: 0, uiAmountString: '0' } } : {}) } } },
});
const systemAccount = (lamports) => ({ lamports, owner: O.SYSTEM, executable: false, space: 0, data: ['', 'base64'] });

/** what GET /api/tx-precheck returns for that invented transaction */
function build() {
  const wallet = invented('wallet'); const account = invented('token account'); const delegate = invented('delegate');
  const data = Buffer.alloc(9); data[0] = 4; data.writeBigUInt64LE((1n << 64n) - 1n, 1);                    // SPL Token Approve, amount = u64 maximum
  const instructions = [{ index: 0, programId: O.TOKEN, accounts: [account, delegate, wallet], data: Uint8Array.from(data) }];
  const keys = [
    { address: wallet, signer: true, writable: true, loaded: false }, { address: account, signer: false, writable: true, loaded: false },
    { address: delegate, signer: false, writable: false, loaded: false }, { address: O.TOKEN, signer: false, writable: false, loaded: false },
  ];
  const pre = new Map([[wallet, systemAccount(1_500_000_000)], [account, tokenAccount(wallet, 125_500_000)]]);
  const post = new Map([[wallet, systemAccount(1_499_995_000)], [account, tokenAccount(wallet, 125_500_000, delegate, 18446744073709551615n)]]);
  return A.assessSolana({
    d: { version: 'legacy', sizeBytes: 215, signatureCount: 1, lookups: [] }, keys, instructions, topOps: O.topOps(instructions), innerOps: [], inner: [], pre, post,
    sim: { ok: true, err: null, logs: [`Program ${O.TOKEN} invoke [1]`, 'Program log: Instruction: Approve', `Program ${O.TOKEN} consumed 2904 of 200000 compute units`, `Program ${O.TOKEN} success`], unitsConsumed: 2904, fee: 5000, slot: 464000000 },
    preSlot: 464000000, risk: new Map(), at: '2026-11-01T12:00:00.000Z',
  });
}

module.exports = { build };

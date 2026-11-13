// R27 (13 Nov 2026): tools/r23/x402/pay.js assertPays on a Solana VERSION 1 transaction. @solana/kit 8 decodes a v1 message as instructionHeaders + instructionPayloads (no `instructions`), and
// @x402/svm 2.31 builds one when the offer's extra.transactionVersions lists 1 (the field the CDP facilitator's /supported now carries and the 402 now offers). Before R27 assertPays threw
// "msg.instructions is not iterable" on it. Real client, real signed payload, ephemeral wallet, loopback Solana RPC, no funds.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./fixtures/r23/x402/seller');
const PAY = require('../tools/r23/x402/pay');
const K = require('@solana/kit');

let rpc; let wallets;
test.before(async () => { rpc = await S.startSolanaRpc(); wallets = await S.ephemeral(); });
test.after(() => rpc.close());

const solOffer = (extra) => { const e = S.offer('solana', 2); const entry = extra ? { ...e, extra: { ...e.extra, ...extra } } : e; return { index: 0, entry, scheme: 'exact', network: entry.network, family: 'solana', asset: entry.asset, payTo: entry.payTo, amount: '5000' }; };
const mk = (offer) => PAY.createPayment({ challenge: S.challengeV2([offer.entry]), offer, ver: 2, wallets, chain: 'solana', solanaRpcUrl: rpc.url, maxUsd: 0.05 });
const msgOf = (payload) => { const tx = K.getTransactionDecoder().decode(Buffer.from(payload.payload.transaction, 'base64')); return K.getCompiledTransactionMessageDecoder().decode(tx.messageBytes); };

test('control: with the offer as before (no transactionVersions) the client builds a legacy/v0 message, which has `instructions`, and assertPays passes', async () => {
  const offer = solOffer(); const { payload } = await mk(offer);
  const m = msgOf(payload);
  assert.ok(Array.isArray(m.instructions) && !m.instructionHeaders, 'the old shape');
  assert.equal(await PAY.assertPays({ payload, offer, ver: 2, payer: wallets.solana.address }), true);
});

test('a version 1 message (offer extra.transactionVersions [0,1]): the client builds instructionHeaders/instructionPayloads and assertPays passes it', async () => {
  const offer = solOffer({ transactionVersions: [0, 1] }); const { payload } = await mk(offer);
  const m = msgOf(payload);
  assert.equal(m.version, 1, 'the payload really is a version 1 transaction (the test exercises the new shape)');
  assert.ok(!m.instructions && Array.isArray(m.instructionHeaders) && m.instructionHeaders.length === m.instructionPayloads.length);
  assert.equal(await PAY.assertPays({ payload, offer, ver: 2, payer: wallets.solana.address }), true, 'known positive: a real v1 payload for the offer');
});

test('a v1 payload is checked as hard as before: another amount, another payTo, another payer and a foreign instruction are refused', async () => {
  const offer = solOffer({ transactionVersions: [0, 1] }); const { payload } = await mk(offer);
  const refused = (o, p = payload, payer = wallets.solana.address) => assert.rejects(PAY.assertPays({ payload: p, offer: o, ver: 2, payer }), /payment check failed/);
  await refused({ ...offer, amount: '5001', entry: { ...offer.entry, amount: '5001' } }, { ...payload, accepted: { ...offer.entry, amount: '5001' } });
  await refused({ ...offer, payTo: S.offer('solana', 2).payTo.replace(/.$/, (c) => (c === '1' ? '2' : '1')) });
  await refused(offer, payload, (await S.ephemeral()).solana.address);
});

test('instructionsOf: legacy and v1 shapes give the same list, any other shape or a length mismatch is refused (and the refusal is the caller\'s fail)', () => {
  const fail = (m) => { throw new Error(`payment check failed: ${m}`); };
  const legacy = { instructions: [{ programAddressIndex: 3, accountIndices: [0, 1], data: new Uint8Array([12]) }] };
  const v1 = { instructionHeaders: [{ programAccountIndex: 3 }], instructionPayloads: [{ instructionAccountIndices: [0, 1], instructionData: new Uint8Array([12]) }] };
  assert.deepEqual(PAY.instructionsOf(legacy, fail), PAY.instructionsOf(v1, fail));
  assert.throws(() => PAY.instructionsOf({ numInstructions: 1 }, fail), /shape this check does not know/);
  assert.throws(() => PAY.instructionsOf({ instructionHeaders: [{ programAccountIndex: 3 }], instructionPayloads: [] }, fail), /shape this check does not know/);
});

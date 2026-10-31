// tools/r23/x402/pay.js: sign ONE payment for ONE linted offer, check that the signed payload pays exactly that offer, and read the settlement receipt (R23 T3, 31 Oct 2026).
//
// The payment libraries are the real ones: x402Client and x402HTTPClient from @x402/fetch (the same classes its fetch wrapper uses), ExactEvmScheme / ExactSvmScheme and their v1 forms.
// The wrapper itself (wrapFetchWithPayment) is NOT used, on purpose: it re-sends the request on its own (a hook request, a second try when a hook "recovers"), follows redirects with the
// payment header on, and cannot go through lib/safe-fetch.js. Here the caller sends the single paid request through safe-fetch's address and port guard with redirects off.
// Heavy libraries (viem, @solana/kit, @x402/*) are required inside the functions, so a lint alone loads none of them.
'use strict';
const R = require('./rubric');
const P = require('./parse');

/** error text made safe to show: long hex, base58 and base64 runs are removed, so even a library that echoed a payload or a key would not be repeated */
const scrub = (s, n = 160) => P.show(String(s == null ? '' : s).replace(/0x[0-9a-fA-F]{40,}/g, '0x...').replace(/[A-Za-z0-9+/_=-]{60,}/g, '...'), n);

/**
 * an x402Client with ONE chain's scheme registered (the chain of the offer that is paid: `chain`; every chain the wallet holds when none is named), spend-capped
 * (defence in depth: the caller has already filtered the offer by price). Only the libraries of that chain are loaded: the Solana signing path costs tens of MB of RSS on first use.
 */
function buildClient({ wallets, chain, solanaRpcUrl, maxUsd }) {
  const { x402Client, x402HTTPClient } = require('@x402/fetch');
  const client = new x402Client();
  if (wallets.base && (!chain || chain === 'base')) {
    const { ExactEvmScheme } = require('@x402/evm/exact/client');
    const { ExactEvmSchemeV1 } = require('@x402/evm/exact/v1/client');
    client.register(R.PAYABLE.base.v2, new ExactEvmScheme(wallets.base.signer));
    client.registerV1(R.PAYABLE.base.v1, new ExactEvmSchemeV1(wallets.base.signer));
  }
  if (wallets.solana && (!chain || chain === 'solana')) {
    const { ExactSvmScheme } = require('@x402/svm/exact/client');
    const { ExactSvmSchemeV1 } = require('@x402/svm/exact/v1/client');
    const cfg = solanaRpcUrl ? { rpcUrl: solanaRpcUrl } : undefined;
    client.register(R.PAYABLE.solana.v2, new ExactSvmScheme(wallets.solana.signer, cfg));
    client.registerV1(R.PAYABLE.solana.v1, new ExactSvmSchemeV1(wallets.solana.signer, cfg));
  }
  if (maxUsd > 0) client.setSpendControls({ maxAmountPerPayment: maxUsd });
  return { client, http: new x402HTTPClient(client) };
}

/**
 * Sign the payment for `offer` (one normalised offer of the linted challenge) -> { payload, headers, version }.
 * The library is handed a challenge whose accepts[] is ONLY that offer, so it cannot choose another payTo, amount or network.
 */
async function createPayment({ challenge, offer, ver, wallets, chain, solanaRpcUrl, maxUsd }) {
  const { client, http } = buildClient({ wallets, chain, solanaRpcUrl, maxUsd });
  const only = { ...challenge, x402Version: ver, accepts: [offer.entry] };
  const payload = await client.createPaymentPayload(only);
  return { payload, headers: http.encodePaymentSignatureHeader(payload), version: ver };
}

const eqAddr = (family, a, b) => (family === 'evm' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
const sameEntry = (a, b) => JSON.stringify(P.sortKeys(a)) === JSON.stringify(P.sortKeys(b));

/**
 * Check that a signed payload pays exactly the linted offer from exactly this wallet. Throws an Error (no payload text in it) when anything is off, and the caller then sends nothing.
 * EVM: the EIP-3009 authorization names this wallet, the offer's payTo and amount, and expires within the offer's window. Solana: the transaction is decoded and must hold one
 * TransferChecked of the offer's amount of the offer's mint from this wallet's account to the payTo's account, and only compute-budget and memo instructions besides it.
 */
async function assertPays({ payload, offer, ver, payer, now = Date.now }) {
  const fail = (m) => { throw new Error(`payment check failed: ${m}`); };
  if (!payload || payload.x402Version !== ver) fail('wrong protocol version');
  if (ver === 2) { if (!payload.accepted || !sameEntry(payload.accepted, offer.entry)) fail('the payload does not accept the linted offer'); }
  else if (payload.network !== offer.network || payload.scheme !== 'exact') fail('the payload names another network or scheme');
  if (offer.family === 'evm') {
    const a = payload.payload && payload.payload.authorization;
    if (!a || !payload.payload.signature || !/^0x[0-9a-fA-F]{130}$/.test(payload.payload.signature)) fail('no authorization or signature');
    if (!eqAddr('evm', a.from, payer)) fail('the authorization is from another wallet');
    if (!eqAddr('evm', a.to, offer.payTo)) fail('the authorization pays another address');
    if (String(a.value) !== String(offer.amount)) fail('the authorization is for another amount');
    const vb = Number(a.validBefore);
    if (!Number.isFinite(vb) || vb > Math.floor(now() / 1000) + offer.entry.maxTimeoutSeconds + 60) fail('the authorization outlives the offer window');
    return true;
  }
  // Solana
  const K = require('@solana/kit');
  const b64 = payload.payload && payload.payload.transaction;
  if (typeof b64 !== 'string') fail('no transaction');
  const tx = K.getTransactionDecoder().decode(Buffer.from(b64, 'base64'));
  const msg = K.getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = msg.staticAccounts.map(String);
  const feePayer = offer.entry.extra && offer.entry.extra.feePayer;
  if (keys[0] !== feePayer) fail('the fee payer is not the offer\'s');
  if (!tx.signatures[payer]) fail('the transaction is not signed by this wallet');
  if (tx.signatures[feePayer]) fail('the fee payer signature should be left to the facilitator');
  const COMPUTE = 'ComputeBudget111111111111111111111111111111'; const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  const transfers = [];
  for (const ins of msg.instructions) {
    const prog = keys[ins.programAddressIndex];
    if (prog === COMPUTE || prog === MEMO) continue;
    if (prog !== require('./wallet').TOKEN_PROGRAM) fail(`an instruction of program ${P.show(prog, 20)} is not allowed`);
    transfers.push(ins);
  }
  if (transfers.length !== 1) fail('the transaction must hold exactly one token transfer');
  const t = transfers[0]; const d = Buffer.from(t.data || []);
  if (d.length !== 10 || d[0] !== 12) fail('the token instruction is not TransferChecked');
  if (d.readBigUInt64LE(1) !== BigInt(offer.amount)) fail('the transfer is for another amount');
  if (d[9] !== 6) fail('the transfer assumes other decimals than USDC has');
  const [source, mint, dest, auth] = (t.accountIndices || []).map((i) => keys[i]);
  const W = require('./wallet');
  if (mint !== offer.asset) fail('the transfer is of another mint');
  if (auth !== payer) fail('the transfer is not authorised by this wallet');
  if (source !== await W.usdcAta(payer, offer.asset)) fail('the transfer is not from this wallet\'s USDC account');
  if (dest !== await W.usdcAta(offer.payTo, offer.asset)) fail('the transfer is not to the payTo\'s USDC account');
  return true;
}

/** the settlement header of a paid response -> { present, ok, value, why } (v2 PAYMENT-RESPONSE, v1 X-PAYMENT-RESPONSE) */
function readReceipt(headers) {
  const h = headers || {};
  const raw = h['payment-response'] || h['x-payment-response'];
  if (typeof raw !== 'string' || !raw.trim()) return { present: false };
  const d = P.decodeB64Json(raw);
  return d.ok ? { present: true, ok: true, value: d.value } : { present: true, ok: false, why: d.why };
}

/** is the receipt a good one for this offer and wallet? -> { ok, problems[], settlement } */
function checkReceipt(rc, { offer, payer }) {
  const problems = [];
  if (!rc.present) return { ok: false, problems: ['the paid response carries no settlement receipt (PAYMENT-RESPONSE or X-PAYMENT-RESPONSE)'], settlement: null };
  if (!rc.ok) return { ok: false, problems: [`the settlement receipt header is ${rc.why}`], settlement: null };
  const v = rc.value;
  const settlement = { success: v.success === true, transaction: typeof v.transaction === 'string' ? v.transaction : null, network: typeof v.network === 'string' ? v.network : null, payer: typeof v.payer === 'string' ? v.payer : null, payer_is_test_wallet: false };
  if (v.success !== true) problems.push(`the endpoint reports the settlement failed${v.errorReason ? ` (${P.show(v.errorReason, 60)})` : ''}`);
  const tx = settlement.transaction;
  const txOk = tx && (offer.family === 'evm' ? /^0x[0-9a-fA-F]{64}$/.test(tx) : (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(tx) && P.b58Len(tx) === 64));
  if (v.success === true && !txOk) problems.push(tx ? `the settlement transaction ${P.show(tx, 40)} is not a ${offer.family === 'evm' ? 'transaction hash' : 'signature'} of the right shape` : 'the receipt names no transaction');
  const nsame = (() => { const a = require('./lint').netInfo(settlement.network); const b = require('./lint').netInfo(offer.network); return Boolean(a.caip2) && a.caip2 === b.caip2; })();
  if (settlement.network && !nsame) problems.push(`the receipt names network ${P.show(settlement.network, 40)}, not ${P.show(offer.network, 40)}`);
  if (!settlement.network) problems.push('the receipt names no network');
  if (settlement.payer) {
    settlement.payer_is_test_wallet = eqAddr(offer.family, settlement.payer, payer);
    if (!settlement.payer_is_test_wallet) problems.push(`the receipt names payer ${P.show(settlement.payer, 50)}, not the test wallet`);
  } else problems.push('the receipt names no payer');
  return { ok: problems.length === 0, problems, settlement };
}

module.exports = { buildClient, createPayment, assertPays, readReceipt, checkReceipt, scrub };

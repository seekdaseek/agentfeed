// test/fixtures/r23/x402/seller.js: a mock x402 seller for the R23 T3 tests (R23, 31 Oct 2026).
//
// The seller is a `script(url, opts)` behind a STUBBED https.request / http.request, so the code under test runs the REAL lib/safe-fetch.js (checkUrl, httpsOnly, redirect handling,
// maxRedirects, acceptStatus, header and byte handling) and only the socket is fake. It answers like a seller: a 402 challenge (v2 header or v1 body), and for a paid request it checks the
// payment STRUCTURALLY with its own, independent code (EIP-3009: the signature is recovered and must be the `from`; Solana: the transaction is decoded, the transfer, the destination
// account derived with @solana-program/token and the wallet's ed25519 signature verified), settles through an in-process stub facilitator and answers 200 with a settlement receipt.
// Every addresses here is an invented fixture; no real wallet, key or network is touched. Wallets are created in memory per test (ephemeral()).
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const nodeModule = require('module');

const P = require('../../../../tools/r23/x402/parse');

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
const HOST = 'seller.test';
const PATH = '/api/data';
const BASE_NET = { v2: 'eip155:8453', v1: 'base' };
const SOL_NET = { v2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', v1: 'solana' };
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAY_TO_BASE = '0x5555555555555555555555555555555555555555';
const PAY_TO_BASE_2 = '0x6666666666666666666666666666666666666666';
const PAY_TO_SOL = 'ComputeBudget111111111111111111111111111111';
const PAY_TO_SOL_2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const FEE_PAYER = 'DN3L5t4cfHdzLDprZN2QdBuqEKyFumsVquYeRY42mh2T';   // an invented fee payer address (any valid public key)
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// ---- the stubbed transport
function fakeRes(status, headers = {}, body = '') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const r = Readable.from(buf.length ? [buf] : []);
  r.statusCode = status;
  r.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return r;
}
/** replace https.request and http.request with a stub; script(u, opts) -> fake response | Error | Promise of one. -> { calls, restore } */
function stubTransport(script) {
  const calls = []; const real = { https: https.request, http: http.request };
  const stub = (u, opts, cb) => {
    calls.push({ url: String(u.href || u), opts });
    const req = new EventEmitter();
    req.end = () => setImmediate(() => Promise.resolve().then(() => script(u, opts)).then((out) => { if (out instanceof Error) req.emit('error', out); else cb(out); }, (e) => req.emit('error', e)));
    req.destroy = (e) => req.emit('error', e);
    return req;
  };
  https.request = stub; http.request = stub;
  return { calls, restore() { https.request = real.https; http.request = real.http; } };
}

// ---- wallets, in memory only
async function ephemeral() {
  const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
  const K = require('@solana/kit');
  const { toClientSvmSigner } = require('@x402/svm');
  const acct = privateKeyToAccount(generatePrivateKey());
  const kp = await K.generateKeyPairSigner();
  return { base: { chain: 'base', address: acct.address, signer: acct }, solana: { chain: 'solana', address: kp.address, signer: toClientSvmSigner(kp) }, problems: [] };
}

// ---- challenges
/** one served accepts[] entry in the shape of the version */
function offer(chain, version, o = {}) {
  const base = chain === 'base';
  const net = (base ? BASE_NET : SOL_NET)[`v${version}`];
  const amount = String(o.amount === undefined ? 5000 : o.amount);
  const e = { scheme: 'exact', network: net, ...(version === 1 ? { maxAmountRequired: amount, resource: `https://${HOST}${PATH}`, description: 'Fixture data for tests', mimeType: 'application/json' } : { amount }),
    asset: base ? USDC_BASE : USDC_SOL, payTo: base ? PAY_TO_BASE : PAY_TO_SOL, maxTimeoutSeconds: 300, extra: base ? { name: 'USD Coin', version: '2' } : { feePayer: FEE_PAYER } };
  return { ...e, ...(o.set || {}) };
}
function challengeV2(accepts) { return { x402Version: 2, error: 'Payment required', resource: { url: `https://${HOST}${PATH}`, description: 'Fixture data for tests', mimeType: 'application/json' }, accepts, extensions: { bazaar: { info: { input: { type: 'http', method: 'GET' } } } } }; }
function challengeV1(accepts) { return { x402Version: 1, error: 'Payment required', accepts }; }
const served = (version, accepts) => (version === 2
  ? { status: 402, headers: { 'payment-required': b64(challengeV2(accepts)), 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{}' }
  : { status: 402, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(challengeV1(accepts)) });

// ---- the structural payment check (independent of tools/r23/x402/pay.js)
const AUTH_TYPES = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
const chainIdOf = (net) => (net === 'base' ? 8453 : Number(String(net).split(':')[1]));

async function verifyEvm({ authorization: a, signature }, req, now) {
  if (!a || !signature) return { ok: false, why: 'no authorization' };
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { ok: false, why: 'authorization pays another address' };
  if (String(a.value) !== String(req.amount)) return { ok: false, why: 'authorization is for another amount' };
  if (!(Number(a.validBefore) > Math.floor(now / 1000))) return { ok: false, why: 'authorization expired' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return { ok: false, why: 'bad nonce' };
  const { recoverTypedDataAddress } = require('viem');
  const recovered = await recoverTypedDataAddress({ domain: { name: req.extra.name, version: req.extra.version, chainId: chainIdOf(req.network), verifyingContract: req.asset }, types: AUTH_TYPES, primaryType: 'TransferWithAuthorization',
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce }, signature });
  if (recovered.toLowerCase() !== a.from.toLowerCase()) return { ok: false, why: 'signature is not the from address\'s' };
  return { ok: true, payer: a.from };
}
async function verifySvm({ transaction }, req) {
  const K = require('@solana/kit');
  const req2 = nodeModule.createRequire(require.resolve('@x402/svm'));
  const { findAssociatedTokenPda } = req2('@solana-program/token');
  const tx = K.getTransactionDecoder().decode(Buffer.from(transaction, 'base64'));
  const msg = K.getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = msg.staticAccounts.map(String);
  if (keys[0] !== req.extra.feePayer) return { ok: false, why: 'fee payer differs' };
  const tIns = msg.instructions.filter((i) => keys[i.programAddressIndex] === TOKEN);
  if (tIns.length !== 1) return { ok: false, why: 'not exactly one token instruction' };
  const d = Buffer.from(tIns[0].data);
  const [src, mint, dest, auth] = tIns[0].accountIndices.map((i) => keys[i]);
  if (d[0] !== 12 || d.readBigUInt64LE(1) !== BigInt(req.amount)) return { ok: false, why: 'transfer amount differs' };
  if (mint !== req.asset) return { ok: false, why: 'mint differs' };
  const [want] = await findAssociatedTokenPda({ mint: req.asset, owner: req.payTo, tokenProgram: TOKEN });
  if (dest !== want) return { ok: false, why: 'destination differs' };
  const [wantSrc] = await findAssociatedTokenPda({ mint: req.asset, owner: auth, tokenProgram: TOKEN });
  if (src !== wantSrc) return { ok: false, why: 'source is not the authority\'s account' };
  const sig = tx.signatures[auth];
  if (!sig) return { ok: false, why: 'authority did not sign' };
  const pubRaw = Buffer.from(K.getAddressEncoder().encode(auth));
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubRaw]), format: 'der', type: 'spki' });
  if (!crypto.verify(null, Buffer.from(tx.messageBytes), key, Buffer.from(sig))) return { ok: false, why: 'signature does not verify' };
  return { ok: true, payer: auth };
}
/** headerValue -> { ok, why, payer, accepted } for a seller that serves `accepts` in `version` */
async function verifyPayment(headerValue, version, accepts, now = Date.now()) {
  let p;
  try { p = unb64(headerValue); } catch { return { ok: false, why: 'header is not base64 JSON' }; }
  if (p.x402Version !== version) return { ok: false, why: 'wrong x402Version' };
  let req;
  if (version === 2) {
    req = accepts.find((a) => JSON.stringify(P.sortKeys(a)) === JSON.stringify(P.sortKeys(p.accepted || {})));
    if (!req) return { ok: false, why: 'accepted is not an offered entry' };
  } else {
    req = accepts.find((a) => a.network === p.network && a.scheme === p.scheme);
    if (!req) return { ok: false, why: 'network and scheme are not offered' };
    req = { ...req, amount: req.maxAmountRequired };
  }
  const evm = /^0x/.test(req.payTo);
  const v = evm ? await verifyEvm(p.payload, req, now) : await verifySvm(p.payload, req);
  return v.ok ? { ...v, accepted: req } : v;
}

// ---- the seller
const txOf = (evm) => (evm ? `0x${crypto.randomBytes(32).toString('hex')}` : require('@solana/kit').getBase58Decoder().decode(crypto.randomBytes(64)));

/**
 * cfg: version (2|1), accepts (served entries; default Base and Solana, 5000 atomic), now,
 *   unpaid(state, ctx) -> response parts | undefined   override the answer to an unpaid request at the canonical path (default: the 402)
 *   afterPay(state, ctx) -> response parts | Error     override the answer to a request that carries a payment header; ctx.verified is the structural verdict
 *   spelling(state, ctx) -> response parts | undefined override HEAD and path spellings (default: HEAD 402, other spellings 404)
 *   other(u, opts) -> response parts | Error            what any other host answers (redirect targets)
 *   facilitator: { settle(accepted, payer) } (default: records and succeeds)
 * A response parts object is { status, headers, body }.
 */
function makeSeller(cfg = {}) {
  const version = cfg.version || 2;
  const host = cfg.host || HOST;
  const accepts = cfg.accepts || [offer('base', version), offer('solana', version)];
  const log = []; const settles = [];
  const state = { unpaid: 0, paid: 0, version, accepts, host };
  const facilitator = cfg.facilitator || { settle: (accepted, payer) => { const evm = /^0x/.test(accepted.payTo); const rec = { success: true, transaction: txOf(evm), network: accepted.network, payer }; settles.push({ accepted, payer, rec }); return rec; } };
  const toRes = (r) => (r instanceof Error ? r : fakeRes(r.status, r.headers || {}, r.body === undefined ? '' : r.body));
  const script = async (u, opts) => {
    const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const payHeader = headers['payment-signature'] || headers['x-payment'];
    log.push({ method: opts.method, url: u.href, host: u.host, path: u.pathname, paid: Boolean(payHeader), payHeader, headers });
    if (u.host !== host) return toRes(cfg.other ? cfg.other(u, opts) : { status: 404, body: 'elsewhere' });
    if (u.pathname !== PATH || opts.method === 'HEAD') {
      const s = cfg.spelling && cfg.spelling(state, { u, opts, headers });
      if (s) return toRes(s);
      return toRes(opts.method === 'HEAD' && u.pathname === PATH ? { status: 402, headers: served(version, accepts).headers } : { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' });
    }
    if (!payHeader) {
      state.unpaid++;
      const o = cfg.unpaid && cfg.unpaid(state, { u, opts, headers });
      return toRes(o || served(version, accepts));
    }
    state.paid++;
    const verified = await verifyPayment(payHeader, version, accepts, cfg.now ? cfg.now() : Date.now());
    const o = cfg.afterPay && cfg.afterPay(state, { u, opts, headers, verified });
    if (o) return toRes(o);
    if (!verified.ok) return toRes({ status: 402, headers: { 'payment-required': b64({ ...challengeV2(accepts), error: `invalid_payment: ${verified.why}` }), 'content-type': 'application/json' }, body: '{}' });
    const rec = facilitator.settle(verified.accepted, verified.payer);
    const hdr = version === 2 ? 'payment-response' : 'x-payment-response';
    return toRes({ status: 200, headers: { 'content-type': 'application/json', [hdr]: b64(rec) }, body: JSON.stringify({ ok: true, rows: [1, 2, 3], note: 'fixture' }) });
  };
  return { script, log, settles, state, accepts, version };
}

// ---- a mock Solana JSON-RPC for the ExactSvmScheme client (the mint account and a recent blockhash), on loopback
function startSolanaRpc() {
  const K = require('@solana/kit');
  const mint = Buffer.alloc(82); mint.writeBigUInt64LE(1000000n, 36); mint[44] = 6; mint[45] = 1;
  const blockhash = K.getBase58Decoder().decode(Uint8Array.from({ length: 32 }, (_, i) => i + 7));
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body); calls.push(j.method);
      let result = null;
      if (j.method === 'getAccountInfo') result = { context: { slot: 1 }, value: { data: [mint.toString('base64'), 'base64'], executable: false, lamports: 1461600, owner: TOKEN, rentEpoch: 0, space: 82 } };
      else if (j.method === 'getLatestBlockhash') result = { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 1000 } };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() })));
}

module.exports = { b64, unb64, fakeRes, stubTransport, ephemeral, offer, served, challengeV1, challengeV2, makeSeller, verifyPayment, startSolanaRpc, HOST, PATH, BASE_NET, SOL_NET, USDC_BASE, USDC_SOL, PAY_TO_BASE, PAY_TO_BASE_2, PAY_TO_SOL, PAY_TO_SOL_2, FEE_PAYER };

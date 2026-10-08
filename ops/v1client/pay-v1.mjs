// pay-v1.mjs — pay one AgentFeed route with the x402 v1 client, x402-fetch 1.2.0 on
// x402 1.2.0 (the legacy line in coinbase/x402 typescript/packages/legacy), pinned in
// this folder's package.json. It reads the v1 challenge from the 402 BODY and pays with
// X-PAYMENT, exactly as a v1 buyer does; nothing here is AgentFeed code.
//
//   node pay-v1.mjs <url> base   <evm-key-file>       0x + 64 hex, as payer-evm.key
//   node pay-v1.mjs <url> solana <keypair.json>       solana-keygen JSON byte array
//   node pay-v1.mjs <url> <base|solana> --unfunded    fresh key: reaches facilitator
//                                                      verification and fails there
// SVM_RPC_URL (optional) overrides the public mainnet RPC the v1 Solana client builds on.
// Prints status, settlement and a body excerpt. Never prints a key.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { wrapFetchWithPayment, createSigner, decodeXPaymentResponse } from 'x402-fetch';
import { base58 } from '@scure/base';

const [url, network, key] = process.argv.slice(2);
if (!url || !['base', 'solana'].includes(network) || !key) {
  console.error('usage: node pay-v1.mjs <url> <base|solana> <key-file | --unfunded>'); process.exit(1);
}
let secret;
if (key === '--unfunded') {
  secret = network === 'base' ? '0x' + crypto.randomBytes(32).toString('hex') : base58.encode(crypto.randomBytes(32));
} else if (network === 'base') {
  secret = fs.readFileSync(key, 'utf8').trim();
} else {
  secret = base58.encode(Uint8Array.from(JSON.parse(fs.readFileSync(key, 'utf8'))));
}
const signer = await createSigner(network, secret);
console.log('payer:', network === 'base' ? signer.account.address : signer.address, key === '--unfunded' ? '(fresh, never funded)' : '');

const config = process.env.SVM_RPC_URL ? { svmConfig: { rpcUrl: process.env.SVM_RPC_URL } } : undefined;
const pay = wrapFetchWithPayment(fetch, signer, BigInt(0.1 * 1e6), undefined, config);
const res = await pay(url, { method: 'GET' });
console.log('status:', res.status);
const xpr = res.headers.get('x-payment-response');
if (xpr) console.log(res.ok ? 'SETTLED:' : 'settlement:', JSON.stringify(decodeXPaymentResponse(xpr)));
const text = await res.text();
let body; try { body = JSON.parse(text); } catch { body = null; }
if (res.ok) console.log('data:', text.slice(0, 240));
else console.log('refused:', body && body.error ? body.error : text.slice(0, 240), body && body.x402Version ? `(v1 body, ${body.accepts.length} accepts)` : '');

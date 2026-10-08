// test-client-xpayment.mjs — pay an AgentFeed route with a standard x402 v2 Solana
// payment sent under the v1 header name X-PAYMENT, the way the client refused 126
// times in Oct 2026 sent it. Proves the X-PAYMENT alias end to end.
// Usage:
//   node test-client-xpayment.mjs <url> <keypair.json>     pay for real (USDC on mainnet)
//   node test-client-xpayment.mjs <url> --unfunded         fresh never-funded keypair: the payment
//                                                          reaches facilitator verification and fails
//                                                          there, so nothing can be spent
import fs from 'node:fs';
import { createKeyPairSignerFromBytes, generateKeyPairSigner } from '@solana/kit';
import { toClientSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, decodePaymentResponseHeader } from '@x402/core/http';

const [url, key] = process.argv.slice(2);
if (!url || !key) { console.error('usage: node test-client-xpayment.mjs <url> <keypair.json | --unfunded>'); process.exit(1); }
const kp = key === '--unfunded' ? await generateKeyPairSigner() : await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(key, 'utf8'))));
console.log('payer:', kp.address, key === '--unfunded' ? '(fresh, never funded)' : '');
const client = new x402Client().register('solana:*', new ExactSvmScheme(toClientSvmSigner(kp)));

const first = await fetch(url);
console.log('unpaid:', first.status);
const pr = decodePaymentRequiredHeader(first.headers.get('payment-required'));
const payload = await client.createPaymentPayload(pr);
console.log('built x402 v' + payload.x402Version, 'payment on', payload.accepted.network, 'amount', payload.accepted.amount);

const paid = await fetch(url, { headers: { 'X-PAYMENT': encodePaymentSignatureHeader(payload) } });
console.log('with X-PAYMENT:', paid.status);
const settle = paid.headers.get('payment-response') || paid.headers.get('x-payment-response');
if (settle) console.log('SETTLED:', JSON.stringify(decodePaymentResponseHeader(settle)));
else {
  const again = paid.headers.get('payment-required');
  console.log('not settled; reason:', again ? decodePaymentRequiredHeader(again).error : '(none)');
}
if (paid.ok) console.log('data:', JSON.stringify(await paid.json()).slice(0, 300));

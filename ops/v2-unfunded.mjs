// ops/v2-unfunded.mjs — the real v2 client (@x402/fetch, as the service's own test-client.mjs)
// with a fresh never-funded Solana key: proves a v2 buyer still pays the v2 way
// (PAYMENT-SIGNATURE, x402Version 2) and reaches facilitator verification.
import { generateKeyPairSigner } from '@solana/kit';
import { toClientSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { decodePaymentRequiredHeader } from '@x402/core/http';
const url = process.argv[2];
const kp = await generateKeyPairSigner();
let sentHeaders = null;
const spy = (input, init) => { const h = input instanceof Request ? input.headers : init && init.headers; if (h) sentHeaders = h; return fetch(input, init); };
const pay = wrapFetchWithPaymentFromConfig(spy, { schemes: [{ network: 'solana:*', client: new ExactSvmScheme(toClientSvmSigner(kp)) }] });
const res = await pay(url).catch((e) => ({ status: 'client threw', e }));
const h = sentHeaders ? Object.fromEntries((sentHeaders instanceof Headers ? [...sentHeaders] : Object.entries(sentHeaders)).map(([k, v]) => [k.toLowerCase(), v])) : {};
const sig = h['payment-signature'];
console.log('v2 client sent:', sig ? `PAYMENT-SIGNATURE x402Version=${JSON.parse(Buffer.from(sig, 'base64')).x402Version}` : 'no PAYMENT-SIGNATURE', h['x-payment'] ? '+ X-PAYMENT' : '');
console.log('status:', res.status, res.e ? res.e.message.slice(0, 200) : '');
if (res.headers) { const pr = res.headers.get('payment-required'); console.log('reason:', pr ? decodePaymentRequiredHeader(pr).error.slice(0, 220) : '(none)'); }

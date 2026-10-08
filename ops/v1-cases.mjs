// ops/v1-cases.mjs <url> — v1 Solana payment built by @x402/svm ExactSvmSchemeV1 from the
// v1 BODY with a fresh never-funded key (reaches facilitator verification, spends
// nothing), plus the malformed shapes. Prints status + the reason the buyer reads.
import { generateKeyPairSigner } from '@solana/kit';
import { toClientSvmSigner } from '@x402/svm';
import { ExactSvmSchemeV1 } from '@x402/svm/exact/v1/client';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
const url = process.argv[2];
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
const first = await fetch(url);
const body = await first.json();
console.log('unpaid:', first.status, 'v1 body', body.x402Version, body.accepts.map((a) => a.network).join(','));
const kp = await generateKeyPairSigner();
const client = new x402Client().registerV1('solana', new ExactSvmSchemeV1(toClientSvmSigner(kp)));
const v1 = await client.createPaymentPayload({ ...body, accepts: body.accepts.filter((a) => a.network === 'solana') });
console.log('built v1 payload: x402Version', v1.x402Version, 'scheme', v1.scheme, 'network', v1.network, 'payload keys', Object.keys(v1.payload).join(','));
const show = async (label, headers) => {
  const r = await fetch(url, { headers });
  const pr = r.headers.get('payment-required');
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  const reason = (pr && decodePaymentRequiredHeader(pr).error) || (j && j.error) || '';
  console.log(`${label.padEnd(34)} -> ${r.status} | ${String(reason).slice(0, 170)}${j && j.x402Version === 1 ? ' | v1 body' : ''}`);
};
await show('v1 solana via X-PAYMENT', { 'X-PAYMENT': b64(v1) });
await show('v1 solana via PAYMENT-SIGNATURE', { 'PAYMENT-SIGNATURE': b64(v1) });
await show('v1 on polygon', { 'X-PAYMENT': b64({ ...v1, network: 'polygon' }) });
await show('v1 missing payload', { 'X-PAYMENT': b64({ x402Version: 1, scheme: 'exact', network: 'base' }) });
await show('X-PAYMENT garbage', { 'X-PAYMENT': 'not-base64-json!!' });
await show('X-PAYMENT x402Version 3', { 'X-PAYMENT': b64({ x402Version: 3 }) });
await show('v2 header, no accepted', { 'PAYMENT-SIGNATURE': b64({ x402Version: 2, payload: { transaction: 'AA' } }) });

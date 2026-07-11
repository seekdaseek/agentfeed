// test-client-evm.mjs — x402 paying client over Base (eip155:8453).
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';

const [url, keyPath] = process.argv.slice(2);
const account = privateKeyToAccount(fs.readFileSync(keyPath, 'utf8').trim());
console.log('payer:', account.address);

const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:*', client: new ExactEvmScheme(account) }],
});

const res = await payFetch(url, { method: 'GET' });
console.log('status:', res.status);
const h = res.headers.get('payment-response') || res.headers.get('x-payment-response');
if (h) { try { console.log('SETTLED:', JSON.stringify(decodePaymentResponseHeader(h), null, 2)); } catch { console.log('settle raw:', h.slice(0,120)); } }
console.log('data:', JSON.stringify(await res.json(), null, 2).slice(0, 400));

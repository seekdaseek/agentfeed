// test-client.mjs — x402 paying client for agentfeed verification.
// Usage:
//   node test-client.mjs <url> <path-to-keypair.json>
//   node test-client.mjs http://localhost:3006/api/sol-price ./payer-wallet.json
// Keypair file: standard solana-keygen JSON byte array (64 bytes).
// The wallet must hold USDC on the network the server is configured for
// (devnet USDC from faucet.circle.com, or real USDC on mainnet).
import fs from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { toClientSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';

const [url, keypairPath] = process.argv.slice(2);
if (!url || !keypairPath) {
  console.error('usage: node test-client.mjs <url> <keypair.json>');
  process.exit(1);
}

const bytes = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const keypair = await createKeyPairSignerFromBytes(bytes);
const signer = toClientSvmSigner(keypair);
console.log('payer:', keypair.address);

const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'solana:*', client: new ExactSvmScheme(signer) }],
});

const t0 = Date.now();
const res = await payFetch(url, { method: 'GET' });
console.log('status:', res.status, `(${Date.now() - t0}ms)`);

const settleHeader = res.headers.get('payment-response') || res.headers.get('x-payment-response');
if (settleHeader) {
  try {
    const settled = decodePaymentResponseHeader(settleHeader);
    console.log('SETTLED:', JSON.stringify(settled, null, 2));
  } catch {
    console.log('settlement header (raw):', settleHeader.slice(0, 120));
  }
} else {
  console.log('no settlement header (free mode or payment not required)');
}

console.log('data:', JSON.stringify(await res.json(), null, 2).slice(0, 600));

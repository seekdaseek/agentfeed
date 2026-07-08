// test-mcp-client.mjs — x402-paying MCP client for agentfeed verification.
// Usage: node test-mcp-client.mjs http://localhost:3006/mcp ./payer-wallet.json
import fs from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { toClientSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { createx402MCPClient } from '@x402/mcp';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, keypairPath] = process.argv.slice(2);
if (!url || !keypairPath) {
  console.error('usage: node test-mcp-client.mjs <mcp-url> <keypair.json>');
  process.exit(1);
}

const bytes = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const signer = toClientSvmSigner(await createKeyPairSignerFromBytes(bytes));
console.log('payer:', signer.address);

const client = createx402MCPClient({
  name: 'agentfeed-test',
  version: '1.0.0',
  schemes: [{ network: 'solana:*', client: new ExactSvmScheme(signer) }],
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => {
    const a = paymentRequired?.accepts?.[0];
    console.log(`payment requested: ${a?.amount} of ${a?.asset?.slice(0, 8)}… on ${a?.network}`);
    return true;
  },
});

const transport = new StreamableHTTPClientTransport(new URL(url));
await client.connect(transport);

console.log('--- tools/list ---');
const tools = await client.listTools();
for (const t of tools.tools) console.log(' ', t.name, '-', (t.description || '').slice(0, 70));

console.log('--- free call: pricing ---');
const pricing = await client.callTool('pricing', {});
console.log((pricing.content?.[0]?.text || '').slice(0, 250));

console.log('--- paid call: get_sol_price ---');
const result = await client.callTool('get_sol_price', {});
console.log('content:', result.content?.[0]?.text);
if (result.paymentMade) {
  console.log('PAYMENT SETTLED:', JSON.stringify(result.paymentResponse, null, 2));
} else {
  console.log('no payment made (free mode or payment skipped)');
}

await client.close();

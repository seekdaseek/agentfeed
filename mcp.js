// mcp.js — Session 3/4: MCP rail. 6 paid tools + 2 free (pricing, fear_greed taster).
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createPaymentWrapper, x402ResourceServer } = require('@x402/mcp');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactSvmScheme } = require('@x402/svm/exact/server');
const { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2 } = require('@x402/svm');
const { logCall } = require('./db');
const { getPrice } = require('./tools/prices');
const { getFunding } = require('./tools/funding');
const { getFearGreed } = require('./tools/feargreed');
const { getWalletHoldings, getTokenMetadata } = require('./tools/onchain');

const TOOL_DEFS = [
  { name: 'get_sol_price', usd: 0.001, desc: 'Live SOL/USD spot price with confidence interval (Pyth oracle).',
    schema: {}, run: () => getPrice('SOL') },
  { name: 'get_btc_price', usd: 0.001, desc: 'Live BTC/USD spot price with confidence interval (Pyth oracle).',
    schema: {}, run: () => getPrice('BTC') },
  { name: 'get_funding_rate', usd: 0.002, desc: 'Current SOL and BTC perp funding rates, mark prices, open interest (Hyperliquid).',
    schema: {}, run: async () => ({ sol: await getFunding('SOL'), btc: await getFunding('BTC') }) },
  { name: 'get_fear_greed', usd: 0, desc: 'Crypto Fear & Greed index (0-100) with classification.',
    schema: {}, run: () => getFearGreed() },
  { name: 'get_market_snapshot', usd: 0.003, desc: 'SOL+BTC prices, funding rates, and Fear & Greed in one call.',
    schema: {}, run: async () => {
      const [sol, btc, fs_, fb, fg] = await Promise.all([
        getPrice('SOL'), getPrice('BTC'), getFunding('SOL'), getFunding('BTC'), getFearGreed()]);
      return { sol, btc, funding: { sol: fs_, btc: fb }, fear_greed: fg };
    } },
  { name: 'get_wallet_holdings', usd: 0.008, desc: 'Solana wallet holdings: native SOL, SPL tokens with USD values, NFT count (Helius DAS).',
    schema: { wallet: z.string().describe('Solana wallet address (base58)') },
    run: (a) => getWalletHoldings(a.wallet) },
  { name: 'get_token_metadata', usd: 0.005, desc: 'SPL token metadata: name, symbol, decimals, supply, price (Helius DAS).',
    schema: { mint: z.string().describe('SPL token mint address (base58)') },
    run: (a) => getTokenMetadata(a.mint) },
];

async function initMcp(app) {
  const networkName = (process.env.X402_NETWORK || 'devnet').toLowerCase();
  const network = networkName === 'mainnet' ? SOLANA_MAINNET_CAIP2 : SOLANA_DEVNET_CAIP2;
  const facilitatorUrl = process.env.FACILITATOR_URL;
  const payTo = process.env.PAY_TO;
  if (!facilitatorUrl || !payTo) throw new Error('FACILITATOR_URL / PAY_TO missing from .env');

  const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
    .register(network, new ExactSvmScheme());
  await rs.initialize();

  const wrappers = {};
  for (const def of TOOL_DEFS) {
    if (!def.usd) continue;
    const accepts = await rs.buildPaymentRequirements({
      scheme: 'exact', network, payTo, price: `$${def.usd}`,
    });
    wrappers[def.name] = createPaymentWrapper(rs, {
      accepts,
      hooks: {
        onAfterSettlement: async ({ toolName, settlement, paymentPayload }) => {
          logCall({
            tool: def.name, status: 'paid',
            payer_wallet: paymentPayload?.payer || settlement?.payer || null,
            tx_sig: settlement?.transaction || null,
            amount_usdc: def.usd,
          });
        },
      },
    });
  }

  function buildServer() {
    const s = new McpServer({ name: 'agentfeed', version: '1.0.0' });
    for (const def of TOOL_DEFS) {
      s.tool(
        def.name,
        def.usd ? `${def.desc} Costs $${def.usd} USDC per call (x402, Solana ${networkName}).` : `${def.desc} Free.`,
        def.schema,
        (def.usd ? wrappers[def.name] : ((h) => h))(async (args) => {
          const data = await def.run(args || {});
          return { content: [{ type: 'text', text: JSON.stringify({ tool: def.name, data }) }] };
        })
      );
    }
    s.tool('pricing', 'Free: list all agentfeed tools with USDC prices.', {}, async () => ({
      content: [{ type: 'text', text: JSON.stringify(
        TOOL_DEFS.map((d) => ({ tool: d.name, price_usdc: d.usd, description: d.desc }))
      ) }],
    }));
    return s;
  }

  app.post('/mcp', express.json(), async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => transport.close());
      const server = buildServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] request failed:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'mcp internal error' });
    }
  });

  console.log(`[mcp] rail active at POST /mcp — 6 paid + 2 free tools (network=${networkName})`);
}

module.exports = { initMcp, TOOL_DEFS };

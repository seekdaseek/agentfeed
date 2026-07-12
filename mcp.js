// mcp.js — Session 3/4: MCP rail. 6 paid tools + 2 free (pricing, fear_greed taster).
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createPaymentWrapper, x402ResourceServer } = require('@x402/mcp');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactSvmScheme } = require('@x402/svm/exact/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2 } = require('@x402/svm');
const { logCall } = require('./db');
const { getPrice } = require('./tools/prices');
const { getFunding } = require('./tools/funding');
const { getFearGreed } = require('./tools/feargreed');
const { getWalletHoldings, getTokenMetadata } = require('./tools/onchain');
const { getRecentLiquidations, getLiquidationStats, getLastLiquidation, getLiquidationLeaders } = require('./tools/liquidations');
const { getCascadeAlert } = require('./tools/cascade');
const { getPositioning } = require('./tools/positioning');
const { getTradeContext } = require('./tools/tradecontext');
const { getTokenRisk } = require('./tools/tokenrisk');

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
  { name: 'get_recent_liquidations', usd: 0.003, desc: 'Recent perp liquidations across Bybit (complete unthrottled tape), OKX and Binance: timestamp, long/short, size, price, USD value. Any USDT perp (~600 symbols), not just majors.',
    schema: { symbol: z.string().optional().describe('SOL, BTC, ETH, XRP, DOGE, or any USDT perp e.g. SXTUSDT (omit for majors)'),
              scope: z.enum(['core', 'all']).optional().describe('core = the 5 majors (default), all = every recorded USDT perp'),
              limit: z.number().optional().describe('max rows, 1-100, default 25'),
              min_usd: z.number().optional().describe('only prints >= this USD size') },
    run: (a) => getRecentLiquidations({ query: a }) },
  { name: 'get_cascade_alert', usd: 0.01, desc: 'Liquidation cascade detector for the 5 majors (SOL, BTC, ETH, XRP, DOGE): returns cascades active NOW - clustered same-side liquidations with symbol, side, USD total, prints, duration, severity (minor/major/extreme). Empty cascades array = no cascade in window. For all ~600 USDT perps across 3 exchanges, use get_cascade_scan.',
    schema: { window: z.number().optional().describe('lookback window seconds, 30-300, default 90'),
              min_events: z.number().optional().describe('min prints to qualify, default 4'),
              min_usd: z.number().optional().describe('min summed USD, default 50000') },
    run: (a) => getCascadeAlert({ query: a }) },
  { name: 'get_cascade_scan', usd: 0.05, desc: 'FULL-UNIVERSE cascade scan: detects liquidation cascades across ~600 USDT perps on Bybit, OKX and Binance simultaneously - not just majors. Bybit is the only complete unthrottled liquidation tape in crypto and no exchange publishes history of it, so this coverage is not available anywhere else. Returns symbol, side, USD total, prints, duration, severity.',
    schema: { window: z.number().optional().describe('lookback window seconds, 30-300, default 90'),
              min_events: z.number().optional().describe('min prints to qualify, default 4'),
              min_usd: z.number().optional().describe('min summed USD, default 50000') },
    run: (a) => getCascadeAlert({ query: { ...a, scope: 'all' } }) },
  { name: 'get_liquidation_leaders', usd: 0.02, desc: 'What is blowing up RIGHT NOW: top symbols ranked by liquidation USD across ~600 USDT perps on Bybit, OKX and Binance. Per symbol: total liquidated, long vs short split, biggest single print, venue count, dominant side. The fastest read on where leverage is being flushed.',
    schema: { window_min: z.number().optional().describe('lookback minutes, 5-1440, default 60'),
              limit: z.number().optional().describe('top N symbols, 1-50, default 10') },
    run: (a) => getLiquidationLeaders({ query: a }) },
  { name: 'get_liquidation_stats', usd: 0.004, desc: 'Liquidation aggregates for the 5 majors (SOL, BTC, ETH, XRP, DOGE): 1h and 24h totals, longs vs shorts USD split, biggest print, broken out per exchange.',
    schema: {}, run: () => getLiquidationStats() },
  { name: 'get_last_liquidation', usd: 0, desc: 'FREE taster: last SOL and BTC liquidation (15-min delayed). Real-time via get_recent_liquidations.',
    schema: {}, run: () => getLastLiquidation() },
  { name: 'get_positioning', usd: 0.004, desc: 'SOL+BTC positioning: long/short account ratio (retail crowding) + open interest with 1h/24h change (Bybit).',
    schema: {}, run: () => getPositioning() },
  { name: 'get_trade_context', usd: 0.01, desc: 'Full market state in one call: SOL+BTC prices, funding, Fear & Greed, long/short positioning, open interest, and liquidation stats. The complete pre-trade picture.',
    schema: {}, run: () => getTradeContext() },
  { name: 'get_token_risk', usd: 0.01, desc: 'SPL token rug-risk signals: mint/freeze authority status (revoked = safer), top-1/top-10 holder concentration, and risk flags. Not a honeypot/LP-lock checker.',
    schema: { mint: z.string().describe('SPL token mint address (base58)') },
    run: (a) => getTokenRisk(a.mint) },
];

async function initMcp(app) {
  const networkName = (process.env.X402_NETWORK || 'devnet').toLowerCase();
  const network = networkName === 'mainnet' ? SOLANA_MAINNET_CAIP2 : SOLANA_DEVNET_CAIP2;
  const facilitatorUrl = process.env.FACILITATOR_URL;
  const payTo = process.env.PAY_TO;
  if (!facilitatorUrl || !payTo) throw new Error('FACILITATOR_URL / PAY_TO missing from .env');

  const facilitatorCfg = facilitatorUrl.includes('api.cdp.coinbase.com')
    ? require('@coinbase/x402').facilitator
    : { url: facilitatorUrl };
  const payToEvm = process.env.PAY_TO_EVM;
  const EVM_NETWORK = 'eip155:8453'; // Base mainnet
  const rs = new x402ResourceServer(new HTTPFacilitatorClient(facilitatorCfg))
    .register(network, new ExactSvmScheme());
  if (payToEvm) rs.register(EVM_NETWORK, new ExactEvmScheme());
  await rs.initialize();

  const wrappers = {};
  for (const def of TOOL_DEFS) {
    if (!def.usd) continue;
    const accepts = await rs.buildPaymentRequirements({
      scheme: 'exact', network, payTo, price: `$${def.usd}`,
    });
    if (payToEvm) {
      const evmAccepts = await rs.buildPaymentRequirements({
        scheme: 'exact', network: EVM_NETWORK, payTo: payToEvm, price: `$${def.usd}`,
      });
      accepts.push(...evmAccepts);
    }
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

  console.log(`[mcp] rail active at POST /mcp — ${TOOL_DEFS.filter(d=>d.usd).length} paid + ${TOOL_DEFS.filter(d=>!d.usd).length} free tools (network=${networkName})`);
}

module.exports = { initMcp, TOOL_DEFS };

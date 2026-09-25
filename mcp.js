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
const { getCascadeForecast, getCascadeForecastFree, getForecastQuestion, getForecastRecord } = require('./tools/cascade-forecast');
const { getPositioning } = require('./tools/positioning');
const { getTradeContext } = require('./tools/tradecontext');
const { getTokenRisk } = require('./tools/tokenrisk');
const { getExitMethod } = require('./tools/overhang');
// challengeDesc and ICON_URL are already exported by payments.js; this only
// reads them. Requiring it adds no side effect -- payments.js's module scope is
// const/function declarations, one Object.assign into PRICES and one try/catch
// that reads bazaar-examples.json -- and server.js already requires it before
// this file loads. No cycle: nothing payments.js pulls requires ./mcp.
const { challengeDesc, ICON_URL } = require('./payments');
const SERVER_VERSION = (() => { try { return require('./server.json').version; } catch { return '1.0.0'; } })();

const TOOL_DEFS = [
  { name: 'get_sol_price', usd: 0.001, desc: 'Live SOL/USD spot price (multi-source: Coinbase, Kraken, Pyth Hermes fallback). The confidence and publish_time fields are null unless Pyth Hermes served the request; Coinbase and Kraken publish neither.',
    schema: {}, run: () => getPrice('SOL') },
  { name: 'get_btc_price', usd: 0.001, desc: 'Live BTC/USD spot price (multi-source: Coinbase, Kraken, Pyth Hermes fallback). The confidence and publish_time fields are null unless Pyth Hermes served the request; Coinbase and Kraken publish neither.',
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
  { name: 'get_recent_liquidations', usd: 0.003, desc: 'Recent perp liquidations across Bybit (complete unthrottled tape), OKX and Binance: timestamp, long/short, size, price, USD value. Any USDT perp we record, not just majors.',
    schema: { symbol: z.string().optional().describe('SOL, BTC, ETH, XRP, DOGE, or any USDT perp e.g. SXTUSDT (omit for majors)'),
              scope: z.enum(['core', 'all']).optional().describe('core = the 5 majors (default), all = every recorded USDT perp'),
              limit: z.number().optional().describe('max rows, 1-100, default 25'),
              min_usd: z.number().optional().describe('only prints >= this USD size') },
    run: (a) => getRecentLiquidations({ query: a }) },
  { name: 'get_cascade_alert', usd: 0.01, desc: 'Liquidation cascade detector for the 5 majors (SOL, BTC, ETH, XRP, DOGE): returns cascades active NOW - clustered same-side liquidations with symbol, side, USD total, prints, duration, severity (minor/major/extreme). Empty cascades array = no cascade in window. For every USDT perp we record across 3 exchanges, use get_cascade_scan.',
    schema: { window: z.number().optional().describe('lookback window seconds, 30-300, default 90'),
              min_events: z.number().optional().describe('min prints to qualify, default 4'),
              min_usd: z.number().optional().describe('min summed USD, default 50000') },
    run: (a) => getCascadeAlert({ query: a }) },
  { name: 'get_cascade_scan', usd: 0.05, desc: 'FULL-UNIVERSE cascade scan: detects liquidation cascades across every USDT perp we record on Bybit, OKX and Binance simultaneously - not just majors. Bybit is the only complete unthrottled liquidation tape in crypto and no exchange publishes history of it, so this coverage is not available anywhere else. Returns symbol, side, USD total, prints, duration, severity.',
    schema: { window: z.number().optional().describe('lookback window seconds, 30-300, default 90'),
              min_events: z.number().optional().describe('min prints to qualify, default 4'),
              min_usd: z.number().optional().describe('min summed USD, default 50000') },
    run: (a) => getCascadeAlert({ query: { ...a, scope: 'all' } }) },

  { name: 'get_cascade_forecast_free', usd: 0, desc: 'FREE taster: the full-quality liquidation forecast for SOL, no delay and nothing withheld. Use it to check the calibration before paying for coverage of the other ~345 symbols.',
    schema: {}, run: () => getCascadeForecastFree() },
  { name: 'get_forecast_question', usd: 0, desc: 'FREE: the exact question the forecast answers, machine readable, plus how to settle it yourself from the public exchange feed and the full list of covered symbols. Read this before building on the forecast.',
    schema: {}, run: () => getForecastQuestion() },
  { name: 'get_forecast_record', usd: 0, desc: 'FREE: the live track record of this miner. Every forecast was written down BEFORE its 15-minute window opened and settled afterwards from the exchange public feed, and the raw rows are returned alongside the score so you can recompute it yourself rather than take it on trust. Returns settled count, base rate, Brier skill against climatology, coverage, calibration error and a reliability curve. A backtest is a claim about the past that its author also chose how to compute; this is not that.',
    schema: { symbol: z.string().optional().describe('restrict the record to one symbol'),
              rows: z.number().optional().describe('how many raw rows to return, max 500, default 50') },
    run: (a) => getForecastRecord({ query: a }) },
  { name: 'get_liquidation_leaders', usd: 0.02, desc: 'What is blowing up RIGHT NOW: top symbols ranked by liquidation USD across every USDT perp we record on Bybit, OKX and Binance. Per symbol: total liquidated, long vs short split, biggest single print, venue count, dominant side. The fastest read on where leverage is being flushed.',
    schema: { window_min: z.number().optional().describe('lookback minutes, 5-1440, default 60'),
              limit: z.number().optional().describe('top N symbols, 1-50, default 10') },
    run: (a) => getLiquidationLeaders({ query: a }) },
  { name: 'get_liquidation_stats', usd: 0.004, desc: 'Liquidation aggregates for the 5 majors (SOL, BTC, ETH, XRP, DOGE): 1h and 24h totals, longs vs shorts USD split, biggest print, broken out per exchange.',
    schema: {}, run: () => getLiquidationStats() },
  { name: 'get_last_liquidation', usd: 0, desc: 'FREE taster: last liquidation for SOL, BTC, ETH, XRP and DOGE (15-min delayed). Real-time via get_recent_liquidations.',
    schema: {}, run: () => getLastLiquidation() },
  { name: 'get_positioning', usd: 0.004, desc: 'SOL+BTC positioning: long/short account ratio (retail crowding) + open interest with 1h/24h change (Bybit).',
    schema: {}, run: () => getPositioning() },
  { name: 'get_trade_context', usd: 0.01, desc: 'Full market state in one call: SOL+BTC prices, funding, Fear & Greed, long/short positioning, open interest, and liquidation stats. The complete pre-trade picture.',
    schema: {}, run: () => getTradeContext() },
  { name: 'get_token_risk', usd: 0.01, desc: 'SPL token rug-risk signals: mint/freeze authority status (revoked = safer), top-1/top-10 holder concentration, and risk flags. Not a honeypot/LP-lock checker.',
    schema: { mint: z.string().describe('SPL token mint address (base58)') },
    run: (a) => getTokenRisk(a.mint) },
  { name: 'get_exit_method', usd: 0, desc: "FREE: how overhang measures exit liquidity on lending collateral, and the counts behind every paid answer - computed from the tape at request time, nothing hardcoded. Returns what is measured (the protocol's own live-refetched mark vs realisable value from sell-direction quotes at real clip sizes), the corroboration rule in plain terms (a terminal verdict needs six consecutive agreeing floor observations from the symbol's own tape; one sample is never enough; a contradicted floor buys a fresh probe rather than writing a hole), the full status vocabulary including why a router refusal and an empty book are different facts, the size-matched control design and its results, the gated sweep and row counts, covered symbols and markets, and the measured cadence. Read this before paying for get_exit_quote, and to check the claim rather than trust it.",
    schema: {}, run: () => getExitMethod() },
];

TOOL_DEFS.push(...require('./expansion').MCP_DEFS_ADD);

// Human titles, two to five words, taken from what each description already
// says. TITLES ONLY -- nothing was renamed. Tool names are the public MCP
// surface and the elizaOS plugin depends on them.
const TOOL_TITLES = {
  get_sol_price: 'SOL spot price', get_btc_price: 'BTC spot price', get_eth_price: 'ETH spot price',
  get_spot: 'Spot price', get_funding_rate: 'SOL and BTC funding', get_fear_greed: 'Fear and Greed index',
  get_market_snapshot: 'Market snapshot', get_trade_context: 'Trade context', get_positioning: 'SOL and BTC positioning',
  get_perp: 'Perp snapshot', get_liq_pulse: 'Liquidation pulse', get_funding_pulse: 'Funding pulse',
  get_wallet_holdings: 'Solana wallet holdings', get_wallet_activity: 'Solana wallet activity',
  get_token_metadata: 'SPL token metadata', get_token_risk: 'Token rug check', get_token_holders: 'Top token holders',
  get_recent_liquidations: 'Recent liquidations', get_last_liquidation: 'Last liquidation',
  get_liquidation_stats: 'Liquidation stats', get_liquidation_leaders: 'Liquidation leaderboard',
  get_liq_history: 'Liquidation history', get_liq_heatmap: 'Liquidation heatmap',
  get_venue_liq_share: 'Liquidations by venue', get_cascade_alert: 'Liquidation cascade alert',
  get_cascade_scan: 'Full universe cascade scan', get_cascade_history: 'Cascade history',
  get_cascade_forecast: 'Liquidation cascade forecast', get_cascade_forecast_free: 'Free cascade forecast',
  get_forecast_question: 'Forecast question spec', get_forecast_record: 'Forecast track record',
  get_squeeze_score: 'Squeeze score', get_funding_cross: 'Cross venue funding',
  get_funding_extremes: 'Funding extremes', get_funding_history: 'Funding history',
  get_open_interest: 'Open interest', get_oi_spike_scan: 'Open interest spikes',
  get_long_short: 'Long short ratio', get_basis: 'Perp spot basis', get_volatility: 'Realized volatility',
  get_top_movers: 'Top movers', get_orderbook_imbalance: 'Orderbook imbalance',
  get_orderbook_walls: 'Orderbook walls', get_whale_trades: 'Whale trades', get_spread_arb: 'Cross exchange spread',
  get_priority_fees: 'Solana priority fees', get_jito_tips: 'Jito tip floor', get_sol_network: 'Solana network health',
  get_tvl: 'Protocol TVL', get_stablecoin_flows: 'Stablecoin flows', get_dex_quote: 'Jupiter DEX quote',
  get_peg_deviation: 'Tokenized stock peg', get_peg_sessions: 'Peg by session', get_peg_universe: 'Tokenized stock rankings',
  get_exit_quote: 'Collateral exit liquidity', get_exit_method: 'Exit liquidity method',
  get_base_gas: 'Base gas price', get_base_balance: 'Base wallet balance',
  pricing: 'Price list',
};

// tools/list order IS registration order, and that is the order Smithery shows.
// It used to open on three price feeds and a sentiment index; these lead now --
// the tape, the entry tier, the forecast. TOOL_DEFS itself is NOT reordered, so
// probe-tools, the manifest, GET / and the pricing tool keep their order.
const DISPLAY_FIRST = [
  'get_liq_pulse', 'get_perp', 'get_funding_pulse', 'get_liquidation_leaders',
  'get_cascade_scan', 'get_liq_heatmap', 'get_squeeze_score', 'get_cascade_forecast_free',
  'get_forecast_record', 'get_cascade_forecast', 'get_open_interest', 'get_funding_cross',
];

// Shown by a client before any tool call. Kept short on purpose.
const INSTRUCTIONS = [
  'AgentFeed serves live crypto market data: a complete Bybit, OKX and Binance liquidation tape, tokenized-equity peg data and Solana on-chain reads.',
  'Free, start here: get_fear_greed, get_last_liquidation, get_cascade_forecast_free, get_forecast_question, get_forecast_record, get_exit_method, pricing.',
  'Cheapest paid calls at $0.001: get_perp, get_liq_pulse, get_funding_pulse, get_spot. Call pricing for the full price list.',
  'A paid tool answers with an x402 payment request, payable in USDC on Solana or Base. No API key.',
  'Same tools as HTTPS endpoints at https://x402.ochinimus.app; see /openapi.json.',
].join(' ');

// ---- MCP tool metadata (Smithery capability checks) ----------------------
//
// Smithery scored this server 82/100 on 2026-09-25, losing every point on
// output schemas (0/14) and annotations (0/14). Both are cheap and true here:
// every tool is a read-only market-data read.
//
// ANNOTATIONS. Identical for all of them, and each flag is a fact about this
// service, not a default copied from a template:
//   readOnlyHint    nothing a tool does mutates state; the only writes are the
//                   audit rows the HTTP layer makes, never the tool itself
//   destructiveHint false, for the same reason
//   idempotentHint  calling twice returns the same answer for the same market
//                   state and charges the same; there is no create-or-append
//   openWorldHint   answers come from live exchanges and chains, not a closed
//                   fixed corpus
const TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

// OUTPUT SCHEMAS. MCP 2025-06-18: a tool that declares outputSchema MUST return
// structuredContent conforming to it, and this SDK ENFORCES that -- mcp.js
// validateToolOutput() throws McpError when the payload does not parse. That
// makes a too-tight schema a live failure on a rail real buyers pay for, so the
// declared shape is the envelope, which cannot drift: `tool` is the name and
// `data` is an object. Every one of the 48 Phase 1 captures has an object
// there (measured, not assumed). The per-field detail an agent needs is in the
// input schema, the description and the free sample at /api/sample/<route>.
const BAZAAR_META = (() => { try { return require('./bazaar-examples.json').routes || {}; } catch { return {}; } })();
const METfByTool = new Map(Object.values(BAZAAR_META).map((m) => [m.tool, m]));
function outputSchemaFor(def) {
  return {
    tool: z.literal(def.name).describe('the tool that produced this payload'),
    data: z.record(z.string(), z.unknown()).describe(
      METfByTool.has(def.name)
        ? `the ${def.name} payload; a real captured example is free at https://x402.ochinimus.app/api/sample/${def.name}`
        : `the ${def.name} payload`,
    ),
  };
}

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
      // Without this the wrapper falls back to "paid_tool": index.js:762 derives
      // the tool name by stripping "mcp://tool/" off resource.url, so every MCP
      // payment request advertised mcp://tool/paid_tool described as
      // "Tool: paid_tool". serviceName and iconUrl are declared on this config
      // in 2.17.0's index.d.ts and copied by buildToolResourceInfo() at runtime.
      resource: {
        url: `mcp://tool/${def.name}`,
        description: challengeDesc(def.desc),
        mimeType: 'application/json',
        serviceName: 'AgentFeed',
        iconUrl: ICON_URL,
      },
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

  // Built from the rails registered on THIS resource server above: Solana
  // always, Base only when PAY_TO_EVM is set. An unpaid tools/call really does
  // return accepts for both, so naming only Solana understated the server to
  // every agent reading tools/list.
  const RAILS = ['Solana' + (networkName === 'mainnet' ? '' : ' ' + networkName)]
    .concat(payToEvm ? ['Base'] : []);
  const RAILS_TEXT = '(x402, USDC on ' + RAILS.join(' or ') + ')';

  function buildServer() {
    const s = new McpServer({
      name: 'agentfeed',
      title: 'AgentFeed',
      version: SERVER_VERSION,
      description: 'Live crypto market data, a complete Bybit/OKX/Binance liquidation tape, tokenized-equity peg data and Solana on-chain reads. Paid per call in USDC over x402, no API key.',
      websiteUrl: 'https://x402.ochinimus.app',
      icons: [{ src: ICON_URL, mimeType: 'image/png' }],
    }, { instructions: INSTRUCTIONS });

    const ordered = DISPLAY_FIRST.map((n) => TOOL_DEFS.find((d) => d.name === n)).filter(Boolean)
      .concat(TOOL_DEFS.filter((d) => !DISPLAY_FIRST.includes(d.name)));
    for (const def of ordered) {
      s.registerTool(
        def.name,
        {
          title: TOOL_TITLES[def.name],
          description: def.usd ? `${def.desc} Costs ${def.usd} USDC per call ${RAILS_TEXT}.` : `${def.desc} Free.`,
          inputSchema: def.schema,
          outputSchema: outputSchemaFor(def),
          annotations: TOOL_ANNOTATIONS,
        },
        (def.usd ? wrappers[def.name] : ((h) => h))(async (args) => {
          const data = await def.run(args || {});
          const payload = { tool: def.name, data };
          // Both, as the spec requires: text for clients that only read content,
          // structuredContent for the declared outputSchema.
          return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
        })
      );
    }
    s.registerTool('pricing', {
      title: TOOL_TITLES.pricing,
      description: 'Use when an agent needs the price list before calling anything. Returns every agentfeed tool with its USDC price and description. Free.',
      inputSchema: {},
      outputSchema: {
        tool: z.literal('pricing').describe('the tool that produced this payload'),
        data: z.record(z.string(), z.unknown()).describe('tools: the full price list'),
      },
      annotations: TOOL_ANNOTATIONS,
    }, async () => {
      const payload = { tool: 'pricing', data: { tools: TOOL_DEFS.map((d) => ({ tool: d.name, price_usdc: d.usd, description: d.desc })) } };
      return { content: [{ type: 'text', text: JSON.stringify(payload.data.tools) }], structuredContent: payload };
    });
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

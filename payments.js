// payments.js — x402 payment layer (Session 2).
// Swappable by design: facilitator via .env, all pricing in one table.
// Verified against @x402/express 2.17.0 + @x402/svm 2.17.0 real APIs.
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { bazaarResourceServerExtension, declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2 } = require('@x402/svm');
const { ExactSvmScheme } = require('@x402/svm/exact/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');

// ---- pricing table: single source of truth (spec §2)
const PRICES = {
  'GET /api/sol-price':                { usd: 0.001, tool: 'get_sol_price',       desc: 'SOL spot price via Pyth' },
  'GET /api/btc-price':                { usd: 0.001, tool: 'get_btc_price',       desc: 'BTC spot price via Pyth' },
  'GET /api/funding-rate':             { usd: 0.002, tool: 'get_funding_rate',    desc: 'SOL+BTC perp funding rates' },
  'GET /api/market-snapshot':          { usd: 0.003, tool: 'get_market_snapshot', desc: 'Full market snapshot in one call' },
  'GET /api/wallet-holdings/:wallet':  { usd: 0.008, tool: 'get_wallet_holdings', desc: 'Solana wallet holdings via Helius DAS' },
  'GET /api/token-metadata/:mint':     { usd: 0.005, tool: 'get_token_metadata',  desc: 'SPL token metadata via Helius DAS' },
  'GET /api/liquidations':             { usd: 0.003, tool: 'get_recent_liquidations', desc: 'Recent liquidations across ~600 USDT perps (Bybit complete tape + OKX + Binance). Any symbol, not just majors; defaults to majors' },
  'GET /api/cascade':                  { usd: 0.01,  tool: 'get_cascade_alert',      desc: 'Liquidation cascade detector for the 5 majors (SOL/BTC/ETH/XRP/DOGE) across Bybit+OKX+Binance. For all ~600 perps use /api/cascade-scan' },
  'GET /api/cascade-scan':             { usd: 0.05,  tool: 'get_cascade_scan',       desc: 'FULL-UNIVERSE cascade scan: ~600 USDT perps across Bybit+OKX+Binance. Bybit is the only complete unthrottled liquidation tape in crypto and no exchange publishes history of it' },
  'GET /api/liquidation-leaders':      { usd: 0.02,  tool: 'get_liquidation_leaders', desc: 'What is blowing up right now: top symbols by liquidation USD across ~600 USDT perps, with long/short split, biggest print and venue count' },
  'GET /api/sharp-move':               { usd: 0.02,  tool: 'get_sharp_move',           desc: 'SHARP MONEY detector for World Cup betting markets: abnormal PRE-MATCH moves in the de-margined consensus win probability (TxODDS StablePrice, anchored on Solana). Threshold = p99.9 of 8.4M real ticks' },
  'GET /api/liquidation-stats':        { usd: 0.004, tool: 'get_liquidation_stats',   desc: '1h/24h liquidation totals for the 5 majors (SOL/BTC/ETH/XRP/DOGE), long/short split, biggest print, per-exchange breakdown' },
  'GET /api/positioning':              { usd: 0.004, tool: 'get_positioning',        desc: 'SOL+BTC long/short account ratio + open interest with 1h/24h OI change' },
  'GET /api/trade-context':            { usd: 0.01,  tool: 'get_trade_context',      desc: 'Full market state in one call: prices, funding, fear/greed, positioning, liquidations' },
  'GET /api/token-risk/:mint':         { usd: 0.01,  tool: 'get_token_risk',         desc: 'Token rug-risk signals: mint/freeze authority status, top-holder concentration, risk flags' },
};

Object.assign(PRICES, require('./expansion').PRICES_ADD);

function buildPaymentLayer() {
  const networkName = (process.env.X402_NETWORK || 'devnet').toLowerCase();
  const network = networkName === 'mainnet' ? SOLANA_MAINNET_CAIP2 : SOLANA_DEVNET_CAIP2;
  const facilitatorUrl = process.env.FACILITATOR_URL || 'https://facilitator.x402.org';
  const payTo = process.env.PAY_TO;
  if (!payTo) throw new Error('PAY_TO missing from .env (treasury address)');

  const facilitator = new HTTPFacilitatorClient(
    facilitatorUrl.includes('api.cdp.coinbase.com')
      ? require('@coinbase/x402').facilitator
      : { url: facilitatorUrl },
  );
  const payToEvm = process.env.PAY_TO_EVM;
  const EVM_NETWORK = 'eip155:8453'; // Base mainnet
  const resourceServer = new x402ResourceServer(facilitator)
    .register(network, new ExactSvmScheme());
  if (payToEvm) resourceServer.register(EVM_NETWORK, new ExactEvmScheme());
  resourceServer
    .registerExtension(bazaarResourceServerExtension);

  const TAGS = {
    get_sol_price:            ['crypto','price','solana','pyth'],
    get_btc_price:            ['crypto','price','bitcoin','pyth'],
    get_funding_rate:         ['funding','perps','crypto','trading'],
    get_market_snapshot:      ['market-data','crypto','trading','snapshot'],
    get_wallet_holdings:      ['solana','wallet','tokens','onchain'],
    get_token_metadata:       ['solana','tokens','metadata','onchain'],
    get_recent_liquidations:  ['liquidations','crypto','trading','realtime','bybit'],
    get_cascade_alert:        ['liquidations','cascade','alerts','trading','realtime'],
    get_cascade_scan:         ['liquidations','cascade','alerts','trading','realtime','perps','bybit','okx','binance','sharp-money'],
    get_liquidation_leaders:  ['liquidations','trading','crypto','perps','leaderboard','realtime'],
    get_sharp_move:           ['sports-betting','odds','world-cup','football','soccer','sharp-money','signals','trading','prediction'],
    get_liquidation_stats:    ['liquidations','crypto','trading','stats'],
    get_positioning:          ['positioning','open-interest','long-short','crypto'],
    get_trade_context:        ['market-data','trading','liquidations','positioning','crypto'],
    get_token_risk:           ['solana','tokens','risk','rug-check','security'],
  };
  Object.assign(TAGS, require('./expansion').TAGS_ADD);
  const routes = {};
  for (const [pattern, p] of Object.entries(PRICES)) {
    routes[pattern] = {
      accepts: [
        {
          scheme: 'exact',
          price: `$${p.usd}`,      // SDK converts to USDC units for the network
          network,
          payTo,
        },
        ...(payToEvm ? [{
          scheme: 'exact',
          price: `$${p.usd}`,
          network: EVM_NETWORK,     // Base mainnet, USDC auto-resolved
          payTo: payToEvm,
        }] : []),
      ],
      description: p.desc,
      serviceName: 'AgentFeed',
      tags: TAGS[p.tool] || ['crypto','trading'],
      extensions: declareDiscoveryExtension({}),
    };
  }

  // sync-on-start (default true): middleware fetches facilitator /supported at boot.
  // If the facilitator doesn't support our network, boot fails loudly — that IS the check.
  const middleware = paymentMiddleware(routes, resourceServer);

  console.log(`[payments] x402 active: network=${networkName} facilitator=${facilitatorUrl} payTo=${payTo}`);
  return { middleware, PRICES, network: networkName };
}

// decode X-PAYMENT-RESPONSE / PAYMENT-RESPONSE header (base64 JSON) for audit logging
function decodeSettlement(res) {
  const raw = res.getHeader('payment-response') || res.getHeader('x-payment-response');
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { buildPaymentLayer, decodeSettlement, PRICES };

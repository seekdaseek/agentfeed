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
//
// `desc` IS A PUBLISHED STRING, not an internal label. It is rendered verbatim
// into three public surfaces, all generated from this table:
//   GET /                        server.js  -> tools[].description
//   GET /.well-known/x402.json   server.js  -> resources[].description  (crawled
//                                by Bazaar and the x402 indexers)
//   the landing page             tools/landing.js -> the description column
// These are paid endpoints, so a wrong source named here is a false claim to a
// paying customer, not a docs typo. The price tools said "via Pyth" until
// 2026-08-27, by which point prices.js had been multi-source for a day.
const PRICES = {
  'GET /api/sol-price':                { usd: 0.001, tool: 'get_sol_price',       desc: 'SOL spot price (multi-source: Coinbase, Kraken, Pyth Hermes fallback)' },
  'GET /api/btc-price':                { usd: 0.001, tool: 'get_btc_price',       desc: 'BTC spot price (multi-source: Coinbase, Kraken, Pyth Hermes fallback)' },
  'GET /api/funding-rate':             { usd: 0.002, tool: 'get_funding_rate',    desc: 'SOL+BTC perp funding rates' },
  'GET /api/market-snapshot':          { usd: 0.003, tool: 'get_market_snapshot', desc: 'Full market snapshot in one call' },
  'GET /api/wallet-holdings/:wallet':  { usd: 0.008, tool: 'get_wallet_holdings', desc: 'Solana wallet holdings via Helius DAS' },
  'GET /api/token-metadata/:mint':     { usd: 0.005, tool: 'get_token_metadata',  desc: 'SPL token metadata via Helius DAS' },
  'GET /api/liquidations':             { usd: 0.003, tool: 'get_recent_liquidations', desc: 'Recent liquidations across the USDT perps we record on Bybit (complete unthrottled tape), OKX and Binance. Any symbol, not just majors; defaults to majors. The measured market count is published live at / under coverage.perp_markets_7d' },
  'GET /api/cascade':                  { usd: 0.01,  tool: 'get_cascade_alert',      desc: 'Liquidation cascade detector for the 5 majors (SOL/BTC/ETH/XRP/DOGE) across Bybit+OKX+Binance. For every perp we record use /api/cascade-scan' },
  'GET /api/cascade-scan':             { usd: 0.05,  tool: 'get_cascade_scan',       desc: 'FULL-UNIVERSE cascade scan: every USDT perp we record across Bybit+OKX+Binance. Bybit is the only complete unthrottled liquidation tape in crypto and no exchange publishes history of it' },
  'GET /api/liquidation-leaders':      { usd: 0.02,  tool: 'get_liquidation_leaders', desc: 'What is blowing up right now: top symbols by liquidation USD across every USDT perp we record, with long/short split, biggest print and venue count' },
  'GET /api/liquidation-stats':        { usd: 0.004, tool: 'get_liquidation_stats',   desc: '1h/24h liquidation totals for the 5 majors (SOL/BTC/ETH/XRP/DOGE), long/short split, biggest print, per-exchange breakdown' },
  'GET /api/positioning':              { usd: 0.004, tool: 'get_positioning',        desc: 'SOL+BTC long/short account ratio + open interest with 1h/24h OI change' },
  'GET /api/trade-context':            { usd: 0.01,  tool: 'get_trade_context',      desc: 'Full market state in one call: prices, funding, fear/greed, positioning, liquidations' },
  'GET /api/token-risk/:mint':         { usd: 0.01,  tool: 'get_token_risk',         desc: 'Token rug-risk signals: mint/freeze authority status, top-holder concentration, risk flags' },
};

Object.assign(PRICES, require('./expansion').PRICES_ADD);

// --- x402 challenge description bound -------------------------------------
//
// MEASURED 2026-09-01 by A/B/A against the live CDP facilitator, bisected over
// seven redeploys on get_cascade_forecast:
//
//     desc 487 chars (challenge header 2268 B) -> settles
//     desc 515 chars (challenge header 2308 B) -> facilitator /verify 400,
//                                                 relayed to the client as 402
//
// A description past the bound makes the endpoint UNPAYABLE. The facilitator
// rejects the paymentPayload, this server relays that as a fresh 402, and the
// route's own handler is never reached. It is invisible from curl, which only
// ever sees a correct-looking challenge, and it cost get_cascade_forecast every
// sale it might have made.
//
// The bound is closed HERE, at the payment boundary, and nowhere else. `desc`
// in the pricing table stays whole: GET /, /.well-known/x402.json, the landing
// page and the MCP tool definitions all render the full text, because that is
// what humans and LLM tool-selection read. Only the 402 challenge is trimmed.
//
// 256 is well under the measured 487 so that a longer route path or extra tags,
// which also count toward the payload, cannot push a route over.
const CHALLENGE_DESC_MAX = 256;

/** Trim for the challenge only. Never mutates the pricing table. */
function challengeDesc(desc) {
  const d = String(desc || '');
  if (d.length <= CHALLENGE_DESC_MAX) return d;
  const cut = d.slice(0, CHALLENGE_DESC_MAX - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > CHALLENGE_DESC_MAX * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '\u2026';
}

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
    get_sol_price:            ['crypto','price','solana','spot'],
    get_btc_price:            ['crypto','price','bitcoin','spot'],
    get_funding_rate:         ['funding','perps','crypto','trading'],
    get_market_snapshot:      ['market-data','crypto','trading','snapshot'],
    get_wallet_holdings:      ['solana','wallet','tokens','onchain'],
    get_token_metadata:       ['solana','tokens','metadata','onchain'],
    get_recent_liquidations:  ['liquidations','crypto','trading','realtime','bybit'],
    get_cascade_alert:        ['liquidations','cascade','alerts','trading','realtime'],
    get_cascade_scan:         ['liquidations','cascade','alerts','trading','realtime','perps','bybit','okx','binance','sharp-money'],
    get_liquidation_leaders:  ['liquidations','trading','crypto','perps','leaderboard','realtime'],
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
      description: challengeDesc(p.desc),   // challenge only; p.desc stays whole
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

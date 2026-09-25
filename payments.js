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
  'GET /api/sol-price':                { usd: 0.001, tool: 'get_sol_price',       desc: 'SOL price / Solana spot price in USD, live. Multi-source with a fixed fallback order — Coinbase, then Kraken, then Pyth Hermes — first finite quote wins. Returns the price, the venue that served it, and a Pyth confidence interval when Pyth did.' },
  'GET /api/btc-price':                { usd: 0.001, tool: 'get_btc_price',       desc: 'BTC price / Bitcoin spot price in USD, live. Multi-source with a fixed fallback order — Coinbase, then Kraken, then Pyth Hermes — first finite quote wins. Returns the price, the venue that served it, and a Pyth confidence interval when Pyth did.' },
  'GET /api/funding-rate':             { usd: 0.002, tool: 'get_funding_rate',    desc: 'Funding rate for SOL and BTC perps, from Hyperliquid: the hourly rate, its 8h equivalent, mark price and open interest for each. For the funding rate on ANY USDT perp across Bybit, OKX and Hyperliquid in one call, use /api/funding-cross.' },
  'GET /api/market-snapshot':          { usd: 0.003, tool: 'get_market_snapshot', desc: 'Crypto market snapshot in one call: SOL and BTC spot prices, both perp funding rates with mark price and open interest, and the Fear & Greed index with its classification. Five reads, one payment.' },
  'GET /api/wallet-holdings/:wallet':  { usd: 0.008, tool: 'get_wallet_holdings', desc: 'Solana wallet holdings / portfolio for any address: native SOL with its USD value, every SPL token with amount, unit price and USD value, and an NFT count. Helius DAS getAssetsByOwner, up to 100 assets.' },
  'GET /api/token-metadata/:mint':     { usd: 0.005, tool: 'get_token_metadata',  desc: 'SPL token metadata for any Solana mint: name, symbol, decimals, total supply, current USD price, interface type, and whether the metadata is still mutable. Helius DAS.' },
  'GET /api/liquidations':             { usd: 0.003, tool: 'get_recent_liquidations', desc: 'Crypto liquidations, live tape: recent perp liquidation prints across Bybit, OKX and Binance with timestamp, side liquidated, size, price and USD value. Any USDT perp we record, not just majors. The Bybit tape is complete and unthrottled.' },
  'GET /api/cascade':                  { usd: 0.01,  tool: 'get_cascade_alert',      desc: 'Liquidation cascade detector, live: clustered same-side liquidations happening NOW on SOL, BTC, ETH, XRP and DOGE across Bybit, OKX and Binance, with side, USD total, prints, duration and severity. For every perp we record use /api/cascade-scan.' },
  'GET /api/cascade-scan':             { usd: 0.05,  tool: 'get_cascade_scan',       desc: 'Liquidation cascade scan across EVERY USDT perp we record on Bybit, OKX and Binance at once, not just the majors: symbol, side liquidated, USD total, prints, duration, severity. Bybit is the only complete unthrottled liquidation tape in crypto.' },
  'GET /api/liquidation-leaders':      { usd: 0.02,  tool: 'get_liquidation_leaders', desc: 'Liquidation leaderboard: top symbols by liquidation USD right now across every USDT perp we record on Bybit, OKX and Binance, with long/short split, biggest single print and venue count. What is blowing up, ranked.' },
  'GET /api/liquidation-stats':        { usd: 0.004, tool: 'get_liquidation_stats',   desc: 'Liquidation stats, 1h and 24h totals for SOL, BTC, ETH, XRP and DOGE: long vs short USD split, biggest single print, and a per-exchange breakdown across Bybit, OKX and Binance.' },
  'GET /api/positioning':              { usd: 0.004, tool: 'get_positioning',        desc: 'Open interest and long/short ratio for SOL and BTC perps: the retail long/short account ratio plus Bybit open interest with 1h and 24h change. For any other USDT perp use /api/open-interest and /api/long-short.' },
  'GET /api/trade-context':            { usd: 0.01,  tool: 'get_trade_context',      desc: 'Crypto trading context in one call: SOL and BTC prices, perp funding rates, Fear & Greed, long/short positioning, open interest and 1h/24h liquidation stats. The whole pre-trade picture, one payment.' },
  'GET /api/token-risk/:mint':         { usd: 0.01,  tool: 'get_token_risk',         desc: 'Solana token rug check / risk signals for any SPL mint: mint and freeze authority status (revoked is safer), top-1 and top-10 holder concentration, supply, price, and a list of risk flags. Not a honeypot or LP-lock checker.' },
};

Object.assign(PRICES, require('./expansion').PRICES_ADD);

// ---- Bazaar discovery metadata ------------------------------------------
//
// Every route used to declare declareDiscoveryExtension({}), which publishes an
// EMPTY input shape and no output at all. Measured 2026-09-25 against CDP:
// all 20 of AgentFeed's indexed routes showed `queryParams: {}` and none had
// `info.output`, while 14,750 of the Bazaar's 17,422 listings carried an output
// example; CDP's own validator returned an advisory FAIL on bazaar.info.output
// for every route tested. x402scan/AgentCash marks a route with no input schema
// non-invocable outright.
//
// The declarations are GENERATED, never hand-written: gen-bazaar-meta.js derives
// the input schema from each route's own zod schema (expansion.js EXP, mcp.js
// TOOL_DEFS) and captures the output example by calling the same function the
// route calls, then writes bazaar-examples.json. Re-run it when a route's shape
// changes; a route missing from that file is named loudly at boot below.
//
// LOADED DEFENSIVELY. This file is the payment layer of the live revenue
// service. A missing or corrupt metadata file must degrade to the old empty
// declaration -- which is exactly what shipped until today -- and never stop the
// paid surface from serving.
let BAZAAR_META = {};
try {
  BAZAAR_META = require('./bazaar-examples.json').routes || {};
} catch (e) {
  console.warn('[payments] bazaar-examples.json not loaded, discovery metadata will be empty:', e.message);
}

// Served by server.js from icon.png (256x256). Declared per route because the
// Bazaar reads iconUrl off the resource object, not off the service.
const ICON_URL = 'https://x402.ochinimus.app/icon.png';

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

// Tags per tool. Module scope so tools/discovery.js can group the published
// catalogue by the same tags the 402 challenge advertises.
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

// Routes whose generated metadata is absent, collected during the build below
// so the boot log names them once instead of per route.
const missingMeta = [];

/**
 * The bazaar declaration for one route pattern, or {} when it has none.
 * `method` is deliberately NOT passed: @x402/extensions fills it from the
 * request at serve time (enrichDeclaration), and so are `pathParams`, whose
 * values are the actual path segments of the request being answered. Only
 * pathParamsSchema survives from here, which is why it is the one passed.
 */
function bazaarConfig(pattern) {
  const m = BAZAAR_META[pattern];
  if (!m) { missingMeta.push(pattern); return {}; }
  return {
    input: m.input || {},
    inputSchema: m.inputSchema || { properties: {} },
    ...(m.pathParamsSchema ? { pathParamsSchema: m.pathParamsSchema } : {}),
    ...(m.output && m.output.example ? { output: m.output } : {}),
  };
}

function buildPaymentLayer() {
  missingMeta.length = 0;
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
      mimeType: 'application/json',
      iconUrl: ICON_URL,
      extensions: declareDiscoveryExtension(bazaarConfig(pattern)),
    };
  }
  if (missingMeta.length) {
    console.warn(`[payments] ${missingMeta.length} route(s) have NO bazaar metadata and will publish an empty declaration: ${missingMeta.join(', ')} -- re-run: node --env-file=.env gen-bazaar-meta.js`);
  }

  // sync-on-start (default true): middleware fetches facilitator /supported at boot.
  // If the facilitator doesn't support our network, boot fails loudly — that IS the check.
  const middleware = paymentMiddleware(routes, resourceServer);

  const withOutput = Object.keys(routes).filter((r) => BAZAAR_META[r] && BAZAAR_META[r].output).length;
  console.log(`[payments] x402 active: network=${networkName} facilitator=${facilitatorUrl} payTo=${payTo}`);
  console.log(`[payments] bazaar: ${Object.keys(routes).length} routes declared, ${withOutput} with an output example, icon=${ICON_URL}`);
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

module.exports = { buildPaymentLayer, decodeSettlement, PRICES, TAGS, BAZAAR_META, ICON_URL, CHALLENGE_DESC_MAX, challengeDesc };

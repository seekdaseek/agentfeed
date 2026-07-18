// expansion.js — 18 -> 44: single source of truth for the 26 new tools.
// Wiring is 3 one-line edits (see WIRING.md):
//   payments.js : Object.assign(PRICES, require('./expansion').PRICES_ADD)  + TAGS merge
//   server.js   : require('./expansion').register(app, tool)
//   mcp.js      : TOOL_DEFS.push(...require('./expansion').MCP_DEFS_ADD)
// Landing page, '/' JSON, /.well-known/x402.json and the MCP pricing tool all
// derive from PRICES / TOOL_DEFS, so counts stay in sync automatically.
'use strict';
const { z } = require('zod');
const D = require('./tools/derivs');
const M = require('./tools/micro');
const L = require('./tools/liqdb');
const S = require('./tools/solana2');
const F = require('./tools/defi');

const sym = (d) => z.string().optional().describe(`USDT perp symbol e.g. SOLUSDT, BTCUSDT (default ${d})`);
const symReq = z.string().describe('USDT perp symbol e.g. SOLUSDT');

const EXP = [
  // ---- MOAT: our own liquidation tape (nobody can clone these) ----
  { name: 'get_liq_history', route: 'GET /api/liq-history', usd: 0.05,
    desc: 'HISTORICAL liquidation tape, time-bucketed: total/long/short USD, prints, biggest print per bucket. Any USDT perp or the whole ~600-perp universe, up to 7 days back. Bybit is the only complete liq tape in crypto and no exchange publishes history of it — this data exists nowhere else.',
    tags: ['liquidations', 'history', 'crypto', 'trading', 'exclusive'],
    schema: { symbol: sym('SOLUSDT'), scope: z.enum(['symbol', 'all']).optional().describe('all = whole universe'), hours: z.number().optional().describe('lookback 1-168, default 24'), bucket_min: z.number().optional().describe('bucket minutes 5-1440, default 60') },
    run: (a) => L.getLiqHistory(a) },
  { name: 'get_liq_heatmap', route: 'GET /api/liq-heatmap', usd: 0.05,
    desc: 'Liquidation heatmap by PRICE LEVEL from our own tape: where leverage actually got flushed in the last N hours — USD, prints, long/short split per price zone, hottest zone flagged. Real prints, not entry-price estimates.',
    tags: ['liquidations', 'heatmap', 'levels', 'trading', 'exclusive'],
    schema: { symbol: symReq, hours: z.number().optional().describe('lookback 1-168, default 24'), buckets: z.number().optional().describe('price buckets 5-50, default 20') },
    run: (a) => L.getLiqHeatmap(a) },
  { name: 'get_cascade_history', route: 'GET /api/cascade-history', usd: 0.03,
    desc: 'PAST liquidation cascades reconstructed from our tape: clustered same-side flush events with start/end, prints, USD total, peak print. get_cascade_alert tells you NOW; this tells you what already happened, up to 72h back.',
    tags: ['liquidations', 'cascade', 'history', 'trading', 'exclusive'],
    schema: { symbol: sym('SOLUSDT'), scope: z.enum(['symbol', 'all']).optional(), hours: z.number().optional().describe('1-72, default 24'), min_usd: z.number().optional().describe('min event USD, default 100k (250k for scope=all)'), gap_s: z.number().optional().describe('max gap seconds within an event, default 60') },
    run: (a) => L.getCascadeHistory(a) },
  { name: 'get_squeeze_score', route: 'GET /api/squeeze-score', usd: 0.10,
    desc: 'FLAGSHIP: short-squeeze / long-flush score 0-100 for any USDT perp. Composite of funding, long/short crowding, 24h OI build, and liq-skew from our exclusive tape. One number that answers "is this trade crowded and about to hurt someone".',
    tags: ['squeeze', 'signal', 'liquidations', 'funding', 'trading', 'exclusive'],
    schema: { symbol: symReq },
    run: (a) => L.getSqueezeScore(a) },
  { name: 'get_venue_liq_share', route: 'GET /api/venue-liq-share', usd: 0.02,
    desc: 'Which venue is flushing whom: per-exchange liquidation share (Bybit/OKX/Binance) with long/short split and biggest print, any symbol or whole universe.',
    tags: ['liquidations', 'exchanges', 'crypto', 'trading'],
    schema: { symbol: sym('all'), hours: z.number().optional().describe('1-168, default 24') },
    run: (a) => L.getVenueLiqShare(a) },

  // ---- derivatives suite ----
  { name: 'get_funding_cross', route: 'GET /api/funding-cross', usd: 0.01,
    desc: 'Funding for ANY USDT perp across Bybit + OKX + Hyperliquid in one call, with cross-venue spread and crowding read. (get_funding_rate covers SOL+BTC only.)',
    tags: ['funding', 'perps', 'cross-exchange', 'trading'],
    schema: { symbol: symReq }, run: (a) => D.getFundingCross(a) },
  { name: 'get_funding_extremes', route: 'GET /api/funding-extremes', usd: 0.02,
    desc: 'Most crowded trades across ~600 USDT perps: top most-positive and most-negative funding with annualized %, 24h price move and OI. Crowded shorts = squeeze candidates.',
    tags: ['funding', 'screener', 'crowding', 'trading'],
    schema: { limit: z.number().optional().describe('top N each side, 1-25, default 10'), min_turnover_usd: z.number().optional().describe('liquidity floor, default 1M') },
    run: (a) => D.getFundingExtremes(a) },
  { name: 'get_open_interest', route: 'GET /api/open-interest', usd: 0.01,
    desc: 'Open interest for ANY USDT perp: Bybit OI in base + USD with 1h/24h change, plus OKX OI. (get_positioning covers SOL+BTC only.)',
    tags: ['open-interest', 'perps', 'crypto', 'trading'],
    schema: { symbol: symReq }, run: (a) => D.getOpenInterest(a) },
  { name: 'get_oi_spike_scan', route: 'GET /api/oi-spike-scan', usd: 0.02,
    desc: 'Abnormal open-interest jumps across ~600 USDT perps vs a 30min+ baseline — where new leverage is piling in, with funding and price context. Squeeze/flush precursor screener.',
    tags: ['open-interest', 'screener', 'anomaly', 'trading'],
    schema: { limit: z.number().optional().describe('top N, 1-25, default 10') },
    run: (a) => D.getOiSpikeScan(a) },
  { name: 'get_long_short', route: 'GET /api/long-short', usd: 0.01,
    desc: 'Long/short account ratio for ANY USDT perp with 1h and 24h trend (retail crowding gauge).',
    tags: ['positioning', 'long-short', 'crypto', 'trading'],
    schema: { symbol: symReq }, run: (a) => D.getLongShort(a) },
  { name: 'get_basis', route: 'GET /api/basis', usd: 0.01,
    desc: 'Perp-vs-spot basis for any USDT pair: premium/discount %, contango/backwardation read, funding context.',
    tags: ['basis', 'perps', 'spot', 'trading'],
    schema: { symbol: symReq }, run: (a) => D.getBasis(a) },
  { name: 'get_volatility', route: 'GET /api/volatility', usd: 0.01,
    desc: 'Realized volatility for any USDT perp: 7d and 30d annualized from daily closes, plus today\'s range. Position-sizing input.',
    tags: ['volatility', 'risk', 'crypto', 'trading'],
    schema: { symbol: symReq }, run: (a) => D.getVolatility(a) },
  { name: 'get_funding_history', route: 'GET /api/funding-history', usd: 0.005,
    desc: 'Funding-rate history for any USDT perp (up to 200 intervals): average, annualized, share of positive intervals — what the carry has actually been.',
    tags: ['funding', 'history', 'carry', 'trading'],
    schema: { symbol: symReq, limit: z.number().optional().describe('intervals, 1-200, default 30') },
    run: (a) => D.getFundingHistory(a) },
  { name: 'get_top_movers', route: 'GET /api/top-movers', usd: 0.01,
    desc: '24h top gainers and losers across ~600 USDT perps with a liquidity floor, funding attached. The "what moved" screener.',
    tags: ['movers', 'screener', 'crypto', 'trading'],
    schema: { limit: z.number().optional().describe('top N each side, 1-25, default 10'), min_turnover_usd: z.number().optional().describe('liquidity floor, default 1M') },
    run: (a) => D.getTopMovers(a) },

  // ---- microstructure suite ----
  { name: 'get_orderbook_imbalance', route: 'GET /api/orderbook-imbalance', usd: 0.01,
    desc: 'Bid/ask resting-liquidity imbalance within ±N bps of mid for any USDT perp: USD each side, ratio, skew read.',
    tags: ['orderbook', 'microstructure', 'depth', 'trading'],
    schema: { symbol: symReq, bps: z.number().optional().describe('window ±bps around mid, 5-500, default 50') },
    run: (a) => M.getOrderbookImbalance(a) },
  { name: 'get_orderbook_walls', route: 'GET /api/orderbook-walls', usd: 0.01,
    desc: 'Largest resting orders each side of the book for any USDT perp, with USD size and distance from mid.',
    tags: ['orderbook', 'walls', 'levels', 'trading'],
    schema: { symbol: symReq, top: z.number().optional().describe('walls per side, 1-15, default 5') },
    run: (a) => M.getOrderbookWalls(a) },
  { name: 'get_whale_trades', route: 'GET /api/whale-trades', usd: 0.02,
    desc: 'Large prints from the live trade tape for any USDT perp: trades over a USD threshold, buy/sell totals, net flow, dominant side.',
    tags: ['whales', 'trades', 'flow', 'trading'],
    schema: { symbol: symReq, min_usd: z.number().optional().describe('min print USD, default 100k'), limit: z.number().optional().describe('max trades returned, 1-50, default 20') },
    run: (a) => M.getWhaleTrades(a) },
  { name: 'get_spread_arb', route: 'GET /api/spread-arb', usd: 0.02,
    desc: 'Best bid/ask for a USDT perp across Bybit, OKX and Hyperliquid, with the best cross-venue edge in bps (pre-fee).',
    tags: ['arbitrage', 'spread', 'cross-exchange', 'trading'],
    schema: { symbol: symReq }, run: (a) => M.getSpreadArb(a) },

  // ---- Solana suite ----
  { name: 'get_token_holders', route: 'GET /api/token-holders/:mint', usd: 0.02,
    desc: 'Top holders of any SPL token with per-account share and top1/top5/top10 concentration. Deeper cut than get_token_risk\'s summary.',
    tags: ['solana', 'tokens', 'holders', 'onchain'],
    schema: { mint: z.string().describe('SPL token mint address (base58)') },
    run: (a) => S.getTokenHolders(a) },
  { name: 'get_wallet_activity', route: 'GET /api/wallet-activity/:wallet', usd: 0.02,
    desc: 'Recent transactions of any Solana wallet, parsed human-readable: type, protocol, description, fee, failures (Helius enhanced).',
    tags: ['solana', 'wallet', 'transactions', 'onchain'],
    schema: { wallet: z.string().describe('Solana wallet address (base58)'), limit: z.number().optional().describe('tx count, 1-25, default 10') },
    run: (a) => S.getWalletActivity(a) },
  { name: 'get_priority_fees', route: 'GET /api/priority-fees', usd: 0.005,
    desc: 'Solana priority-fee estimate right now, all levels (min to unsafeMax) in micro-lamports/CU, with a recommended tip. For bots that need txs to land.',
    tags: ['solana', 'fees', 'network', 'onchain'],
    schema: {}, run: () => S.getPriorityFees() },
  { name: 'get_jito_tips', route: 'GET /api/jito-tips', usd: 0.005,
    desc: 'Jito bundle tip floor percentiles (p25-p99, SOL) — what landed bundles are actually paying, with a landing recommendation.',
    tags: ['solana', 'jito', 'mev', 'fees'],
    schema: {}, run: () => S.getJitoTips() },
  { name: 'get_sol_network', route: 'GET /api/sol-network', usd: 0.005,
    desc: 'Solana network health: recent average TPS, current slot, epoch and epoch progress.',
    tags: ['solana', 'network', 'tps', 'onchain'],
    schema: {}, run: () => S.getSolNetwork() },

  // ---- DeFi / macro suite ----
  { name: 'get_tvl', route: 'GET /api/tvl', usd: 0.005,
    desc: 'TVL for any DeFi protocol (with 1d/7d change) or top-15 chains ranking. DefiLlama-backed.',
    tags: ['defi', 'tvl', 'protocols', 'macro'],
    schema: { target: z.string().optional().describe('protocol slug/name e.g. jito, marinade — omit for top chains') },
    run: (a) => F.getTvl(a) },
  { name: 'get_stablecoin_flows', route: 'GET /api/stablecoin-flows', usd: 0.01,
    desc: 'Total stablecoin supply with 7d/30d deltas and top stables — the macro risk-on/risk-off dial for crypto.',
    tags: ['stablecoins', 'macro', 'flows', 'defi'],
    schema: {}, run: () => F.getStablecoinFlows() },
  { name: 'get_dex_quote', route: 'GET /api/dex-quote', usd: 0.005,
    desc: 'Live Jupiter swap quote for any SPL pair: output amount, price impact, route. The real executable price on Solana, not an index price.',
    tags: ['solana', 'dex', 'jupiter', 'swap'],
    schema: { input_mint: z.string().describe('input mint (base58)'), output_mint: z.string().describe('output mint (base58)'), amount: z.string().describe('amount in raw base units of input mint') },
    run: (a) => F.getDexQuote(a) },
];

// ---- derived exports ----
const PRICES_ADD = {};
const TAGS_ADD = {};
for (const t of EXP) {
  PRICES_ADD[t.route] = { usd: t.usd, tool: t.name, desc: t.desc };
  TAGS_ADD[t.name] = t.tags;
}

const MCP_DEFS_ADD = EXP.map((t) => ({
  name: t.name, usd: t.usd, desc: t.desc, schema: t.schema,
  run: (a) => t.run(a || {}),
}));

// REST registration: merge query + path params into one args object
function register(app, tool) {
  for (const t of EXP) {
    const path = t.route.replace('GET ', '');
    app.get(path, tool(t.name, t.usd, (req) => t.run({ ...(req.query || {}), ...(req.params || {}) })));
  }
}

module.exports = { EXP, PRICES_ADD, TAGS_ADD, MCP_DEFS_ADD, register };

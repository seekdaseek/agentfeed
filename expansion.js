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
const P = require('./tools/peg');
const CF = require('./tools/cascade-forecast');
const OV = require('./tools/overhang');
const B = require('./tools/base');
const PX = require('./tools/prices');
const EN = require('./tools/entry');

const sym = (d) => z.string().optional().describe(`USDT perp symbol e.g. SOLUSDT, BTCUSDT (default ${d})`);
const symReq = z.string().describe('USDT perp symbol e.g. SOLUSDT');

const EXP = [
  { name: 'get_cascade_forecast', route: 'GET /api/cascade-forecast', usd: 0.02,
    tags: ['forecast','liquidations','cascade','prediction','exclusive'], desc: 'Liquidation forecast, FORWARD-LOOKING and not a description of what already happened. Returns the probability that a symbol will liquidate more in the NEXT 15 minutes than its own 90th-percentile 15-minute window. Calibrated on a 28-day tape of 1.4M Bybit liquidations across 799 symbols, which cannot be reconstructed by anyone starting today because no exchange publishes liquidation history. Every answer carries the exact question, the threshold in USD, the window it read, the number of historical occurrences behind the number, and instructions for settling it yourself from the public feed. When a state has too little history the tool DECLINES rather than guessing, and says why. The settled record is free at /api/forecast-record.',
    schema: { symbol: z.string().optional().describe('SOL, BTC, ETH or any USDT perp e.g. SXTUSDT (default SOL)'),
              symbols: z.string().optional().describe('comma separated for a batch, max 20, e.g. SOL,BTC,ETH') },
    run: (a) => CF.getCascadeForecast({ query: a }) },
  // ---- MOAT: our own liquidation tape (nobody can clone these) ----
  { name: 'get_liq_history', route: 'GET /api/liq-history', usd: 0.05,
    desc: 'Liquidation history, time-bucketed: total, long and short USD, prints and biggest print per bucket, for any USDT perp or the whole recorded universe, up to 7 days back. Bybit is the only complete liq tape in crypto and no exchange publishes history of it.',
    tags: ['liquidations', 'history', 'crypto', 'trading', 'exclusive'],
    schema: { symbol: sym('SOLUSDT'), scope: z.enum(['symbol', 'all']).optional().describe('all = whole universe'), hours: z.number().optional().describe('lookback 1-168, default 24'), bucket_min: z.number().optional().describe('bucket minutes 5-1440, default 60') },
    run: (a) => L.getLiqHistory(a) },
  { name: 'get_liq_heatmap', route: 'GET /api/liq-heatmap', usd: 0.05,
    desc: 'Liquidation heatmap by PRICE LEVEL: where leverage actually got flushed in the last N hours — USD, prints and long/short split per price zone, with the hottest zone flagged. Built from real liquidation prints, not entry-price estimates.',
    tags: ['liquidations', 'heatmap', 'levels', 'trading', 'exclusive'],
    schema: { symbol: symReq, hours: z.number().optional().describe('lookback 1-168, default 24'), buckets: z.number().optional().describe('price buckets 5-50, default 20') },
    run: (a) => L.getLiqHeatmap(a) },
  { name: 'get_cascade_history', route: 'GET /api/cascade-history', usd: 0.03,
    desc: 'Liquidation cascade history: past clustered same-side flush events reconstructed from our own tape, with start and end, prints, USD total and peak print, up to 72h back. /api/cascade tells you what is happening NOW; this tells you what already happened.',
    tags: ['liquidations', 'cascade', 'history', 'trading', 'exclusive'],
    schema: { symbol: sym('SOLUSDT'), scope: z.enum(['symbol', 'all']).optional().describe('symbol = just this symbol (default), all = every recorded USDT perp'), hours: z.number().optional().describe('1-72, default 24'), min_usd: z.number().optional().describe('min event USD, default 100k (250k for scope=all)'), gap_s: z.number().optional().describe('max gap seconds within an event, default 60') },
    run: (a) => L.getCascadeHistory(a) },
  { name: 'get_squeeze_score', route: 'GET /api/squeeze-score', usd: 0.10,
    desc: 'Short squeeze score and long flush score, 0-100, for any USDT perp. Composite of the funding rate, long/short crowding, 24h open-interest build, and liquidation skew from our own tape. One number for whether a trade is crowded and about to hurt someone.',
    tags: ['squeeze', 'signal', 'liquidations', 'funding', 'trading', 'exclusive'],
    schema: { symbol: symReq },
    run: (a) => L.getSqueezeScore(a) },
  { name: 'get_venue_liq_share', route: 'GET /api/venue-liq-share', usd: 0.02,
    desc: 'Liquidations by exchange: per-venue liquidation share across Bybit, OKX and Binance with long/short split and biggest print, for any symbol or the whole recorded universe. Which venue is flushing whom.',
    tags: ['liquidations', 'exchanges', 'crypto', 'trading'],
    schema: { symbol: sym('all'), hours: z.number().optional().describe('1-168, default 24') },
    run: (a) => L.getVenueLiqShare(a) },

  // ---- derivatives suite ----
  { name: 'get_funding_cross', route: 'GET /api/funding-cross', usd: 0.01,
    desc: 'Funding rate for ANY USDT perp across Bybit, OKX and Hyperliquid in one call, with the cross-venue spread and a crowding read. /api/funding-rate covers SOL and BTC only.',
    tags: ['funding', 'perps', 'cross-exchange', 'trading'],
    schema: { symbol: symReq }, run: (a) => D.getFundingCross(a) },
  { name: 'get_funding_extremes', route: 'GET /api/funding-extremes', usd: 0.02,
    desc: 'Funding rate extremes across every Bybit USDT perp: the most positive and most negative funding with annualized %, 24h price move and open interest. The most crowded trades in the market — crowded shorts are squeeze candidates.',
    tags: ['funding', 'screener', 'crowding', 'trading'],
    schema: { limit: z.number().optional().describe('top N each side, 1-25, default 10'), min_turnover_usd: z.number().optional().describe('liquidity floor, default 1M') },
    run: (a) => D.getFundingExtremes(a) },
  { name: 'get_open_interest', route: 'GET /api/open-interest', usd: 0.01,
    desc: 'Open interest for ANY USDT perp: Bybit OI in base units and in USD with 1h and 24h change, plus OKX open interest and the mark price. /api/positioning covers SOL and BTC only.',
    tags: ['open-interest', 'perps', 'crypto', 'trading'],
    schema: { symbol: symReq }, run: (a) => D.getOpenInterest(a) },
  { name: 'get_oi_spike_scan', route: 'GET /api/oi-spike-scan', usd: 0.02,
    desc: 'Open interest spikes across every Bybit USDT perp: abnormal OI jumps against an earlier snapshot of the same universe, at least 30 minutes old and with its exact age returned as baseline_min_ago, plus funding and 24h price context.',
    tags: ['open-interest', 'screener', 'anomaly', 'trading'],
    schema: { limit: z.number().optional().describe('top N, 1-25, default 10') },
    run: (a) => D.getOiSpikeScan(a) },
  { name: 'get_long_short', route: 'GET /api/long-short', usd: 0.01,
    desc: 'Long/short ratio for ANY USDT perp: the retail long and short account percentages from Bybit with 1h and 24h trend. The crowding gauge.',
    tags: ['positioning', 'long-short', 'crypto', 'trading'],
    schema: { symbol: symReq }, run: (a) => D.getLongShort(a) },
  { name: 'get_basis', route: 'GET /api/basis', usd: 0.01,
    desc: 'Perp-vs-spot basis for any USDT pair: the premium or discount in %, a contango or backwardation read, and the funding context that goes with it.',
    tags: ['basis', 'perps', 'spot', 'trading'],
    schema: { symbol: symReq }, run: (a) => D.getBasis(a) },
  { name: 'get_volatility', route: 'GET /api/volatility', usd: 0.01,
    desc: 'Realized volatility for any USDT perp: 7-day and 30-day annualized from daily closes, plus today\'s range in %. A position-sizing input.',
    tags: ['volatility', 'risk', 'crypto', 'trading'],
    schema: { symbol: symReq }, run: (a) => D.getVolatility(a) },
  { name: 'get_funding_history', route: 'GET /api/funding-history', usd: 0.005,
    desc: 'Funding rate history for any USDT perp, up to 200 intervals: the average rate, its annualized %, the share of intervals that were positive, and the raw series. What the carry has actually been.',
    tags: ['funding', 'history', 'carry', 'trading'],
    schema: { symbol: symReq, limit: z.number().optional().describe('intervals, 1-200, default 30') },
    run: (a) => D.getFundingHistory(a) },
  { name: 'get_top_movers', route: 'GET /api/top-movers', usd: 0.01,
    desc: 'Top gainers and losers over 24h across every Bybit USDT perp above a liquidity floor, each with its funding rate attached. The "what moved" screener.',
    tags: ['movers', 'screener', 'crypto', 'trading'],
    schema: { limit: z.number().optional().describe('top N each side, 1-25, default 10'), min_turnover_usd: z.number().optional().describe('liquidity floor, default 1M') },
    run: (a) => D.getTopMovers(a) },

  // ---- microstructure suite ----
  { name: 'get_orderbook_imbalance', route: 'GET /api/orderbook-imbalance', usd: 0.01,
    desc: 'Orderbook imbalance for any USDT perp: resting bid and ask liquidity in USD within ±N bps of mid, the ratio between the two sides, and a skew read.',
    tags: ['orderbook', 'microstructure', 'depth', 'trading'],
    schema: { symbol: symReq, bps: z.number().optional().describe('window ±bps around mid, 5-500, default 50') },
    run: (a) => M.getOrderbookImbalance(a) },
  { name: 'get_orderbook_walls', route: 'GET /api/orderbook-walls', usd: 0.01,
    desc: 'Orderbook walls for any USDT perp: the largest resting orders on each side of the book, with USD size and distance from mid.',
    tags: ['orderbook', 'walls', 'levels', 'trading'],
    schema: { symbol: symReq, top: z.number().optional().describe('walls per side, 1-15, default 5') },
    run: (a) => M.getOrderbookWalls(a) },
  { name: 'get_whale_trades', route: 'GET /api/whale-trades', usd: 0.02,
    desc: 'Whale trades for any USDT perp: prints from the live trade tape above a USD threshold, with buy and sell totals, net flow and the dominant side.',
    tags: ['whales', 'trades', 'flow', 'trading'],
    schema: { symbol: symReq, min_usd: z.number().optional().describe('min print USD, default 100k'), limit: z.number().optional().describe('max trades returned, 1-50, default 20') },
    run: (a) => M.getWhaleTrades(a) },
  { name: 'get_spread_arb', route: 'GET /api/spread-arb', usd: 0.02,
    desc: 'Cross-exchange spread and arbitrage edge for any USDT perp: the best bid and ask on Bybit, OKX and Hyperliquid, with the best cross-venue edge in bps, pre-fee.',
    tags: ['arbitrage', 'spread', 'cross-exchange', 'trading'],
    schema: { symbol: symReq }, run: (a) => M.getSpreadArb(a) },

  // ---- Solana suite ----
  { name: 'get_token_holders', route: 'GET /api/token-holders/:mint', usd: 0.02,
    desc: 'Top holders of any SPL token: per-account share with top-1, top-5 and top-10 concentration for a Solana mint. A deeper cut than the summary in /api/token-risk.',
    tags: ['solana', 'tokens', 'holders', 'onchain'],
    schema: { mint: z.string().describe('SPL token mint address (base58)') },
    run: (a) => S.getTokenHolders(a) },
  { name: 'get_wallet_activity', route: 'GET /api/wallet-activity/:wallet', usd: 0.02,
    desc: 'Solana wallet activity: recent transactions for any address, parsed human-readable — type, protocol, description, fee and failures. Helius enhanced transactions.',
    tags: ['solana', 'wallet', 'transactions', 'onchain'],
    schema: { wallet: z.string().describe('Solana wallet address (base58)'), limit: z.number().optional().describe('tx count, 1-25, default 10') },
    run: (a) => S.getWalletActivity(a) },
  { name: 'get_priority_fees', route: 'GET /api/priority-fees', usd: 0.005,
    desc: 'Solana priority fees right now: the fee estimate at every level from min to unsafeMax in micro-lamports per compute unit, with a recommended tip. For bots that need their transactions to land.',
    tags: ['solana', 'fees', 'network', 'onchain'],
    schema: {}, run: () => S.getPriorityFees() },
  { name: 'get_jito_tips', route: 'GET /api/jito-tips', usd: 0.005,
    desc: 'Jito tips: bundle tip floor percentiles from p25 to p99 in SOL — what landed bundles are actually paying — with an EMA p50 and a landing recommendation.',
    tags: ['solana', 'jito', 'mev', 'fees'],
    schema: {}, run: () => S.getJitoTips() },
  { name: 'get_sol_network', route: 'GET /api/sol-network', usd: 0.005,
    desc: 'Solana network health: recent average TPS, the current slot, the current epoch and epoch progress in %.',
    tags: ['solana', 'network', 'tps', 'onchain'],
    schema: {}, run: () => S.getSolNetwork() },

  // ---- DeFi / macro suite ----
  { name: 'get_tvl', route: 'GET /api/tvl', usd: 0.005,
    desc: 'TVL for any DeFi protocol with 1d and 7d change, or a top-15 chains ranking. DefiLlama-backed; a protocol family is aggregated across its deployments and the change is TVL-weighted.',
    tags: ['defi', 'tvl', 'protocols', 'macro'],
    schema: { target: z.string().optional().describe('protocol slug/name e.g. jito, marinade — omit for top chains') },
    run: (a) => F.getTvl(a) },
  { name: 'get_stablecoin_flows', route: 'GET /api/stablecoin-flows', usd: 0.01,
    desc: 'Stablecoin supply and flows: total stablecoin market cap with 7d and 30d deltas and the top stables by size — the macro risk-on / risk-off dial for crypto.',
    tags: ['stablecoins', 'macro', 'flows', 'defi'],
    schema: {}, run: () => F.getStablecoinFlows() },
  { name: 'get_dex_quote', route: 'GET /api/dex-quote', usd: 0.005,
    desc: 'Solana DEX quote from Jupiter for any SPL pair: output amount, price impact %, the route taken and the slippage assumed. The real executable price on Solana, not an index price.',
    tags: ['solana', 'dex', 'jupiter', 'swap'],
    schema: { input_mint: z.string().describe('input mint (base58)'), output_mint: z.string().describe('output mint (base58)'), amount: z.string().describe('amount in raw base units of input mint') },
    run: (a) => F.getDexQuote(a) },

  // ---- MOAT: our own tokenized-equity peg tape ----
  { name: 'get_peg_deviation', route: 'GET /api/peg-deviation', usd: 0.02,
    desc: 'Tokenized stock peg deviation on Solana: the on-chain DEX price of a tokenized US equity versus the underlying\'s last real trade, in bps, with 24h stats split into market-open and off-hours. Sampled every 5 minutes by our own collector.',
    tags: ['rwa','tokenized-stocks','peg','solana','exclusive'],
    schema: { symbol: z.string().describe('Tokenized equity symbol e.g. CRCLx, MSTRx, COINx'), hours: z.number().optional().describe('lookback 1-168, default 24') },
    run: (a) => P.getPegDeviation(a) },
  { name: 'get_peg_sessions', route: 'GET /api/peg-sessions', usd: 0.03,
    desc: 'Tokenized stock peg by trading session: deviation broken out across open, premarket, afterhours, overnight and weekend — mean, p95, max bps and median liquidity each, with the worst off-hours window flagged. Market-open acts as the control.',
    tags: ['rwa','tokenized-stocks','peg','sessions','exclusive'],
    schema: { symbol: z.string().describe('Tokenized equity symbol e.g. CRCLx, MSTRx, COINx'), days: z.number().optional().describe('lookback 1-30, default 7') },
    run: (a) => P.getPegSessions(a) },
  { name: 'get_peg_universe', route: 'GET /api/peg-universe', usd: 0.05,
    desc: 'Tokenized stocks ranked by off-hours peg risk: every tokenized US equity we track, with p95 and max deviation bps, market-open deviation as the control, and median liquidity. Dead pools are excluded rather than reported as perfect pegs.',
    tags: ['rwa','tokenized-stocks','peg','ranking','exclusive'],
    schema: { days: z.number().optional().describe('lookback 1-30, default 7'), min_liquidity_usd: z.number().optional().describe('filter out thinner pools') },
    run: (a) => P.getPegUniverse(a) },
  // ---- overhang: exit liquidity on lending collateral (own tape, nobody else measures this) ----
  { name: 'get_exit_quote', route: 'GET /api/exit-quote', usd: 0.02,
    tags: ['collateral','lending','liquidations','exit-liquidity','solana','kamino','rwa','tokenized-stocks','risk','exclusive'],
    desc: "EXIT LIQUIDITY on seized collateral: what a liquidator ACTUALLY realises selling a Kamino reserve into live routing, versus the oracle price the protocol marks it at. Returns max_exitable_usd (largest clip whose liquidator margin is still positive, found by bisection, with its resolution width), the exitable fraction, the conservative bound at the 2% penalty floor, and for the nearest clip actually probed: realised USD, haircut bps and liquidator margin bps. Distinguishes a router that REFUSES to quote a token (permissioning, not illiquidity) from a book with no route (a real liquidity finding) - they are different facts and were one status until this split. A terminal verdict requires six consecutive agreeing observations from the symbol's own tape, so a single bad quote cannot produce a finding; withheld verdicts fall back to the last corroborated measurement with its age rather than returning null. Zero bad debt today does not disprove any of this - it means nobody has been forced to test it at size. Method, corroboration rules and row counts are free via get_exit_method.",
    schema: { symbol: z.string().describe('reserve symbol e.g. SPYx, cbBTC, FWDI, CRCLx (get_exit_method lists all covered)'),
              size_usd: z.number().optional().describe('clip size in USD you would need to exit; the nearest MEASURED clip is returned, never interpolated') },
    run: (a) => OV.getExitQuote({ query: a }) },

  // ---- Base / EVM reads over keyless public RPC ----
  // These three answered the three questions that carry essentially all crypto
  // demand measured on Telegraph (tools/base.js:4-8): the price of ETH, a
  // wallet balance on Base, and the Base gas price. They lived only in
  // telegraph.js and were never on the paid rail, so they are registered here
  // rather than lost when that mirror is unmounted.
  { name: 'get_eth_price', route: 'GET /api/eth-price', usd: 0.001,
    desc: 'ETH spot price in USD, aggregated across seven independent venues (CoinGecko, Coinbase, Kraken, Binance, OKX, Gemini, DefiLlama). Returns the lead figure plus every venue quote that answered, so a caller can see the spread rather than trust one exchange. Venues are ranked in a fixed declared order, not completion order, so identical market state always returns the same lead price.',
    tags: ['price', 'eth', 'ethereum', 'crypto', 'multi-venue'],
    schema: {},
    run: () => PX.getPriceQuotes('ETH') },
  { name: 'get_base_gas', route: 'GET /api/base-gas', usd: 0.001,
    desc: 'Base gas price (chain 8453) in BOTH gwei and wei, with base fee, priority fee and block number when the node supplies them. Both units are returned because a caller asking in wei and a caller asking in gwei are asking the same question. Served from keyless public RPC with three-node fallback, so there is no API key to rotate or expire.',
    tags: ['base', 'gas', 'l2', 'ethereum', 'evm'],
    schema: {},
    run: () => B.getBaseGas() },
  { name: 'get_base_balance', route: 'GET /api/base-balance', usd: 0.002,
    desc: 'ERC20 and native ETH wallet balance on Base or Ethereum mainnet, for a 0x address or an ENS name. decimals() and symbol() are read from the contract at request time rather than assumed, because assuming 18 reports a USDC balance a trillion times too large. ENS is resolved through two independent resolvers and the answer is used only when they agree, so a wrong address can never produce a confident balance for the wrong wallet. An unsupported chain is refused rather than silently answered from the wrong one.',
    tags: ['base', 'ethereum', 'wallet', 'balance', 'erc20', 'evm', 'ens'],
    schema: { address: z.string().describe('0x address (40 hex) or an ENS name ending .eth'),
              token: z.string().optional().describe('ERC20 contract address, or a known ticker: USDC, WETH, DAI, CBBTC, USDBC, CBETH, AERO, EURC. Omit for the native ETH balance'),
              chain: z.string().optional().describe('base (default) or ethereum') },
    run: (a) => B.getBaseBalance({ query: a }) },

  // ---- ENTRY TIER: four $0.001 routes, composed from functions above ----
  // The niche's six best-selling routes are all $0.001 and the single
  // most-bought is a universal primitive. These are the cheap front door;
  // the premium tape tools above keep their prices.
  { name: 'get_perp', route: 'GET /api/perp', usd: 0.001,
    tags: ['perps', 'funding', 'open-interest', 'liquidations', 'crypto', 'trading'],
    desc: 'Use when an agent needs one perp market in a single call. Returns cross-venue funding (Bybit, OKX, Hyperliquid), open interest with 1h/24h change, long/short ratio, and 24h liquidations with long/short split and biggest print from our own tape.',
    schema: { symbol: z.string().optional().describe('USDT perp symbol e.g. SOLUSDT, BTCUSDT (default SOLUSDT)') },
    run: (a) => EN.getPerp(a) },

  { name: 'get_liq_pulse', route: 'GET /api/liq-pulse', usd: 0.001,
    tags: ['liquidations', 'realtime', 'crypto', 'trading', 'exclusive'],
    desc: 'Use when an agent needs to know what is being liquidated right now. Returns the last 60 minutes across every USDT perp we record: total USD, long/short split, prints and the top 5 symbols. Declines with the tape age if our recording is stale.',
    schema: {},
    run: () => EN.getLiqPulse() },

  { name: 'get_funding_pulse', route: 'GET /api/funding-pulse', usd: 0.001,
    tags: ['funding', 'perps', 'screener', 'crowding', 'trading'],
    desc: 'Use when an agent needs the most extreme funding rates right now. Returns the 5 largest absolute annualised rates across the whole Bybit USDT perp universe, each with venue, 8h rate, open interest and 24h price move. One call, not a full screen.',
    schema: {},
    run: () => EN.getFundingPulse() },

  { name: 'get_spot', route: 'GET /api/price', usd: 0.001,
    tags: ['price', 'spot', 'crypto', 'multi-venue'],
    desc: 'Use when an agent needs a spot price without choosing a venue. Returns the price, the venue that actually served it, and a Pyth confidence when Pyth served. Coinbase, then Kraken, then Pyth Hermes. Serves SOL, BTC and ETH; anything else is declined.',
    schema: { symbol: z.string().optional().describe('SOL, BTC or ETH (default SOL). Anything else is declined with the supported list') },
    run: (a) => EN.getSpot(a) },
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

// expansion.js — 18 -> 44: single source of truth for the 26 new tools.
// Wiring is 3 one-line edits (see WIRING.md):
//   payments.js : Object.assign(PRICES, require('./expansion').PRICES_ADD)  + TAGS merge
//   server.js   : require('./expansion').register(app, tool)
//   mcp.js      : TOOL_DEFS.push(...require('./expansion').MCP_DEFS_ADD)
// Landing page, '/' JSON, /.well-known/x402.json and the MCP pricing tool all
// derive from PRICES / TOOL_DEFS, so counts stay in sync automatically.
'use strict';
const { z } = require('zod');
const PS = require('./lib/param-schemas');
const D = require('./tools/derivs');
const M = require('./tools/micro');
const L = require('./tools/liqdb');
const LF = require('./tools/liqfeed');
const S = require('./tools/solana2');
const P = require('./tools/peg');
const CF = require('./tools/cascade-forecast');
const OV = require('./tools/overhang');
const B = require('./tools/base');
const PX = require('./tools/prices');
const EN = require('./tools/entry');
const FR = require('./tools/fundingradar');
const MS = require('./tools/marketstate');
const MAC = require('./tools/macro');
const TF = require('./tools/tradfi');
const HP = require('./tools/honeypot');
const HW = require('./tools/hlwhales');
const WM = require('./tools/webmd');
const SEC = require('./tools/sec');
const H3 = require('./tools/hip3');
const FX = require('./tools/fxrates');
const BL = require('./tools/baselaunches');
const SIG = require('./tools/signals');
const KEYLIB = require('./lib/keys');
const BR = require('./tools/briefs');
const BRC = BR.config;
// R11 (14 Oct 2026): thirteen general-purpose routes (A) and seven language-model task routes (B)
const SANC = require('./tools/sanctions');
const EV = require('./tools/emailverify');
const DOM = require('./tools/domain');
const PAP = require('./tools/papers');
const WK = require('./tools/wiki');
const UT = require('./tools/utils');
const SP = require('./tools/solpretrade');
const OCRT = require('./tools/ocr');
const SUMT = require('./tools/summarize');
const EXTT = require('./tools/extract');
const TRT = require('./tools/translate');
const CLT = require('./tools/classify');
const INJT = require('./tools/injection');
const TXT = require('./tools/transcribe');

// The prepaid-key handlers need the store, which server.js builds after this module is loaded (payments.js and
// mcp.js read PRICES_ADD / MCP_DEFS_ADD from here first). server.js hands it over with setKeys().
const KEYS = { current: null };
const keys = () => {
  if (!KEYS.current) throw Object.assign(new Error('key sales are not available on this instance'), { status: 503 });
  return KEYS.current;
};

const sym = (d) => z.string().optional().describe(`USDT perp symbol e.g. SOLUSDT, BTCUSDT (default ${d})`);
// Twelve routes -- liq-heatmap, squeeze-score, six derivatives and four
// microstructure -- declared `symbol` REQUIRED here, while every one of their
// handlers resolves an absent symbol through normSym() in tools/derivs.js. A
// caller who left it out got a 200 for SOLUSDT; the Bazaar schema and the MCP
// tool schema, both generated from this line, told agents it was mandatory.
// The default is taken by RUNNING that normalizer rather than typed here, so the
// schema and the handlers cannot disagree again.
const SYM_DEFAULT = D._normSym(undefined);
const symDefault = sym(SYM_DEFAULT);


// ---- R9: the prepaid-key route descriptions and the optional query parameters of the buy routes
const KEYSCHEMA = {
  key_hash: z.string().optional().describe('sha256 hex (64 characters) of a key you generated yourself as afk_ + base58 of 32 random bytes: the server registers the hash and never sees the key'),
  prefix: z.string().optional().describe('the 8 characters after afk_ in that key, so /api/keys/balance can show it before the first use'),
};
const money = (n) => `$${n}`;
const KEYBUY = (k) => {
  const usd = KEYLIB.PACKS[k];
  return `${k === 'trial' ? 'Trial key' : 'Prepaid key'}: ${money(usd)} of credit for the AgentFeed routes, for bots that can set an HTTP header but cannot pay x402 per call (n8n, Freqtrade, Hummingbot, scripts, gateways). One payment on any exact rail returns an API key (afk_...) once, or, with key_hash=<sha256 hex of a key you generated>, registers your own key without the server ever seeing it. Send it as X-AgentFeed-Key (or Authorization: Bearer) on any paid GET: each call draws half the route's x402 price (minimum $0.0005) from the balance. GET /api/keys/balance reads it free. Usage credit, non-refundable, no expiry. Exact rails only: no half-price batch or Gateway accept on this route.`;
};
const KEYPASS = () => {
  const P = KEYLIB.PASS;
  return `Bot pass: ${money(P.usd)} flat for ${P.days} days of unlimited calls to ${P.allow.join(', ')} (cross-venue liquidation pressure in 5-second buckets, one call every 10 seconds), for bots that can set an HTTP header but cannot pay x402 per call (Hummingbot, Freqtrade, n8n, scripts, gateways). One payment on any exact rail returns an API key (afk_...) once, or, with key_hash=<sha256 hex of a key you generated>, registers your own key without the server ever seeing it. Send it as X-AgentFeed-Key (or Authorization: Bearer) on ${P.allow.join(', ')}: nothing is drawn per call, and the pass is refused on every other route. It starts when the payment settles and ends ${P.days} days later; GET /api/keys/balance shows the expiry, free. Non-refundable, cannot be topped up. Exact rails only: no half-price batch or Gateway accept on this route.`;
};
const KEYDAYPASS = () => {
  const P = KEYLIB.DAY_PASS;
  return `Day pass: ${money(P.usd)} flat for 24 hours of unlimited calls to ${P.allow.join(' and ')} (cross-venue liquidation pressure in 5-second buckets, and the recent liquidation tape), for bots that poll all day, can set an HTTP header, and pay by a default x402 client, which buys it as is. One payment on any exact rail returns an API key (afk_...) once, or, with key_hash=<sha256 hex of a key you generated>, registers your own key without the server ever seeing it. Send it as X-AgentFeed-Key (or Authorization: Bearer) on ${P.allow.join(' and ')}: nothing is drawn per call, each of the two routes answers one call every 10 seconds per key (6 a minute), and the pass is refused on every other route. It starts when the payment settles and ends 24 hours later; GET /api/keys/balance shows the expiry, free. Non-refundable, cannot be topped up. Exact rails only: no half-price batch or Gateway accept on this route.`;
};
const KEYSIGNALSPASS = (P) => {
  const span = P.days === 1 ? '24 hours' : `${P.days} days`;
  const show = (r) => r.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return `${P.days === 1 ? 'Signals day pass' : 'Signals pass'}: ${money(P.usd)} flat for ${span} of unlimited calls to the AgentFeed briefs and perp signal routes, for agents that run on a schedule with no one to approve a payment. The key goes in X-AgentFeed-Key and nothing is drawn per call. Each route answers one call every ${Object.values(P.pace)[0] / 1000} seconds per key. One payment on any exact rail returns an API key (afk_...) once, or, with key_hash=<sha256 hex of a key you generated>, registers the hash and never sees the key. Starts when the payment settles. Non-refundable, no top-up, a bearer secret. Exact rails only. Covers: ${P.allow.map(show).join(', ')}.`;
};
const KEYTOP = (k) => {
  const usd = KEYLIB.TOPUPS[k];
  return `Top up a prepaid key by ${money(usd)}: send the key as X-AgentFeed-Key and pay once on any exact rail; the balance grows when the payment settles, and the response is only delivered after it did. Needs an active key. Usage credit, non-refundable, no expiry. Exact rails only: no half-price batch or Gateway accept on this route.`;
};

const EXP = [
  { name: 'get_cascade_forecast', route: 'GET /api/cascade-forecast', usd: 0.02,
    tags: ['forecast','liquidations','cascade','prediction','exclusive'], desc: 'Liquidation forecast, FORWARD-LOOKING and not a description of what already happened. Returns the probability that a symbol will liquidate more in the NEXT 15 minutes than its own 90th-percentile 15-minute window. Calibrated on our whole multi-venue liquidation tape, over 6 million liquidations, refit every 6 hours; no exchange publishes that history, so it cannot be rebuilt. Every answer carries the exact question, the threshold in USD, the window it read, the number of historical occurrences behind the number, and instructions for settling it yourself from the public feed. When a state has too little history the tool DECLINES rather than guessing, and says why. The settled record is free at /api/forecast-record.',
    schema: { symbol: z.string().optional().describe('SOL, BTC, ETH or any USDT perp e.g. SXTUSDT (default SOL)'),
              symbols: z.string().optional().describe('comma separated for a batch, max 20, e.g. SOL,BTC,ETH') },
    run: (a) => CF.getCascadeForecast({ query: a }) },
  // ---- MOAT: our own liquidation tape (nobody can clone these) ----
  { name: 'get_liq_history', route: 'GET /api/liq-history', usd: 0.05,
    desc: 'Liquidation history, time-bucketed: total, long and short USD, prints and biggest print per bucket, for any USDT perp or the whole recorded universe, up to 7 days back. Bybit is the only complete liq tape in crypto and no exchange publishes history of it.',
    tags: ['liquidations', 'history', 'crypto', 'trading', 'exclusive'],
    schema: { symbol: sym('SOLUSDT'), scope: z.enum(['symbol', 'all']).optional().describe('all = whole universe'), hours: z.number().optional().describe('lookback 1-168, default 24'), bucket_min: z.number().optional().describe('bucket minutes 5-1440, default 60') },
    run: (a) => L.getLiqHistory(a) },
  { name: 'get_liq_heatmap', route: 'GET /api/liq-heatmap', usd: 0.02,
    desc: 'Liquidation heatmap by PRICE LEVEL: where leverage actually got flushed in the last N hours — USD, prints and long/short split per price zone, with the hottest zone flagged. Built from real liquidation prints, not entry-price estimates. BTC, ETH, SOL, HYPE or any other USDT perp on our multi-venue liquidation tape.',
    tags: ['liquidations', 'heatmap', 'levels', 'trading', 'exclusive'],
    schema: { symbol: z.string().optional().describe(`BTC, ETH, SOL, HYPE or any USDT perp e.g. BTCUSDT (default ${SYM_DEFAULT})`), hours: z.number().optional().describe('lookback 1-168, default 24'), buckets: z.number().optional().describe('price buckets 5-50, default 20') },
    run: (a) => L.getLiqHeatmap(a) },
  { name: 'get_cascade_history', route: 'GET /api/cascade-history', usd: 0.03,
    desc: 'Liquidation cascade history: past clustered same-side flush events reconstructed from our own tape, with start and end, prints, USD total and peak print, up to 72h back. /api/cascade tells you what is happening NOW; this tells you what already happened.',
    tags: ['liquidations', 'cascade', 'history', 'trading', 'exclusive'],
    schema: { symbol: sym('SOLUSDT'), scope: z.enum(['symbol', 'all']).optional().describe('symbol = just this symbol (default), all = every recorded USDT perp'), hours: z.number().optional().describe('1-72, default 24'), min_usd: z.number().optional().describe('min event USD, default 100k (250k for scope=all)'), gap_s: z.number().optional().describe('max gap seconds within an event, default 60') },
    run: (a) => L.getCascadeHistory(a) },
  { name: 'get_squeeze_score', route: 'GET /api/squeeze-score', usd: 0.10,
    desc: 'Short squeeze score and long flush score, 0-100, for any Hyperliquid perp. Composite of Hyperliquid funding (35), whale crowding (25: the net-long share of the top 250 Hyperliquid accounts in the coin, not retail), the 24h open-interest build from our own 5-minute sampler (20) and liquidation skew from our own tape (20). One number for whether a trade is crowded and about to hurt someone. A symbol nothing lists answers 400; while the open-interest record is under 24 hours deep, or Hyperliquid or the whale snapshot is unavailable, it answers 503; both are never billed. A listed coin none of the top 250 accounts holds returns 200 with a decline naming the missing input.',
    tags: ['squeeze', 'signal', 'liquidations', 'funding', 'hyperliquid', 'trading', 'exclusive'],
    schema: { symbol: symDefault },
    run: (a) => L.getSqueezeScore(a) },
  { name: 'get_venue_liq_share', route: 'GET /api/venue-liq-share', usd: 0.02,
    desc: 'Liquidations by exchange: per-venue liquidation share across Bybit, OKX and Binance with long/short split and biggest print, for any symbol or the whole recorded universe. Which venue is flushing whom.',
    tags: ['liquidations', 'exchanges', 'crypto', 'trading'],
    schema: { symbol: sym('all'), hours: z.number().optional().describe('1-168, default 24') },
    run: (a) => L.getVenueLiqShare(a) },

  // ---- derivatives suite ----
  { name: 'get_funding_extremes', route: 'GET /api/funding-extremes', usd: 0.02,
    desc: 'Funding rate extremes across every Hyperliquid perp above a liquidity floor: the most positive and most negative funding with annualized %, 24h price move and open interest. The most crowded trades in the market — crowded shorts are squeeze candidates.',
    tags: ['funding', 'screener', 'crowding', 'hyperliquid', 'trading'],
    schema: { limit: z.number().optional().describe('top N each side, 1-25, default 10'), min_turnover_usd: z.number().optional().describe('24h volume floor in USD, default 1M') },
    run: (a) => D.getFundingExtremes(a) },
  // Served from a snapshot the cron collector (bin/funding-radar-collect.js)
  // writes every 5 minutes; a paid request never calls a venue.
  { name: 'get_funding_radar', route: 'GET /api/funding-radar', usd: 0.02,
    desc: "Funding radar over every Hyperliquid perp: 337 on 13 Oct 2026, 178 on the main dex and 159 on the HIP-3 dexes (stocks, indices, commodities, FX). Per perp: the current funding at its 8h equivalent, its 30-day z-score against its own settled history, the dex and asset class, and a flag on any |z| of 2 or more, most extreme first. By default it returns the perps with $10M and up of open interest; min_oi_usd changes that and 0 returns them all. Precomputed every 5 minutes with as_of; a snapshot older than 15 minutes answers 503 and is never billed.",
    tags: ['funding', 'perps', 'screener', 'z-score', 'hyperliquid', 'hip-3', 'trading'],
    schema: { top: z.number().optional().describe('perps returned, most extreme first, 1-100, default 20'),
              min_oi_usd: z.number().optional().describe('minimum open interest in USD: default 10000000 ($10M); 0 returns every perp the radar tracks') },
    run: (a) => FR.getFundingRadar(a) },
  // ---- market state, macro clock (S3, 2026-10-08; the options desk was withdrawn 2026-10-13) ----
  { name: 'get_market_state', route: 'GET /api/market-state', usd: 0.02,
    desc: 'Market state for BTC, ETH, SOL or HYPE in one call: spot and the perp\'s basis against the Hyperliquid oracle, realized vol 7d and 30d, funding with its 30-day z-score, open interest and its changes, the top Hyperliquid accounts\' net-long share, liquidations 1h and 24h by side, Fear and Greed, the next FOMC or CPI release, and flags with stated thresholds. Every part carries its source and as-of time; a part we do not hold is null with a reason. When nothing of the market itself could be built it answers 503 and is never billed.',
    tags: ['market-data', 'funding', 'liquidations', 'macro', 'hyperliquid', 'trading'],
    schema: { symbol: z.string().optional().describe('BTC (default), ETH, SOL or HYPE') },
    run: (a) => MS.getMarketState(a) },
  { name: 'get_macro_calendar', route: 'GET /api/macro-calendar', usd: 0.005,
    desc: "FOMC, CPI, NFP and PCE calendar for traders: the next Fed rate decisions and the CPI, nonfarm payrolls and PCE release dates with UTC times converted from New York time (DST-aware), each with its official Fed, BLS or BEA source URL and the time we verified it. Read daily from the agencies' own pages and never entered by hand; data verified more than 35 days ago answers 503 and is never charged.",
    tags: ['macro', 'fomc', 'cpi', 'calendar', 'economic-data'],
    schema: { type: z.string().optional().describe('comma list of FOMC, CPI, NFP, PCE (default all)'),
              days: z.number().optional().describe('days ahead, 1-400, default 90') },
    run: (a) => MAC.getMacroCalendar(a) },
  // TradFi perps: HIP-3 markets ride the funding-radar collector and snapshot.
  { name: 'get_tradfi_radar', route: 'GET /api/tradfi-radar', usd: 0.02,
    desc: 'Stock perps, S&P 500, Nasdaq, gold and oil perps ranked by funding rate: every stock, index, commodity and FX perp on the Hyperliquid HIP-3 dexes (trade[XYZ], Paragon, Markets by Kinetiq, Entropy), with funding at its 8h equivalent, a 30-day funding z-score, open interest and its 24h change, mark minus oracle basis and 24h volume. Filter by asset class. Precomputed every 5 minutes; stale data answers 503.',
    tags: ['stock-perps', 'funding', 'tradfi', 'commodities', 'indices', 'hyperliquid', 'trading'],
    schema: { class: z.string().optional().describe('comma list of stock, index, commodity, fx, rates, pre_ipo, crypto_index, other (default all)'),
              top: z.number().optional().describe('markets returned, 1-200, default 25'),
              min_oi_usd: z.number().optional().describe('minimum open interest in USD (default 0)') },
    run: (a) => TF.getTradfiRadar(a) },
  { name: 'get_equity_24h', route: 'GET /api/equity-24h', usd: 0.01,
    desc: "Weekend price for US stocks: an indicative 24/7 price for a stock or index (TSLA, NVDA, S&P 500, Nasdaq) from stock perps on Hyperliquid and our tokenized stocks DEX price, with the last regular-session price, its time and source, the implied gap in %, each source's liquidity and the session (open, pre, after, overnight, weekend). Indicative, never an exchange quote; 503 when no source has liquidity.",
    tags: ['tokenized-stocks', 'stock-perps', 'weekend-price', 'equities', 'indicative-price'],
    schema: { symbol: z.string().describe('US stock or index ticker as the venues list it, e.g. TSLA, NVDA, SP500, XYZ100') },
    run: (a) => TF.getEquity24h(a) },
  { name: 'get_open_interest', route: 'GET /api/open-interest', usd: 0.01,
    desc: 'Open interest for ANY Hyperliquid perp: OI in base units and in USD with the mark price, and its 1h and 24h change from our own 5-minute sampler (null until that record reaches back so far). /api/positioning adds the whale net-long share for SOL and BTC.',
    tags: ['open-interest', 'perps', 'hyperliquid', 'trading'],
    schema: { symbol: symDefault }, run: (a) => D.getOpenInterest(a) },
  { name: 'get_oi_spike_scan', route: 'GET /api/oi-spike-scan', usd: 0.02,
    desc: 'Open interest spikes across every Hyperliquid perp: coins whose open interest moved abnormally in the last hour against their own previous day, with the 1h, 4h and 24h change (in coin units, so a price move does not count), a spike z-score, the price move and funding. Read from our own 5-minute sampler: it answers 503 and is never billed until that record is 24 hours deep.',
    tags: ['open-interest', 'screener', 'anomaly', 'hyperliquid', 'trading'],
    schema: { limit: z.number().optional().describe('top N, 1-25, default 10') },
    run: (a) => D.getOiSpikeScan(a) },
  { name: 'get_basis', route: 'GET /api/basis', usd: 0.01,
    desc: 'Perp basis for any Hyperliquid perp: its mark price against Hyperliquid\'s oracle price (the validators\' weighted median of spot venues), as a premium or discount in %, with a contango or backwardation read and the funding context.',
    tags: ['basis', 'perps', 'oracle', 'hyperliquid', 'trading'],
    schema: { symbol: symDefault }, run: (a) => D.getBasis(a) },
  { name: 'get_volatility', route: 'GET /api/volatility', usd: 0.01,
    desc: 'Realized volatility for any Hyperliquid perp: 7-day and 30-day annualized from daily candles, plus today\'s range in %. A position-sizing input.',
    tags: ['volatility', 'risk', 'hyperliquid', 'trading'],
    schema: { symbol: symDefault }, run: (a) => D.getVolatility(a) },
  { name: 'get_funding_history', route: 'GET /api/funding-history', usd: 0.005,
    desc: 'Funding rate history for any Hyperliquid perp, up to 200 hourly settlements: the average rate, its annualized %, the share of intervals that were positive, and the raw series. What the carry has actually been.',
    tags: ['funding', 'history', 'carry', 'hyperliquid', 'trading'],
    schema: { symbol: symDefault, limit: z.number().optional().describe('hourly settlements, 1-200, default 30') },
    run: (a) => D.getFundingHistory(a) },
  { name: 'get_top_movers', route: 'GET /api/top-movers', usd: 0.01,
    desc: 'Top gainers and losers over 24h across every Hyperliquid perp above a liquidity floor, each with its funding rate attached. The "what moved" screener.',
    tags: ['movers', 'screener', 'hyperliquid', 'trading'],
    schema: { limit: z.number().optional().describe('top N each side, 1-25, default 10'), min_turnover_usd: z.number().optional().describe('24h volume floor in USD, default 1M') },
    run: (a) => D.getTopMovers(a) },
  // ---- microstructure suite ----
  { name: 'get_orderbook_imbalance', route: 'GET /api/orderbook-imbalance', usd: 0.01,
    desc: 'Orderbook imbalance for any Hyperliquid perp: resting bid and ask liquidity in USD within ±N bps of mid, the ratio between the two sides, and a skew read.',
    tags: ['orderbook', 'microstructure', 'depth', 'hyperliquid', 'trading'],
    schema: { symbol: symDefault, bps: z.number().optional().describe('window ±bps around mid, 5-500, default 50') },
    run: (a) => M.getOrderbookImbalance(a) },
  { name: 'get_orderbook_walls', route: 'GET /api/orderbook-walls', usd: 0.01,
    desc: 'Orderbook walls for any Hyperliquid perp: the largest resting orders on each side of the book, with USD size and distance from mid.',
    tags: ['orderbook', 'walls', 'levels', 'hyperliquid', 'trading'],
    schema: { symbol: symDefault, top: z.number().optional().describe('walls per side, 1-15, default 5') },
    run: (a) => M.getOrderbookWalls(a) },
  // ---- Solana suite ----
  { name: 'get_token_holders', route: 'GET /api/token-holders/:mint', usd: 0.02,
    desc: 'Top holders of any SPL token: per-account share with top-1, top-5 and top-10 concentration for a Solana mint. A deeper cut than the summary in /api/token-risk.',
    tags: ['solana', 'tokens', 'holders', 'onchain'],
    schema: { mint: PS.mint('SPL token mint address (base58)') },
    run: (a) => S.getTokenHolders(a) },
  { name: 'get_wallet_activity', route: 'GET /api/wallet-activity/:wallet', usd: 0.02,
    desc: 'Solana wallet activity: recent transactions for any address, each with the wallet\'s SOL and token balance changes, the fee, failures and the programs invoked. Read from the chain and summarised by us.',
    tags: ['solana', 'wallet', 'transactions', 'onchain'],
    schema: { wallet: PS.wallet('Solana wallet address (base58)'), limit: z.number().optional().describe('tx count, 1-25, default 10') },
    run: (a) => S.getWalletActivity(a) },
  { name: 'get_priority_fees', route: 'GET /api/priority-fees', usd: 0.005,
    desc: 'Solana priority fees right now: percentiles from min to max of the per-slot minimum fee paid on the busiest SOL/USDC pools over the last ~150 slots, in micro-lamports per compute unit, with a recommended level. For bots that need their transactions to land.',
    tags: ['solana', 'fees', 'network', 'onchain'],
    schema: {}, run: () => S.getPriorityFees() },
  { name: 'get_jito_tips', route: 'GET /api/jito-tips', usd: 0.005,
    desc: 'Jito tips sampled on-chain: p25 to p99 in SOL of the newest transfers into Jito\'s tip accounts, what landed bundles actually paid, refreshed every 15 minutes (the age is in the answer), with a landing recommendation.',
    tags: ['solana', 'jito', 'mev', 'fees'],
    schema: {}, run: () => S.getJitoTips() },
  { name: 'get_sol_network', route: 'GET /api/sol-network', usd: 0.005,
    desc: 'Solana network health: recent average TPS, the current slot, the current epoch and epoch progress in %.',
    tags: ['solana', 'network', 'tps', 'onchain'],
    schema: {}, run: () => S.getSolNetwork() },

  // ---- DeFi / macro suite ----

  // ---- MOAT: our own tokenized-equity peg tape ----
  { name: 'get_peg_deviation', route: 'GET /api/peg-deviation', usd: 0.02,
    desc: 'Tokenized stock peg deviation on Solana: the on-chain DEX price of a tokenized US equity versus the underlying\'s last real trade, in bps, with 24h stats split into market-open and off-hours. Sampled every 5 minutes by our own collector; the token price is read on-chain. latest.reference is null: the underlying\'s reference price is not returned (its source does not allow redistribution), only the deviation computed from it.',
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
    desc: 'ETH spot price in USD, read on-chain from the two deepest WETH/USDC Uniswap V3 pools, on Ethereum and on Base. Returns their median plus each pool\'s own price, so a caller can see the spread between chains. Computed from chain state; no exchange feed.',
    tags: ['price', 'eth', 'ethereum', 'crypto', 'onchain', 'dex'],
    schema: {},
    run: () => PX.getPriceQuotes('ETH') },
  { name: 'get_base_gas', route: 'GET /api/base-gas', usd: 0.005,
    desc: 'Base gas price (chain 8453) in BOTH gwei and wei, with base fee, priority fee and block number when the node supplies them. Both units are returned because a caller asking in wei and a caller asking in gwei are asking the same question. Served from keyless public RPC with three-node fallback, so there is no API key to rotate or expire.',
    tags: ['base', 'gas', 'l2', 'ethereum', 'evm'],
    schema: {},
    run: () => B.getBaseGas() },
  { name: 'get_base_balance', route: 'GET /api/base-balance', usd: 0.005,
    desc: 'ERC20 and native ETH wallet balance on Base or Ethereum mainnet, for a 0x address or an ENS name. decimals() and symbol() are read from the contract at request time rather than assumed, because assuming 18 reports a USDC balance a trillion times too large. ENS is resolved through two independent resolvers and the answer is used only when they agree, so a wrong address can never produce a confident balance for the wrong wallet. An unsupported chain is refused rather than silently answered from the wrong one.',
    tags: ['base', 'ethereum', 'wallet', 'balance', 'erc20', 'evm', 'ens'],
    schema: { address: z.string().describe('0x address (40 hex) or an ENS name ending .eth'),
              token: z.string().optional().describe('ERC20 contract address, or a known ticker: USDC, WETH, DAI, CBBTC, USDBC, CBETH, AERO, EURC. Omit for the native ETH balance'),
              chain: z.string().optional().describe('base (default) or ethereum') },
    run: (a) => B.getBaseBalance({ query: a }) },

  // ---- R3 (2026-10-12): Base token safety and launches, from on-chain reads only ----
  // honeypot-check runs our own buy-then-sell simulation (tools/honeypot.js);
  // base-launches serves the snapshot bin/base-launches-collect.js writes every minute.
  // launch-odds and rwa-yields shipped in R3 and were withdrawn in R4 (source terms).
  { name: 'get_honeypot_check', route: 'GET /api/honeypot-check', usd: 0.01,
    tags: ['base', 'honeypot', 'rug-check', 'token-security', 'simulation', 'evm'],
    desc: 'Use when an agent needs to know whether a token on Base, BNB Chain or Ethereum can be sold before it buys. Returns a verdict from our own buy-then-sell simulation on the token\'s deepest pool, with the buy and sell tax measured. Also: whether a wallet transfer works, bytecode flags (mintable, blacklist, proxy, pausable, owner), where simulation and bytecode disagree, and the block. Uniswap, Aerodrome and PancakeSwap pools. No pool found is a finding; RPC failure answers 503.',
    schema: { token: z.string().describe('token contract address, 0x followed by 40 hex characters'),
              chain: z.string().optional().describe('base (default: Uniswap V2/V3/V4, Aerodrome), bsc (PancakeSwap V2/V3) or ethereum (Uniswap V2/V3)') },
    run: (a) => HP.getHoneypotCheck(a) },
  { name: 'get_base_launches', route: 'GET /api/base-launches', usd: 0.02,
    tags: ['base', 'new-tokens', 'launches', 'uniswap-v4', 'memecoins', 'dex'],
    desc: 'Use when an agent needs the newest token launches on Base. Returns pools created on Base in the last 24 hours on Uniswap V4, V3, V2 and Aerodrome, newest first, with launchpad, liquidity and volume. Each carries its pair, creation time, launchpad named from the V4 hook (Zora, Clanker, Doppler, Flaunch), quote-side liquidity, 24h volume and swaps, and our honeypot simulation for the busiest. Read from Base logs every minute; a snapshot older than 5 minutes answers 503.',
    schema: { min_liq_usd: PS.q('GET /api/base-launches', 'min_liq_usd', 'minimum quote-side liquidity (ETH, WETH or USDC held) in USD, default 1000; 0 lists every launch'),
              limit: PS.q('GET /api/base-launches', 'limit', 'launches returned, newest first, 1-100, default 20') },
    run: (a) => BL.getBaseLaunches(a) },

  // ---- R4 (2026-10-12): Hyperliquid whale positioning, on demand with a 5-minute cache ----
  { name: 'get_hl_whales', route: 'GET /api/hl-whales', usd: 0.02,
    tags: ['hyperliquid', 'whales', 'smart-money', 'positioning', 'liquidations', 'perps', 'trading'],
    desc: 'Use when an agent needs to know how the biggest Hyperliquid traders are positioned. Returns the open perp positions of the largest Hyperliquid accounts aggregated per coin: net long or short USD, account counts, size-weighted entries, notional-weighted distance to liquidation, notional within 10% of liquidation and uPnL. With coin=BTC: whale liquidation levels in 5% price bands and the largest positions. Refreshed every 5 minutes; stale data answers 503.',
    schema: { coin: z.string().optional().describe('one Hyperliquid perp, e.g. BTC, ETH, SOL, HYPE: adds liquidation bands and the top positions'),
              top: PS.q('GET /api/hl-whales', 'top', 'coins (or positions with coin=) returned, 1-50, default 20') },
    run: (a) => HW.getHlWhales(a) },

  // ---- R5 (2026-10-12): web and PDF to markdown, SEC EDGAR, HIP-3 tradfi perps, FX ----
  { name: 'get_web_markdown', route: 'GET /api/web-markdown', usd: 0.005,
    tags: ['web', 'markdown', 'scrape', 'readability', 'research', 'rag'],
    desc: 'Use when an agent needs the readable text of a web page as markdown. Returns the main content of the one URL you pass as clean markdown (Mozilla Readability, then turndown), with title, final URL, fetch time and word count. http or https on ports 80 and 443, 5 MB, 10 s; robots.txt honoured and private addresses refused. A blocked or unreachable URL is never charged.',
    schema: { url: z.string().describe('the page to convert: an absolute http or https URL') },
    run: (a) => WM.getWebMarkdown(a) },
  { name: 'get_pdf_markdown', route: 'GET /api/pdf-markdown', usd: 0.01,
    tags: ['pdf', 'markdown', 'documents', 'research', 'rag'],
    desc: 'Use when an agent needs the text of a PDF as markdown. Returns the text of the one PDF URL you pass, page by page as markdown, with title, page count and word count. http or https, 10 MB, 10 s; robots.txt honoured and private addresses refused. A file that is not a PDF, a PDF with no text layer (a scan), or an unreachable URL, is never charged.',
    schema: { url: z.string().describe('the PDF to convert: an absolute http or https URL') },
    run: (a) => WM.getPdfMarkdown(a) },
  { name: 'get_sec_filings', route: 'GET /api/sec-filings', usd: 0.005,
    tags: ['sec', 'edgar', 'filings', 'stocks', '10-k', '10-q', '8-k'],
    desc: 'Use when an agent needs a US company\'s latest SEC filings. Returns the most recent EDGAR filings for a ticker, optionally one form type (10-K, 10-Q, 8-K, 4, S-1, 13F-HR), with filing date, report date, accession number, description, 8-K item codes and links to the document and the filing index. Source: SEC EDGAR public filings.',
    schema: { ticker: z.string().describe('a US-listed ticker, e.g. AAPL, MSFT, BRK-B'),
              form: z.string().optional().describe('one EDGAR form type, e.g. 10-K, 10-Q, 8-K, 4'),
              limit: PS.q('GET /api/sec-filings', 'limit', 'filings returned, 1-50, default 10') },
    run: (a) => SEC.getSecFilings(a) },
  { name: 'get_insider_trades', route: 'GET /api/insider-trades', usd: 0.01,
    tags: ['sec', 'insider-trading', 'form-4', 'stocks', 'edgar'],
    desc: 'Use when an agent needs what a company\'s insiders bought and sold. Returns one row per transaction from the company\'s recent SEC Form 4 filings: insider, role, transaction code and meaning, shares, price, value, shares owned after and date, plus open-market buy and sale totals for the window. Source: SEC EDGAR Form 4 filings.',
    schema: { ticker: z.string().describe('a US-listed ticker, e.g. NVDA, TSLA'),
              days: PS.q('GET /api/insider-trades', 'days', 'look-back window in days, 1-180, default 30') },
    run: (a) => SEC.getInsiderTrades(a) },
  { name: 'get_sec_8k', route: 'GET /api/sec-8k', usd: 0.01,
    tags: ['sec', '8-k', 'material-events', 'stocks', 'edgar', 'news'],
    desc: 'Use when an agent needs the material events US companies disclosed in the last hours. Returns the 8-K filings filed across the market in the window, with company, CIK, filing time, accession number, the 8-K item codes and titles (e.g. 2.02 results, 5.02 officer changes, 1.01 agreements) and a count per item. Source: SEC EDGAR current filings.',
    schema: { hours: PS.q('GET /api/sec-8k', 'hours', 'look-back window in hours, 1-72, default 24') },
    run: (a) => SEC.getSec8k(a) },
  { name: 'get_tradfi_perps', route: 'GET /api/tradfi-perps', usd: 0.005,
    tags: ['stocks', 'indices', 'commodities', 'fx', 'hyperliquid', 'hip-3', '24-7'],
    desc: 'Use when an agent needs a 24/7 price for a stock, index, commodity or currency outside market hours. Returns Hyperliquid HIP-3 perp markets: oracle and mark price, premium, hourly and 8h funding, open interest, 24h change and the dex. With symbol (TSLA, GOLD, EUR or xyz:TSLA): every live market for it. Without: the whole list. Prices are each market\'s own HIP-3 oracle and mark.',
    schema: { symbol: z.string().optional().describe('a HIP-3 ticker such as TSLA, GOLD, EUR, or a dex-qualified market such as xyz:TSLA') },
    run: (a) => H3.getTradfiPerps(a) },
  { name: 'get_fx_rates', route: 'GET /api/fx-rates', usd: 0.002,
    tags: ['fx', 'currencies', 'ecb', 'exchange-rates', 'macro'],
    desc: 'Use when an agent needs official daily exchange rates. Returns the ECB euro foreign exchange reference rates for about 30 currencies, as published or as crosses for another base, plus Hyperliquid HIP-3 FX and commodity marks. The ECB rates are available free of charge on the ECB\'s website; they are for information only, not for transactions.',
    schema: { base: z.string().optional().describe('base currency, 3 letters, default EUR; other bases are crosses computed from the ECB rates') },
    run: (a) => FX.getFxRates(a) },

  // ---- ENTRY TIER: four routes, composed from functions above ----
  // $0.001 until 2026-10-08, now $0.005: the CDP facilitator charges $0.001 per
  // settlement past 1,000 a month, so a $0.001 route earns nothing at volume.
  // The niche's six best-selling routes are all $0.001 and the single
  // most-bought is a universal primitive. These are the cheap front door;
  // the premium tape tools above keep their prices.
  { name: 'get_perp', route: 'GET /api/perp', usd: 0.005,
    tags: ['perps', 'funding', 'open-interest', 'liquidations', 'hyperliquid', 'trading'],
    desc: 'Use when an agent needs one perp market in a single call. Returns Hyperliquid funding and open interest (with 1h/24h change from our 5-minute sampler) and 24h liquidations with long/short split and biggest print from our own tape. A symbol nothing lists answers 400 and a failed read answers 503; neither is ever billed.',
    schema: { symbol: z.string().optional().describe('USDT perp symbol e.g. SOLUSDT, BTCUSDT (default SOLUSDT)') },
    run: (a) => EN.getPerp(a) },
  { name: 'get_liq_pulse', route: 'GET /api/liq-pulse', usd: 0.005,
    tags: ['liquidations', 'realtime', 'crypto', 'trading', 'exclusive'],
    desc: 'Use when an agent needs to know what is being liquidated right now. Returns the last 60 minutes across every USDT perp we record: total USD, long/short split, prints and the top 5 symbols. If our recording is stale it answers 503 and is never billed.',
    schema: {},
    run: () => EN.getLiqPulse() },
  // task #90 (15 Oct 2026): cross-venue liquidation pressure in 5 s buckets, computed (never a print, no venue named); docs/SOURCES.md C7.
  { name: 'get_liq_feed', route: 'GET /api/liq-feed', usd: 0.001,
    tags: ['liquidations', 'pressure', 'realtime', 'cascade', 'bots', 'trading'],
    desc: "Use when an agent needs liquidation pressure as it happens. Returns 5-second buckets per symbol of long and short USD liquidated across venues, the dominant side and pressure against the symbol's own baseline, from a gap-free cursor.",
    schema: { symbols: z.string().optional().describe('comma list of up to 20 symbols, e.g. BTC,ETH,SOL or BTCUSDT,ETHUSDT (default SOL,BTC,ETH,XRP,DOGE)'),
              since: z.number().optional().describe('first call only: start time in milliseconds since the epoch, up to 24 h back; omit to begin 2 minutes back'),
              next: z.string().optional().describe('the `next` value of the previous answer; send it back unchanged to continue with no gap and no repeat') },
    // one line in the 402 description only (payments.challengeLead): the catalogue description stays inside its 180-255 band
    // the 402 description is capped at 400 characters (payments.CHALLENGE_DESC_MAX): both intervals and the day pass in one short note
    challengeNote: () => `One call per ${LF.CALLER_INTERVAL_MS / 1000} s, ${LF.PASS_INTERVAL_MS / 1000} s on a pass. Heavy pollers: ${money(KEYLIB.DAY_PASS.usd)} day pass, ${KEYLIB.DAY_PASS.path}.`,
    docNote: () => LF.PACE_SENTENCE,   // openapi, llms.txt, SKILL.md and the MCP tool description state the pace in full
    mcpGate: true,   // R15d/R15e: over MCP a caller is gated on the REST clock (mcp.js hands { caller })
    run: (a, req) => LF.getLiqFeed(a, req) },
  { name: 'get_funding_pulse', route: 'GET /api/funding-pulse', usd: 0.005,
    tags: ['funding', 'perps', 'screener', 'crowding', 'hyperliquid', 'trading'],
    desc: 'Use when an agent needs the most extreme funding rates right now. Returns the 5 largest absolute annualised rates across the Hyperliquid perps above a liquidity floor, each with 8h rate, open interest and 24h price move. One call, not a full screen.',
    schema: {},
    run: () => EN.getFundingPulse() },
  { name: 'get_spot', route: 'GET /api/price', usd: 0.001,
    tags: ['price', 'spot', 'crypto', 'onchain', 'dex'],
    desc: 'Use when an agent needs a spot price without choosing a venue. Returns the on-chain DEX price for SOL, BTC or ETH, the median of deep USDC pools on Solana, Ethereum and Base read from chain state, and the pools that served it. Any other symbol answers 400 with the supported list and is never billed.',
    schema: { symbol: z.string().optional().describe('SOL, BTC or ETH (default SOL). Any other symbol answers 400 with the supported list') },
    run: (a) => EN.getSpot(a) },

  // ---- R9 (2026-10-14): two routes for trading loops, and prepaid keys for bots that cannot pay x402 ----
  // signal-board and coin-signal read only what this box already holds (tools/signals.js); the six key routes
  // (lib/keys.js) sell credit. `noHf`: the key routes carry the exact accepts only, because credit bought at the
  // high-frequency half price would be a free 50%. `mcp: false`: a key is bought over HTTP, never as an MCP tool.
  { name: 'get_signal_board', route: 'GET /api/signal-board', usd: 0.01,
    tags: ['signals', 'trading', 'bots', 'hyperliquid', 'funding', 'open-interest', 'liquidations', 'whales', 'exclusive'],
    desc: 'Signal board for trading bots: the Hyperliquid perp market in one table, ranked by open interest in USD (30 coins by default, up to 60, or the coins you list). Per coin: mark, 1h and 24h price change, funding (hourly and annualised), open interest in USD with its 1h and 24h change, liquidations in the last hour by side with a z-score against the coin\'s own last 7 days, the whale net position and tilt of the top 250 Hyperliquid accounts, and flags: crowded_long (' + SIG.RULES.crowded_long + '), crowded_short (' + SIG.RULES.crowded_short + '), squeeze_risk (' + SIG.RULES.squeeze_risk + '), liq_spike (' + SIG.RULES.liq_spike + '). Poll every 1-5 minutes: one call is the whole market structure, answered from our own caches, each source named with its as_of. A source past its staleness limit answers 503 and is never billed.',
    schema: { n: PS.q('GET /api/signal-board', 'n', 'coins returned, ranked by open interest in USD, 1-60, default 30'),
              coins: z.string().optional().describe('comma list of Hyperliquid coins instead of the top n, at most 20, e.g. BTC,ETH,SOL') },
    run: (a) => SIG.getSignalBoard(a) },
  { name: 'get_coin_signal', route: 'GET /api/coin-signal/:coin', usd: 0.004,
    tags: ['signals', 'trading', 'bots', 'hyperliquid', 'funding', 'open-interest', 'liquidations', 'whales', 'exclusive'],
    desc: 'Signal for one Hyperliquid perp, for trading bots. Everything on the signal board for the coin (price changes, funding, open interest, liquidations with their z-score, whale net position and tilt, flags) plus the 15-minute liquidation cascade probability from our forecast model, the nearest liquidation cluster above and below price from the 24 h liquidation heatmap, and the top 3 whale positions (side, size, entry, liquidation price). BTC, ETH, SOL, HYPE or any other Hyperliquid perp. Poll every 1-5 minutes. An unknown coin answers 400 with the supported list and a stale source answers 503; neither is billed.',
    schema: { coin: PS.coin('a Hyperliquid perp, e.g. BTC, ETH, SOL, HYPE, kPEPE') },
    run: (a) => SIG.getCoinSignal(a) },
  { name: 'buy_key_trial', route: 'GET /api/keys/buy-trial', usd: 0.25, noHf: true, mcp: false,
    tags: ['api-key', 'prepaid', 'bots', 'credit'],
    desc: KEYBUY('trial'),
    schema: KEYSCHEMA,
    run: (a, req) => keys().buy(a, req, 0.25) },
  { name: 'buy_key_1', route: 'GET /api/keys/buy-1', usd: 1, noHf: true, mcp: false,
    tags: ['api-key', 'prepaid', 'bots', 'credit'],
    desc: KEYBUY('1'),
    schema: KEYSCHEMA,
    run: (a, req) => keys().buy(a, req, 1) },
  { name: 'buy_key_5', route: 'GET /api/keys/buy-5', usd: 5, noHf: true, mcp: false,
    tags: ['api-key', 'prepaid', 'bots', 'credit'],
    desc: KEYBUY('5'),
    schema: KEYSCHEMA,
    run: (a, req) => keys().buy(a, req, 5) },
  { name: 'buy_key_20', route: 'GET /api/keys/buy-20', usd: 20, noHf: true, mcp: false,
    tags: ['api-key', 'prepaid', 'bots', 'credit'],
    desc: KEYBUY('20'),
    schema: KEYSCHEMA,
    run: (a, req) => keys().buy(a, req, 20) },
  { name: 'buy_key_pass', route: 'GET /api/keys/buy-pass', usd: KEYLIB.PASS.usd, noHf: true, mcp: false,
    tags: ['api-key', 'prepaid', 'bots', 'pass', 'liquidations'],
    desc: KEYPASS(),
    schema: KEYSCHEMA,
    run: (a, req) => keys().buy(a, req, KEYLIB.PASS.usd, { pass: KEYLIB.PASS }) },
  // R15: the 24-hour day pass, $1.00: the most a stock x402 client pays under its default spend cap
  { name: 'buy_key_day_pass', route: 'GET /api/keys/buy-day-pass', usd: KEYLIB.DAY_PASS.usd, noHf: true, mcp: false,
    tags: ['api-key', 'prepaid', 'bots', 'pass', 'liquidations'],
    desc: KEYDAYPASS(),
    schema: KEYSCHEMA,
    run: (a, req) => keys().buy(a, req, KEYLIB.DAY_PASS.usd, { pass: KEYLIB.DAY_PASS }) },
  // pensio: the signals passes (tools/briefs/config.js holds the price, the pace and the one list of routes they cover)
  { name: 'buy_key_signals_pass', route: 'GET /api/keys/buy-signals-pass', usd: KEYLIB.SIGNALS_PASS.usd, noHf: true, mcp: false,
    tags: ['api-key', 'prepaid', 'bots', 'pass', 'brief'],
    desc: KEYSIGNALSPASS(KEYLIB.SIGNALS_PASS),
    schema: KEYSCHEMA,
    run: (a, req) => keys().buy(a, req, KEYLIB.SIGNALS_PASS.usd, { pass: KEYLIB.SIGNALS_PASS }) },
  { name: 'buy_key_signals_day_pass', route: 'GET /api/keys/buy-signals-day-pass', usd: KEYLIB.SIGNALS_DAY_PASS.usd, noHf: true, mcp: false,
    tags: ['api-key', 'prepaid', 'bots', 'pass', 'brief'],
    desc: KEYSIGNALSPASS(KEYLIB.SIGNALS_DAY_PASS),
    schema: KEYSCHEMA,
    run: (a, req) => keys().buy(a, req, KEYLIB.SIGNALS_DAY_PASS.usd, { pass: KEYLIB.SIGNALS_DAY_PASS }) },
  { name: 'topup_key_5', route: 'GET /api/keys/topup-5', usd: 5, noHf: true, mcp: false,
    tags: ['api-key', 'prepaid', 'bots', 'credit'],
    desc: KEYTOP('5'),
    schema: {},
    run: (a, req) => keys().topup(a, req, 5) },
  { name: 'topup_key_20', route: 'GET /api/keys/topup-20', usd: 20, noHf: true, mcp: false,
    tags: ['api-key', 'prepaid', 'bots', 'credit'],
    desc: KEYTOP('20'),
    schema: {},
    run: (a, req) => keys().topup(a, req, 20) },

  // ---- R11 Phase A (14 Oct 2026): general-purpose routes; sources and their terms in docs/SOURCES.md ----
  { name: 'get_sanctions_check', route: 'GET /api/sanctions-check/:address', usd: 0.008,
    tags: ['sanctions', 'ofac', 'compliance', 'aml', 'wallet-screening', 'crypto'],
    desc: 'Use when an agent needs to screen a crypto wallet before paying or being paid. Returns an exact match of a Bitcoin, Ethereum, Tron, Solana or other address against the OFAC SDN list, with entry, program and list date. No match is not a clearance.',
    schema: { address: PS.address('a crypto address of any family: bitcoin, ethereum, tron, solana, xrp, litecoin and so on') },
    run: (a) => SANC.sanctionsCheck(a) },
  { name: 'get_email_verify', route: 'GET /api/email-verify', usd: 0.005,
    tags: ['email', 'validation', 'verification', 'disposable', 'lead-quality'],
    desc: 'Use when an agent needs to know whether an email address can plausibly receive mail. Returns syntax, MX, disposable-domain, role-account and free-provider checks with a deliverable_likely, risky or undeliverable verdict and its reasons. No SMTP probe.',
    schema: { email: z.string().describe('the address to check, up to 254 characters') },
    run: (a) => EV.emailVerify(a) },
  { name: 'get_domain', route: 'GET /api/domain/:domain', usd: 0.005,
    tags: ['domain', 'dns', 'tls', 'certificate', 'infrastructure'],
    desc: 'Use when an agent needs the basic facts about a domain. Returns its DNS A, AAAA, MX, NS and TXT records and the live TLS certificate: issuer, alternative names, validity dates and days to expiry. Public hosts only; no registrar data.',
    schema: { domain: PS.domain('a hostname such as example.com (no URL, no IP address)') },
    run: (a) => DOM.getDomain(a) },
  { name: 'get_papers', route: 'GET /api/papers', usd: 0.015,
    tags: ['research', 'papers', 'academic', 'openalex', 'citations', 'literature'],
    desc: 'Use when an agent needs scholarly papers on a topic. Returns OpenAlex works (CC0 data) for a search: title, year, DOI, authors, venue, citation count and open-access link, up to 25, optionally from a given year. Cached 24 hours.',
    schema: { q: z.string().describe('the search text, up to 200 characters'), year_from: PS.q('GET /api/papers', 'year_from', 'earliest publication year, e.g. 2022'), limit: PS.q('GET /api/papers', 'limit', 'papers returned, 1-25, default 10') },
    run: (a) => PAP.searchPapers(a) },
  { name: 'get_paper', route: 'GET /api/paper/:doi', usd: 0.005,
    tags: ['research', 'papers', 'academic', 'doi', 'openalex', 'citations'],
    desc: 'Use when an agent needs the paper behind a DOI. Returns title, year, authors, venue, citation count, open-access URL and the abstract where OpenAlex holds it (CC0 data). The DOI goes in the path as written, slash included: /api/paper/10.1038/nature14539.',
    schema: { doi: PS.doi('a DOI such as 10.1038/nature14539, sent in the path as written (its slash as %2F also works)') },
    run: (a) => PAP.getPaper(a) },
  { name: 'get_wiki', route: 'GET /api/wiki', usd: 0.005,
    tags: ['wikipedia', 'encyclopedia', 'knowledge', 'reference', 'summary'],
    desc: 'Use when an agent needs a reliable plain-text summary of a topic. Returns the Wikipedia summary and lead section for a page title in any language, with the CC BY-SA 4.0 licence, the article URL and the authors link. Cached 24 hours.',
    schema: { title: z.string().describe('the article title, e.g. Solana (blockchain platform)'), lang: z.string().optional().describe('Wikipedia language code, default en') },
    run: (a) => WK.getWiki(a) },
  { name: 'get_qr', route: 'GET /api/qr', usd: 0.005,
    tags: ['qr', 'qr-code', 'image', 'utility', 'payments'],
    desc: 'Use when an agent needs a QR code for a link, address or payment string. Returns an SVG or PNG (base64 and data URI) at error-correction level M, scaled for scanning. Input up to 2 KB; over that is a 400, never billed.',
    schema: { data: z.string().describe('the text to encode, up to 2,048 bytes'), format: z.enum(['svg', 'png']).optional().describe('svg (default) or png') },
    run: (a) => UT.qr(a) },
  { name: 'get_hash', route: 'GET /api/hash', usd: 0.005,
    tags: ['hash', 'sha256', 'keccak256', 'blake2b', 'utility', 'crypto'],
    desc: 'Use when an agent needs a hash it should not compute itself. Returns SHA-256, Keccak-256 (the Ethereum hash) or BLAKE2b-512 of UTF-8 text or hex bytes, as hex and 0x-hex. Input up to 2 KB; over that is a 400, never billed.',
    schema: { alg: z.enum(['sha256', 'keccak256', 'blake2b']).describe('the hash'), data: z.string().describe('the input, up to 2,048 bytes'), as: z.enum(['utf8', 'hex']).optional().describe('how to read data: utf8 (default) or hex bytes') },
    run: (a) => UT.hash(a) },
  { name: 'get_time', route: 'GET /api/time', usd: 0.005,
    tags: ['time', 'timezone', 'utc', 'utility', 'scheduling'],
    desc: 'Use when an agent needs an exact time conversion with the right daylight-saving rules. Returns an ISO time or epoch in any IANA time zone: local time with offset, weekday, abbreviation, DST flag and epoch. Defaults to now in UTC.',
    schema: { tz: z.string().optional().describe('IANA zone such as Europe/Chisinau or America/New_York, default UTC'), at: z.string().optional().describe('ISO 8601 with Z or an offset, or epoch seconds or milliseconds; default now') },
    run: (a) => UT.time(a) },
  { name: 'get_convert', route: 'GET /api/convert', usd: 0.005,
    tags: ['units', 'conversion', 'utility', 'measurement'],
    desc: 'Use when an agent needs an exact unit conversion. Returns the value converted between units of length, mass, volume, time, data, speed, area, pressure, energy or temperature, to 12 significant digits. Mixing categories is a 400, never billed.',
    schema: { value: z.string().describe('a plain number'), from: z.string().describe('unit, e.g. mi, kg, GiB, C'), to: z.string().describe('unit, e.g. km, lb, MB, F') },
    run: (a) => UT.convert(a) },
  { name: 'get_sol_token_check', route: 'GET /api/sol-token-check/:mint', usd: 0.025,
    tags: ['solana', 'token', 'rug-check', 'pre-trade', 'liquidity', 'holders'],
    desc: 'Use when an agent needs a pre-trade check on a Solana token. Returns mint and freeze authority, Token-2022 traps, top holders, deepest pool and USD depth, the price impact of $100 and $1,000 buys, pump.fun progress, and a verdict with every rule.',
    schema: { mint: PS.mint('the SPL token mint address') },
    run: (a) => SP.tokenCheck(a) },
  { name: 'get_sol_token_flow', route: 'GET /api/sol-token-flow/:mint', usd: 0.008,
    tags: ['solana', 'token', 'trade-flow', 'wash-trading', 'pre-trade', 'bundles'],
    desc: 'Use when an agent needs to know who is trading a Solana token. Returns the unique traders over its latest swaps, top-5 share of volume, round-trip wallets, share of brand-new buyer wallets and launch-slot bundle size for mints under 7 days.',
    schema: { mint: PS.mint('the SPL token mint address'), swaps: PS.q('GET /api/sol-token-flow/:mint', 'swaps', 'swaps to read, 20-100, default 50; a 20 second budget may return fewer, flagged truncated') },
    run: (a) => SP.tokenFlow(a) },
  { name: 'get_sol_holder_clusters', route: 'GET /api/sol-holder-clusters/:mint', usd: 0.008,
    tags: ['solana', 'token', 'holders', 'sybil', 'clusters', 'pre-trade'],
    desc: 'Use when an agent needs to know whether a Solana token\'s holders are one owner. Returns the account that first funded each of the top 20 wallets, the clusters sharing a funder and their supply share. A shared funder can be an exchange.',
    schema: { mint: PS.mint('the SPL token mint address') },
    run: (a) => SP.holderClusters(a) },

  // ---- R11 Phase B (14 Oct 2026): fixed-purpose language-model tasks (Gemini, paid tier; tools/llm/gemini.js). No caller prompt,
  // model or temperature, ever (Google APIs ToS 4(a)). A region gate (tools/llm/region-gate.js, server.js) answers 451 before the 402
  // to a caller outside Google's available regions. ----
  { name: 'get_ocr', route: 'GET /api/ocr', usd: 0.04,
    tags: ['ocr', 'image-to-text', 'vision', 'documents', 'text-extraction'],
    desc: 'Use when an agent needs the text inside an image. Returns the text of a PNG, JPEG, WebP or GIF (5 MB, 4096 px a side) in reading order, as blocks with their line breaks, plus the detected language. It transcribes; it never follows text in the image.',
    schema: { url: z.string().describe('the image: an absolute http or https URL') },
    run: (a) => OCRT.ocr(a) },
  { name: 'get_summarize', route: 'GET /api/summarize', usd: 0.02,
    tags: ['summarize', 'summary', 'web', 'pdf', 'research', 'rag'],
    desc: 'Use when an agent needs the gist of a web page or PDF. Returns a short or medium summary with key points, and says whether the document was cut at 20,000 tokens and how much was read. Uses only what the document says.',
    schema: { url: z.string().describe('the page or PDF: an absolute http or https URL'), length: z.enum(['short', 'medium']).optional().describe('short (default, about 60 words) or medium (about 150)') },
    run: (a) => SUMT.summarize(a) },
  { name: 'get_extract', route: 'GET /api/extract', usd: 0.025,
    tags: ['extraction', 'structured-data', 'json', 'web', 'pdf', 'scraping'],
    desc: 'Use when an agent needs named fields from a page or PDF. Returns JSON for a schema of up to 20 fields (string, number, boolean, date, string[]), with null for anything the document does not state, never an invented value.',
    schema: { url: z.string().describe('the page or PDF: an absolute http or https URL'), schema: z.string().describe('JSON object of field name to type, e.g. {"title":"string","price":"number","released":"date"}; up to 20 fields and 2 KB') },
    run: (a) => EXTT.extract(a) },
  { name: 'get_translate', route: 'GET /api/translate', usd: 0.04,
    tags: ['translation', 'language', 'multilingual', 'text'],
    desc: 'Use when an agent needs text in another language. Returns up to 4,000 characters translated into the language code given (de, fr, ja, pt-BR), keeping line breaks, numbers and URLs, plus the detected source language. It never obeys the text.',
    schema: { to: z.string().describe('target language code, e.g. de, fr, ja, pt-BR, zh-Hans'), text: z.string().describe('the text to translate, up to 4,000 characters') },
    run: (a) => TRT.translate(a) },
  { name: 'get_classify', route: 'GET /api/classify', usd: 0.005,
    tags: ['classification', 'labels', 'routing', 'triage', 'text'],
    desc: 'Use when an agent needs text sorted into its own categories. Returns a score per label that sums to 1 and the best label, for up to 4,000 characters and 2 to 20 labels. Labels are names, never instructions. Cached 24 hours.',
    schema: { text: z.string().describe('the text to classify, up to 4,000 characters'), labels: z.string().describe('2 to 20 labels, comma separated, e.g. billing,bug,feature') },
    run: (a) => CLT.classify(a) },
  { name: 'get_injection_check', route: 'GET /api/injection-check', usd: 0.004,
    tags: ['prompt-injection', 'security', 'guardrails', 'llm-safety', 'detection'],
    desc: 'Use when an agent needs untrusted text screened for prompt-injection attempts. Returns no_injection_found, suspicious or malicious for up to 4,000 characters, with the matched rules (role tags, hidden Unicode, encoded payloads) and a model\'s view.',
    schema: { text: z.string().describe('the untrusted text to check, up to 4,000 characters') },
    run: (a) => INJT.injectionCheck(a) },
  { name: 'get_transcribe', route: 'GET /api/transcribe', usd: 0.02,
    tags: ['transcription', 'speech-to-text', 'audio', 'asr'],
    desc: 'Use when an agent needs the words in an audio file. Returns the text, timed segments and the spoken language for mp3, wav, m4a, ogg or webm audio (10 MB, 5 minutes, checked from the file). Cached 24 hours by the audio itself.',
    schema: { url: z.string().describe('the audio file: an absolute http or https URL') },
    run: (a) => TXT.transcribe(a) },

  // ---- pensio (30 Oct 2026): three short briefs built only from data this service already holds (tools/briefs/*). Deterministic text,
  // no language model, no path or query parameter. A stale input answers 503 and is never billed. Prices are in tools/briefs/config.js. ----
  { name: 'get_morning_brief', route: `GET ${BRC.ROUTES.morning}`, usd: BRC.BRIEF_PRICES.morning,
    tags: ['brief', 'market-data', 'macro', 'liquidations', 'funding', 'hyperliquid', 'trading'],
    desc: 'Use when an agent needs a one-answer summary of the last 8 hours in BTC, ETH, SOL and HYPE. Returns the items ranked by how abnormal each is: price move against the coin\'s own usual 8-hour move, funding, open interest, liquidations (total, long/short split, biggest print), Fear and Greed, today\'s macro releases with UTC times, and the nearest liquidation cluster as the level to watch. A stale source is left out and named; with no sampler it answers 503, never billed.',
    schema: {},
    run: (a) => BR.getMorningBrief(a) },
  { name: 'get_move_alert', route: `GET ${BRC.ROUTES.move}`, usd: BRC.BRIEF_PRICES.move,
    tags: ['brief', 'anomaly', 'screener', 'hyperliquid', 'open-interest', 'macro', 'trading'],
    desc: 'Use when an agent needs to know which Hyperliquid perps moved unusually. Returns each coin whose 5-minute, 1-hour or 4-hour price move, or 1-hour open-interest change, is past its own measured tail (tiers from the coin\'s own history, sample size printed), labelled event-driven when a scheduled FOMC, CPI, NFP or PCE release explains it. An empty list is a valid answer. Stale inputs answer 503, never billed.',
    schema: {},
    run: (a) => BR.getMoveAlert(a) },
  { name: 'get_anomaly_flag', route: `GET ${BRC.ROUTES.anomaly}`, usd: BRC.BRIEF_PRICES.anomaly,
    tags: ['brief', 'anomaly', 'screener', 'funding', 'liquidations', 'open-interest', 'hyperliquid', 'trading'],
    desc: 'Use when an agent needs one check for what is abnormal across Hyperliquid perps right now. Returns funding, liquidation and open-interest anomalies in one ranked list, using the thresholds of /api/market-state, or nothing abnormal with what was checked. If a source is stale and nothing else was found it answers 503 rather than an all-clear, and is never billed.',
    schema: {},
    run: (a) => BR.getAnomalyFlag(a) },
];

// pensio: the news brief exists only while PENSIO_NEWS=on (tools/briefs/config.js newsOn). Off, the route is not in PRICES, the documents, the Bazaar or MCP.
if (BRC.newsOn()) {
  EXP.push({ name: 'get_news_brief', route: `GET ${BRC.ROUTES.news}`, usd: BRC.BRIEF_PRICES.news,
    tags: ['brief', 'news', 'macro', 'regulation', 'trading'],
    desc: 'Use when an agent needs the official regulatory and central-bank news of the last 24 hours, sorted. Returns SEC, CFTC and Federal Reserve Board press releases, each with its agency, link and time, a label (enforcement, rule change, rates and policy, supervision, market structure, administrative, other) and an impact score from 1 to 5, ranked by impact. Release text is treated as data. If no source has been read for 3 hours it answers 503, never billed.',
    schema: {},
    run: (a) => BR.getNewsBrief(a) });
}

// R23 (31 Oct 2026): the tools batch, ONE list (tools/r23/index.js). x402-lint, x402-test, cascade-backtest and claim-check; the held crash-risk routes join only while R23_CRASH_ROUTES=on.
EXP.push(...require('./tools/r23').entries);

// ---- derived exports ----
const PRICES_ADD = {};
const TAGS_ADD = {};
for (const t of EXP) {
  if (t.free) { TAGS_ADD[t.name] = t.tags; continue; }   // R23: a free entry (the held crash-risk record) is registered by register() below but never priced; no entry is free while the crash routes are off
  PRICES_ADD[t.route] = { usd: t.usd, tool: t.name, desc: t.desc, ...(t.noHf ? { noHf: true } : {}), ...(t.challengeNote ? { challengeNote: t.challengeNote() } : {}), ...(t.docNote ? { docNote: t.docNote() } : {}) };
  TAGS_ADD[t.name] = t.tags;
}

const MCP_DEFS_ADD = EXP.filter((t) => t.mcp !== false).map((t) => ({
  name: t.name, usd: t.usd, desc: t.desc, schema: t.schema, mcpGate: !!t.mcpGate, ...(t.docNote ? { docNote: t.docNote() } : {}),
  run: (a, ctx) => t.run(a || {}, ctx),    // ctx is passed only to a tool flagged mcpGate (mcp.js); every other tool gets undefined, as before
}));

// REST registration: merge query + path params into one args object
function register(app, tool) {
  for (const t of EXP) {
    const path = t.route.replace('GET ', '');
    // req rides along as the second argument: the key handlers reach the response (req.res) and the presented key (req.afKey) through it
    app.get(path, tool(t.name, t.usd, (req) => t.run({ ...(req.query || {}), ...(req.params || {}) }, req)));
  }
}

module.exports = { EXP, PRICES_ADD, TAGS_ADD, MCP_DEFS_ADD, register, setKeys: (k) => { KEYS.current = k; } };

<!-- mcp-name: io.github.seekdaseek/agentfeed -->
# AgentFeed

**Crypto liquidations, cascade detection, positioning and market data for AI agents. Pay per call in USDC. No API keys, no accounts, no subscriptions.**

AgentFeed sells live trading data through the [x402 payment protocol](https://solana.com/x402) on Solana and Base. An agent hits an endpoint, gets a `402 Payment Required` with the price, pays a fraction of a cent in USDC from its own wallet, and receives the data — in about two seconds, gas sponsored by the facilitator.

Two rails, same data:

| Rail | Endpoint | For |
|------|----------|-----|
| **MCP** (Streamable HTTP) | `https://x402.ochinimus.app/mcp` | Claude, Cursor, MCP-native frameworks |
| **HTTP** (x402) | `https://x402.ochinimus.app/api/*` | Anything that speaks HTTP |

---

## What makes this different: the liquidation tape

We run our own liquidation collector across **Bybit, OKX and Binance** — every USDT-margined
perpetual on all three, roughly **600 symbols**, recorded continuously since 2026-07-08.

**This data cannot be bought.** Not from us, not from anyone:

- **Binance deleted their liquidation archive.** `liquidationSnapshot` no longer exists on
  `data.binance.vision` — the directory is an empty shell. Verified 2026-07-12.
- **Bybit has never published historical liquidation data.**
- **OKX offers a 7-day rolling REST window and nothing more.**

There is no public historical liquidation dataset for any major venue, at any price. The only
way to hold this data is to have been recording it.

### And here is exactly where our data is weak

Being straight about this matters more than the marketing:

| Venue | Feed | Complete? |
|---|---|---|
| **Bybit** | `allLiquidation` | ✅ **Yes.** Every liquidation, 500ms cadence. The only complete, unthrottled public liquidation stream among the major perp venues. |
| **Binance** | `!forceOrder@arr` | ❌ **No.** Snapshot only — max one order per symbol per 1000ms, per Binance's own docs. `allForceOrders` REST is unmaintained. |
| **OKX** | `liquidation-orders` | ❌ **No.** Max one update per second per contract. |
| **Hyperliquid** | — | ⛔ **Not included.** Hyperliquid exposes *no public liquidation stream*. `WsTrade` carries no liquidation marker; the data lives only in user-scoped streams. Capturing it requires running a node. |

**Binance and OKX rows are a structural undercount, and the undercount is worst during
cascades — exactly when the data matters most.** This is true of every liquidation dataset on
the market, including the well-known ones. Most don't say so.

**Bybit rows are the highest-integrity part of the dataset.** Weight accordingly.

### The `side` field, which most datasets get wrong

Three exchanges, three conventions. We normalize all of them:

- **Bybit** `S` is already the *position* side (`Buy` = a long was liquidated). Passed through.
- **Binance** `S` is the *order* side — a `SELL` order is what closes a long. **Flipped.**
- **OKX** exposes `posSide` explicitly. Mapped.

**In our output: `Buy` = a LONG was liquidated. `Sell` = a SHORT was liquidated.** Invert this
and every long/short ratio you compute is backwards for some venues.

Notional uses `filled_qty × avg_fill_price` — what actually executed — not `limit_price × requested_size`.

---

## Tools

| Tool | Price | Description |
| --- | --- | --- |
| get_sol_price | $0.001 | SOL spot price via Pyth |
| get_btc_price | $0.001 | BTC spot price via Pyth |
| get_funding_rate | $0.002 | SOL+BTC perp funding rates |
| get_market_snapshot | $0.003 | Full market snapshot in one call |
| get_wallet_holdings | $0.008 | Solana wallet holdings via Helius DAS |
| get_token_metadata | $0.005 | SPL token metadata via Helius DAS |
| get_recent_liquidations | $0.003 | Recent liquidations across ~600 USDT perps |
| get_cascade_alert | $0.01 | Live liquidation cascade detector for the 5 majors |
| get_cascade_scan | $0.05 | Full-universe cascade scan across ~600 USDT perps |
| get_liquidation_leaders | $0.02 | Top symbols by liquidation USD right now |
| get_liquidation_stats | $0.004 | 1h/24h liquidation totals, long/short split |
| get_positioning | $0.004 | SOL+BTC long/short ratio + open interest |
| get_trade_context | $0.01 | Full market state in one call |
| get_token_risk | $0.01 | SPL token rug-risk signals |
| get_sharp_move | $0.02 | Sharp-money detector for World Cup betting markets |
| get_liq_history | $0.05 | Historical liquidation tape, time-bucketed |
| get_liq_heatmap | $0.05 | Liquidation heatmap by price level from our tape |
| get_cascade_history | $0.03 | Past liquidation cascades from our tape |
| get_squeeze_score | $0.10 | FLAGSHIP: 0-100 short-squeeze / long-flush signal |
| get_venue_liq_share | $0.02 | Which venue is flushing whom |
| get_funding_cross | $0.01 | Funding for any USDT perp across Bybit + OKX + Hyperliquid |
| get_funding_extremes | $0.02 | Most crowded funding trades across ~600 perps |
| get_open_interest | $0.01 | Open interest for any USDT perp with 1h/24h change |
| get_oi_spike_scan | $0.02 | Abnormal open-interest jumps across ~600 perps |
| get_long_short | $0.01 | Long/short account ratio for any USDT perp |
| get_basis | $0.01 | Perp-vs-spot basis for any USDT pair |
| get_volatility | $0.01 | Realized volatility for any USDT perp |
| get_funding_history | $0.005 | Funding-rate history for any USDT perp |
| get_top_movers | $0.01 | 24h top gainers and losers across ~600 perps |
| get_orderbook_imbalance | $0.01 | Bid/ask resting-liquidity imbalance |
| get_orderbook_walls | $0.01 | Largest resting orders each side of the book |
| get_whale_trades | $0.02 | Large prints from the live trade tape |
| get_spread_arb | $0.02 | Best bid/ask across Bybit, OKX and Hyperliquid |
| get_token_holders | $0.02 | Top holders of any SPL token with concentration |
| get_wallet_activity | $0.02 | Recent transactions of any Solana wallet, parsed |
| get_priority_fees | $0.005 | Solana priority-fee estimate, all levels |
| get_jito_tips | $0.005 | Jito bundle tip floor percentiles |
| get_sol_network | $0.005 | Solana network health: TPS, slot, epoch |
| get_tvl | $0.005 | TVL for any DeFi protocol or top-15 chains |
| get_stablecoin_flows | $0.01 | Total stablecoin supply with 7d/30d deltas |
| get_dex_quote | $0.005 | Live Jupiter swap quote for any SPL pair |

## 44 tools & pricing

**41 paid tools + 3 free tasters.** Every call is metered individually in USDC over x402 — no bundles, no minimums. Calling all 41 paid tools once costs **$0.64** — the entire market read for 64 cents.

The flagship is [`get_squeeze_score`](#the-moat--our-own-liquidation-tape) — a 0-100 short-squeeze / long-flush composite built from funding, crowding, OI build and the liq-skew of our exclusive tape. One number, one dime, answers "is this trade crowded and about to hurt someone."

### The moat — our own liquidation tape

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_squeeze_score` | $0.1 | `/api/squeeze-score` | FLAGSHIP: short-squeeze / long-flush score 0-100 for any USDT perp |
| `get_liq_history` | $0.05 | `/api/liq-history` | HISTORICAL liquidation tape, time-bucketed: total/long/short USD, prints, biggest print per bucket |
| `get_liq_heatmap` | $0.05 | `/api/liq-heatmap` | Liquidation heatmap by PRICE LEVEL from our own tape: where leverage actually got flushed in the last N hours — USD, prints, long/short s… |
| `get_cascade_history` | $0.03 | `/api/cascade-history` | PAST liquidation cascades reconstructed from our tape: clustered same-side flush events with start/end, prints, USD total, peak print |
| `get_venue_liq_share` | $0.02 | `/api/venue-liq-share` | Which venue is flushing whom: per-exchange liquidation share (Bybit/OKX/Binance) with long/short split and biggest print, any symbol or w… |

### Live liquidations & cascades

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_recent_liquidations` | $0.003 | `/api/liquidations` | Recent liquidations across ~600 USDT perps (Bybit complete tape + OKX + Binance) |
| `get_cascade_alert` | $0.01 | `/api/cascade` | Liquidation cascade detector for the 5 majors (SOL/BTC/ETH/XRP/DOGE) across Bybit+OKX+Binance |
| `get_cascade_scan` | $0.05 | `/api/cascade-scan` | FULL-UNIVERSE cascade scan: ~600 USDT perps across Bybit+OKX+Binance |
| `get_liquidation_leaders` | $0.02 | `/api/liquidation-leaders` | What is blowing up right now: top symbols by liquidation USD across ~600 USDT perps, with long/short split, biggest print and venue count |
| `get_liquidation_stats` | $0.004 | `/api/liquidation-stats` | 1h/24h liquidation totals for the 5 majors (SOL/BTC/ETH/XRP/DOGE), long/short split, biggest print, per-exchange breakdown |

### Derivatives

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_funding_cross` | $0.01 | `/api/funding-cross` | Funding for ANY USDT perp across Bybit + OKX + Hyperliquid in one call, with cross-venue spread and crowding read |
| `get_funding_extremes` | $0.02 | `/api/funding-extremes` | Most crowded trades across ~600 USDT perps: top most-positive and most-negative funding with annualized %, 24h price move and OI |
| `get_open_interest` | $0.01 | `/api/open-interest` | Open interest for ANY USDT perp: Bybit OI in base + USD with 1h/24h change, plus OKX OI |
| `get_oi_spike_scan` | $0.02 | `/api/oi-spike-scan` | Abnormal open-interest jumps across ~600 USDT perps vs a 30min+ baseline — where new leverage is piling in, with funding and price context |
| `get_long_short` | $0.01 | `/api/long-short` | Long/short account ratio for ANY USDT perp with 1h and 24h trend (retail crowding gauge) |
| `get_basis` | $0.01 | `/api/basis` | Perp-vs-spot basis for any USDT pair: premium/discount %, contango/backwardation read, funding context |
| `get_volatility` | $0.01 | `/api/volatility` | Realized volatility for any USDT perp: 7d and 30d annualized from daily closes, plus today's range |
| `get_funding_history` | $0.005 | `/api/funding-history` | Funding-rate history for any USDT perp (up to 200 intervals): average, annualized, share of positive intervals — what the carry has actua… |
| `get_top_movers` | $0.01 | `/api/top-movers` | 24h top gainers and losers across ~600 USDT perps with a liquidity floor, funding attached |

### Microstructure

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_orderbook_imbalance` | $0.01 | `/api/orderbook-imbalance` | Bid/ask resting-liquidity imbalance within ±N bps of mid for any USDT perp: USD each side, ratio, skew read |
| `get_orderbook_walls` | $0.01 | `/api/orderbook-walls` | Largest resting orders each side of the book for any USDT perp, with USD size and distance from mid |
| `get_whale_trades` | $0.02 | `/api/whale-trades` | Large prints from the live trade tape for any USDT perp: trades over a USD threshold, buy/sell totals, net flow, dominant side |
| `get_spread_arb` | $0.02 | `/api/spread-arb` | Best bid/ask for a USDT perp across Bybit, OKX and Hyperliquid, with the best cross-venue edge in bps (pre-fee) |

### Market & positioning

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_sol_price` | $0.001 | `/api/sol-price` | SOL spot price via Pyth |
| `get_btc_price` | $0.001 | `/api/btc-price` | BTC spot price via Pyth |
| `get_funding_rate` | $0.002 | `/api/funding-rate` | SOL+BTC perp funding rates |
| `get_market_snapshot` | $0.003 | `/api/market-snapshot` | Full market snapshot in one call |
| `get_positioning` | $0.004 | `/api/positioning` | SOL+BTC long/short account ratio + open interest with 1h/24h OI change |
| `get_trade_context` | $0.01 | `/api/trade-context` | Full market state in one call: prices, funding, fear/greed, positioning, liquidations |

### Solana on-chain

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_wallet_holdings` | $0.008 | `/api/wallet-holdings/:wallet` | Solana wallet holdings via Helius DAS |
| `get_token_metadata` | $0.005 | `/api/token-metadata/:mint` | SPL token metadata via Helius DAS |
| `get_token_risk` | $0.01 | `/api/token-risk/:mint` | Token rug-risk signals: mint/freeze authority status, top-holder concentration, risk flags |
| `get_token_holders` | $0.02 | `/api/token-holders/:mint` | Top holders of any SPL token with per-account share and top1/top5/top10 concentration |
| `get_wallet_activity` | $0.02 | `/api/wallet-activity/:wallet` | Recent transactions of any Solana wallet, parsed human-readable: type, protocol, description, fee, failures (Helius enhanced) |
| `get_priority_fees` | $0.005 | `/api/priority-fees` | Solana priority-fee estimate right now, all levels (min to unsafeMax) in micro-lamports/CU, with a recommended tip |
| `get_jito_tips` | $0.005 | `/api/jito-tips` | Jito bundle tip floor percentiles (p25-p99, SOL) — what landed bundles are actually paying, with a landing recommendation |
| `get_sol_network` | $0.005 | `/api/sol-network` | Solana network health: recent average TPS, current slot, epoch and epoch progress |

### DeFi / macro

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_tvl` | $0.005 | `/api/tvl` | TVL for any DeFi protocol (with 1d/7d change) or top-15 chains ranking |
| `get_stablecoin_flows` | $0.01 | `/api/stablecoin-flows` | Total stablecoin supply with 7d/30d deltas and top stables — the macro risk-on/risk-off dial for crypto |
| `get_dex_quote` | $0.005 | `/api/dex-quote` | Live Jupiter swap quote for any SPL pair: output amount, price impact, route |

### Sports sharp money

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_sharp_move` | $0.02 | `/api/sharp-move` | Sharp-money detector for World Cup betting markets: abnormal pre-match moves in de-margined consensus win probability (TxODDS StablePrice… |

### Free tasters

| Tool | Route |
|---|---|
| `get_fear_greed` | `/api/fear-greed` |
| `get_last_liquidation` | `/api/last-liquidation` (15-min delayed) |
| `pricing` | MCP tool — lists everything with live prices |

## Use it from an elizaOS agent

```bash
npm i @seekdaseek/plugin-agentfeed   # v0.3.0 — all 44 tools as actions
```

Set `AGENTFEED_PRIVATE_KEY` to a funded Solana wallet and the agent pays per call automatically. Default spend cap $0.50/call (`AGENTFEED_MAX_SPEND_PER_CALL` to change).

## Try it free right now

```bash
curl https://x402.ochinimus.app/api/fear-greed
curl https://x402.ochinimus.app/api/last-liquidation
curl https://x402.ochinimus.app/                    # full pricing index
curl https://x402.ochinimus.app/api/cascade-scan    # returns 402 + payment terms
```

x402 clients pay and retry automatically.

## MCP quickstart

Point any MCP client at `https://x402.ochinimus.app/mcp` (Streamable HTTP, POST). Paid tools
return payment terms; an x402-capable client settles and retries.

```js
import { createx402MCPClient } from "@x402/mcp";
```

Also available as an [elizaOS plugin](https://www.npmjs.com/package/@seekdaseek/plugin-agentfeed).

---

## Free dataset

A multi-venue liquidation dataset — normalized, growing daily, free — ships with a full
quality statement covering coverage dates, known gaps, exchange throttles, and field
definitions: **[ochinimuse.gumroad.com/l/liqdata](https://ochinimuse.gumroad.com/l/liqdata)**

Read `DATASET_QUALITY.md` before you use it. It tells you exactly where the data is wrong.

---

## Links

[MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=agentfeed) ·
[Smithery](https://smithery.ai/server/ochinimus/agentfeed) ·
[x402 manifest](https://x402.ochinimus.app/.well-known/x402.json) ·
[ochinimus](https://ochinimus.app)

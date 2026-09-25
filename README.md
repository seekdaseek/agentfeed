<!-- mcp-name: io.github.seekdaseek/agentfeed -->
# AgentFeed

[![smithery badge](https://smithery.ai/badge/ochinimus/agentfeed)](https://smithery.ai/servers/ochinimus/agentfeed)

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
perpetual on all three, recorded continuously since 2026-07-08.

The size of that tape is not a claim, it is a query. Measured **2026-09-23 10:31 UTC**:

| | |
|---|---|
| Rows | **4,597,868** |
| Distinct perp markets, whole tape | **906** |
| Distinct perp markets, last 7 days | **874** — binance 727 · bybit 711 · okx 468 |
| Range (UTC) | 2026-07-08 16:42:32 → 2026-09-23 10:31:44 |

It grows while you read this: the row count above and the one you get from the
same query five minutes later will not match.

The 7-day figure is published live by the service itself at
[`/`](https://x402.ochinimus.app/) under `coverage.perp_markets_7d`, recomputed from the tape
rather than restated, so this README can be checked against it rather than believed.

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

## Price index

Every paid route, cheapest question last. Generated from
[`/.well-known/x402.json`](https://x402.ochinimus.app/.well-known/x402.json),
read 2026-09-23 — names, prices and routes are the manifest's, not a copy kept
in sync by hand. What each one returns is under
[55 tools](#55-tools-48-paid-http-routes--7-free--pricing), word for word as
the service publishes it.

| Tool | Price | Route |
|---|---|---|
| `get_squeeze_score` | $0.1 | `/api/squeeze-score` |
| `get_cascade_scan` | $0.05 | `/api/cascade-scan` |
| `get_liq_heatmap` | $0.05 | `/api/liq-heatmap` |
| `get_liq_history` | $0.05 | `/api/liq-history` |
| `get_peg_universe` | $0.05 | `/api/peg-universe` |
| `get_cascade_history` | $0.03 | `/api/cascade-history` |
| `get_peg_sessions` | $0.03 | `/api/peg-sessions` |
| `get_cascade_forecast` | $0.02 | `/api/cascade-forecast` |
| `get_exit_quote` | $0.02 | `/api/exit-quote` |
| `get_funding_extremes` | $0.02 | `/api/funding-extremes` |
| `get_liquidation_leaders` | $0.02 | `/api/liquidation-leaders` |
| `get_oi_spike_scan` | $0.02 | `/api/oi-spike-scan` |
| `get_peg_deviation` | $0.02 | `/api/peg-deviation` |
| `get_spread_arb` | $0.02 | `/api/spread-arb` |
| `get_token_holders` | $0.02 | `/api/token-holders/:mint` |
| `get_venue_liq_share` | $0.02 | `/api/venue-liq-share` |
| `get_wallet_activity` | $0.02 | `/api/wallet-activity/:wallet` |
| `get_whale_trades` | $0.02 | `/api/whale-trades` |
| `get_basis` | $0.01 | `/api/basis` |
| `get_cascade_alert` | $0.01 | `/api/cascade` |
| `get_funding_cross` | $0.01 | `/api/funding-cross` |
| `get_long_short` | $0.01 | `/api/long-short` |
| `get_open_interest` | $0.01 | `/api/open-interest` |
| `get_orderbook_imbalance` | $0.01 | `/api/orderbook-imbalance` |
| `get_orderbook_walls` | $0.01 | `/api/orderbook-walls` |
| `get_stablecoin_flows` | $0.01 | `/api/stablecoin-flows` |
| `get_token_risk` | $0.01 | `/api/token-risk/:mint` |
| `get_top_movers` | $0.01 | `/api/top-movers` |
| `get_trade_context` | $0.01 | `/api/trade-context` |
| `get_volatility` | $0.01 | `/api/volatility` |
| `get_wallet_holdings` | $0.008 | `/api/wallet-holdings/:wallet` |
| `get_dex_quote` | $0.005 | `/api/dex-quote` |
| `get_funding_history` | $0.005 | `/api/funding-history` |
| `get_jito_tips` | $0.005 | `/api/jito-tips` |
| `get_priority_fees` | $0.005 | `/api/priority-fees` |
| `get_sol_network` | $0.005 | `/api/sol-network` |
| `get_token_metadata` | $0.005 | `/api/token-metadata/:mint` |
| `get_tvl` | $0.005 | `/api/tvl` |
| `get_liquidation_stats` | $0.004 | `/api/liquidation-stats` |
| `get_positioning` | $0.004 | `/api/positioning` |
| `get_market_snapshot` | $0.003 | `/api/market-snapshot` |
| `get_recent_liquidations` | $0.003 | `/api/liquidations` |
| `get_base_balance` | $0.002 | `/api/base-balance` |
| `get_funding_rate` | $0.002 | `/api/funding-rate` |
| `get_base_gas` | $0.001 | `/api/base-gas` |
| `get_btc_price` | $0.001 | `/api/btc-price` |
| `get_eth_price` | $0.001 | `/api/eth-price` |
| `get_sol_price` | $0.001 | `/api/sol-price` |

## Two payment protocols on one 402

Every paid route answers `402` with an x402 v2 challenge in the `PAYMENT-REQUIRED` header.
`/api/sol-price` and `/api/btc-price` additionally carry an MPP `solana`/`charge` challenge in
`WWW-Authenticate` on the *same* response, so a client settles with whichever protocol it
speaks. The two live in disjoint header namespaces, so an x402-only client never sees the MPP
one and is unaffected.

```
$ curl -si https://x402.ochinimus.app/api/btc-price      # 2026-09-23 09:18:09 UTC

HTTP/2 402
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwi…
www-authenticate: Payment id="T0-lA4BfXXpf3GvzGklT8YobRJwSlEu8AXu9ZLz5VOg",
                  realm="x402.ochinimus.app", method="solana", intent="charge",
                  request="eyJhbW91bnQiOiIxMDAwIiwiY3VycmVuY3ki…",
                  expires="2026-09-23T09:23:09.919Z", opaque="eyJfbXBweF9zY29wZSI6…"
```

Base64-decoded, that MPP `request` is the whole quote:

```json
{
  "amount": "1000",
  "currency": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "recipient": "4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7",
  "methodDetails": {
    "decimals": 6,
    "network": "mainnet",
    "recentBlockhash": "6e6NEAxddHca5ipHioSwZRhcGcSL4rW4q18AYszfnxyv",
    "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  }
}
```

Note what is **not** there: no `feePayer`. The client pays its own transaction fee and the
server holds no funded signing key, which is the difference between the MPP challenge and the
Solana x402 one sitting beside it in the same response.

**Replay is refused, not merely discouraged.** A settled signature is claimed atomically in
SQLite before the resource is served, so two processes racing the same credential produce
exactly one 200 and one refusal — covered by tests that fork real worker processes rather
than stubbing the race.

**The layer is fail-soft by design.** If it cannot initialise it logs `[mpp] DISABLED: <cause>`
and the service keeps serving x402 on every route rather than taking the paid surface down
with it. Which routes are gated is published live at `/` and in `/.well-known/x402.json` under
`mpp.routes`, so the advertised set is always whatever is actually mounted.

AgentFeed is one of several merchants accepting MPP on Solana mainnet — the Foundation's own
Google proxy and `smartmoney-market` in `solana-foundation/pay-skills` do too.

### Upstream work this produced

| | |
|---|---|
| [`solana-foundation/pay-kit` #328](https://github.com/solana-foundation/pay-kit/pull/328) | `fix(mpp): send preflightCommitment with sendTransaction so confirmed-only blockhashes are accepted` — a challenge blockhash minted at `confirmed` is rejected by a preflight bank that defaults to `finalized`, so a client that pays *fast* always fails. **Open, approved, 44/44 checks green, mergeable/clean** (read 2026-09-23) |
| [`solana-foundation/surfpool` #813](https://github.com/solana-foundation/surfpool/pull/813) | `fix(core): make blockhash handling honor commitment and preflightCommitment` — **merged 2026-09-21** by `MicaiahReid`, opened by `EfeDurmaz16`, who had reviewed #328. Its description explains why the bug above was invisible in CI: "This hid a deterministic mainnet failure from pay-kit's Surfpool CI: solana-foundation/pay-kit#328." A sandbox that stamped an always-valid blockhash could not reproduce a finality race that mainnet reproduces every time |
| [`solana-foundation/pay-skills` #260](https://github.com/solana-foundation/pay-skills/pull/260) | `providers: add ochinimus/agentfeed` |
| [`solana-foundation/pay` #469](https://github.com/solana-foundation/pay/issues/469) | `pay` hangs forever on paid routes in non-GUI contexts: the Touch ID gate polls for a prompt that cannot render |

The pay-kit fix ships here as `mpp/patches/@solana+mpp+0.7.0.patch`, applied by
`patch-package` on install and asserted by `npm run verify-patch` — the patch is a production
dependency, not a dev one, because a `--omit=dev` install would otherwise complete silently
*unpatched*.

## 55 tools (48 paid HTTP routes + 7 free) & pricing

**48 paid + 7 free**, 55 total on the MCP rail. Every call is metered individually in USDC over
x402 — no bundles, no minimums. Calling all 48 paid tools once costs **$0.765** — the entire
market read for 77 cents. Counts and prices are summed from
[the live manifest](https://x402.ochinimus.app/.well-known/x402.json), read 2026-09-23.

The flagship is [`get_squeeze_score`](#the-moat--our-own-liquidation-tape) — a 0-100 short-squeeze / long-flush composite built from funding, crowding, OI build and the liq-skew of our exclusive tape. One number, one dime, answers "is this trade crowded and about to hurt someone."

### The moat — our own liquidation tape

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_squeeze_score` | $0.1 | `/api/squeeze-score` | FLAGSHIP: short-squeeze / long-flush score 0-100 for any USDT perp. Composite of funding, long/short crowding, 24h OI build, and liq-skew from our exclusive tape. One number that answers "is this trade crowded and about to hurt someone". |
| `get_liq_history` | $0.05 | `/api/liq-history` | HISTORICAL liquidation tape, time-bucketed: total/long/short USD, prints, biggest print per bucket. Any USDT perp or the whole recorded universe, up to 7 days back. Bybit is the only complete liq tape in crypto and no exchange publishes history of it — this data exists nowhere else. |
| `get_liq_heatmap` | $0.05 | `/api/liq-heatmap` | Liquidation heatmap by PRICE LEVEL from our own tape: where leverage actually got flushed in the last N hours — USD, prints, long/short split per price zone, hottest zone flagged. Real prints, not entry-price estimates. |
| `get_cascade_history` | $0.03 | `/api/cascade-history` | PAST liquidation cascades reconstructed from our tape: clustered same-side flush events with start/end, prints, USD total, peak print. get_cascade_alert tells you NOW; this tells you what already happened, up to 72h back. |
| `get_venue_liq_share` | $0.02 | `/api/venue-liq-share` | Which venue is flushing whom: per-exchange liquidation share (Bybit/OKX/Binance) with long/short split and biggest print, any symbol or whole universe. |
| `get_cascade_forecast` | $0.02 | `/api/cascade-forecast` | FORWARD-LOOKING liquidation forecast, not a description of what already happened. Returns the probability that a symbol will liquidate more in the NEXT 15 minutes than its own 90th-percentile 15-minute window. Calibrated on a 28-day tape of 1.4M Bybit liquidations across 799 symbols, which cannot be reconstructed by anyone starting today because no exchange publishes liquidation history. Every answer carries the exact question, the threshold in USD, the window it read, the number of historical occurrences behind the number, and instructions for settling it yourself from the public feed. When a state has too little history the tool DECLINES rather than guessing, and says why. |

### The second moat — our own tokenized-equity peg tape

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_peg_universe` | $0.05 | `/api/peg-universe` | Every tokenized US equity we track, ranked by off-hours peg risk: p95 and max deviation bps, market-open deviation as control, median liquidity. Dead pools are excluded rather than reported as perfect pegs. |
| `get_peg_sessions` | $0.03 | `/api/peg-sessions` | Peg deviation broken out by trading session (open, premarket, afterhours, overnight, weekend): mean, p95, max bps and median liquidity per session, with the worst off-hours window flagged. Market-open acts as the control. |
| `get_peg_deviation` | $0.02 | `/api/peg-deviation` | Peg deviation for a tokenized US equity on Solana: on-chain DEX price vs the underlying last real trade, in bps, with 24h stats split into market-open and off-hours. Sampled every 5 minutes by our own collector; this tape exists nowhere else. |

Sampled every 5 minutes since 19 July 2026. Deviation is measured against the underlying's last real trade — outside US market hours that is the last print before the close, not a live quote. Dead pools are excluded rather than reported as perfect pegs.

### The third moat — our own collateral exit-liquidity tape

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_exit_method` | free | `/api/exit-method` | How the measurement works and the row counts behind every paid answer, computed from the tape at request time |
| `get_exit_quote` | $0.02 | `/api/exit-quote` | EXIT LIQUIDITY on seized collateral: what a liquidator ACTUALLY realises selling a Kamino reserve into live routing, versus the oracle price the protocol marks it at. Returns max_exitable_usd (largest clip whose liquidator margin is still positive, found by bisection, with its resolution width), the exitable fraction, the conservative bound at the 2% penalty floor, and for the nearest clip actually probed: realised USD, haircut bps and liquidator margin bps. Distinguishes a router that REFUSES to quote a token (permissioning, not illiquidity) from a book with no route (a real liquidity finding) - they are different facts and were one status until this split. A terminal verdict requires six consecutive agreeing observations from the symbol's own tape, so a single bad quote cannot produce a finding; withheld verdicts fall back to the last corroborated measurement with its age rather than returning null. Zero bad debt today does not disprove any of this - it means nobody has been forced to test it at size. Method, corroboration rules and row counts are free via get_exit_method. |

### Live liquidations & cascades

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_recent_liquidations` | $0.003 | `/api/liquidations` | Recent liquidations across the USDT perps we record on Bybit (complete unthrottled tape), OKX and Binance. Any symbol, not just majors; defaults to majors. The measured market count is published live at / under coverage.perp_markets_7d |
| `get_cascade_alert` | $0.01 | `/api/cascade` | Liquidation cascade detector for the 5 majors (SOL/BTC/ETH/XRP/DOGE) across Bybit+OKX+Binance. For every perp we record use /api/cascade-scan |
| `get_cascade_scan` | $0.05 | `/api/cascade-scan` | FULL-UNIVERSE cascade scan: every USDT perp we record across Bybit+OKX+Binance. Bybit is the only complete unthrottled liquidation tape in crypto and no exchange publishes history of it |
| `get_liquidation_leaders` | $0.02 | `/api/liquidation-leaders` | What is blowing up right now: top symbols by liquidation USD across every USDT perp we record, with long/short split, biggest print and venue count |
| `get_liquidation_stats` | $0.004 | `/api/liquidation-stats` | 1h/24h liquidation totals for the 5 majors (SOL/BTC/ETH/XRP/DOGE), long/short split, biggest print, per-exchange breakdown |

### Derivatives

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_funding_cross` | $0.01 | `/api/funding-cross` | Funding for ANY USDT perp across Bybit + OKX + Hyperliquid in one call, with cross-venue spread and crowding read. (get_funding_rate covers SOL+BTC only.) |
| `get_funding_extremes` | $0.02 | `/api/funding-extremes` | Most crowded trades across every Bybit USDT perp: top most-positive and most-negative funding with annualized %, 24h price move and OI. Crowded shorts = squeeze candidates. |
| `get_open_interest` | $0.01 | `/api/open-interest` | Open interest for ANY USDT perp: Bybit OI in base + USD with 1h/24h change, plus OKX OI. (get_positioning covers SOL+BTC only.) |
| `get_oi_spike_scan` | $0.02 | `/api/oi-spike-scan` | Abnormal open-interest jumps across every Bybit USDT perp vs a 30min+ baseline — where new leverage is piling in, with funding and price context. Squeeze/flush precursor screener. |
| `get_long_short` | $0.01 | `/api/long-short` | Long/short account ratio for ANY USDT perp with 1h and 24h trend (retail crowding gauge). |
| `get_basis` | $0.01 | `/api/basis` | Perp-vs-spot basis for any USDT pair: premium/discount %, contango/backwardation read, funding context. |
| `get_volatility` | $0.01 | `/api/volatility` | Realized volatility for any USDT perp: 7d and 30d annualized from daily closes, plus today's range. Position-sizing input. |
| `get_funding_history` | $0.005 | `/api/funding-history` | Funding-rate history for any USDT perp (up to 200 intervals): average, annualized, share of positive intervals — what the carry has actually been. |
| `get_top_movers` | $0.01 | `/api/top-movers` | 24h top gainers and losers across every Bybit USDT perp with a liquidity floor, funding attached. The "what moved" screener. |

### Microstructure

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_orderbook_imbalance` | $0.01 | `/api/orderbook-imbalance` | Bid/ask resting-liquidity imbalance within ±N bps of mid for any USDT perp: USD each side, ratio, skew read. |
| `get_orderbook_walls` | $0.01 | `/api/orderbook-walls` | Largest resting orders each side of the book for any USDT perp, with USD size and distance from mid. |
| `get_whale_trades` | $0.02 | `/api/whale-trades` | Large prints from the live trade tape for any USDT perp: trades over a USD threshold, buy/sell totals, net flow, dominant side. |
| `get_spread_arb` | $0.02 | `/api/spread-arb` | Best bid/ask for a USDT perp across Bybit, OKX and Hyperliquid, with the best cross-venue edge in bps (pre-fee). |

### Market & positioning

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_sol_price` | $0.001 | `/api/sol-price` | SOL spot price (multi-source: Coinbase, Kraken, Pyth Hermes fallback) |
| `get_btc_price` | $0.001 | `/api/btc-price` | BTC spot price (multi-source: Coinbase, Kraken, Pyth Hermes fallback) |
| `get_eth_price` | $0.001 | `/api/eth-price` | ETH spot price in USD, aggregated across seven independent venues (CoinGecko, Coinbase, Kraken, Binance, OKX, Gemini, DefiLlama). Returns the lead figure plus every venue quote that answered, so a caller can see the spread rather than trust one exchange. Venues are ranked in a fixed declared order, not completion order, so identical market state always returns the same lead price. |
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
| `get_token_holders` | $0.02 | `/api/token-holders/:mint` | Top holders of any SPL token with per-account share and top1/top5/top10 concentration. Deeper cut than get_token_risk's summary. |
| `get_wallet_activity` | $0.02 | `/api/wallet-activity/:wallet` | Recent transactions of any Solana wallet, parsed human-readable: type, protocol, description, fee, failures (Helius enhanced). |
| `get_priority_fees` | $0.005 | `/api/priority-fees` | Solana priority-fee estimate right now, all levels (min to unsafeMax) in micro-lamports/CU, with a recommended tip. For bots that need txs to land. |
| `get_jito_tips` | $0.005 | `/api/jito-tips` | Jito bundle tip floor percentiles (p25-p99, SOL) — what landed bundles are actually paying, with a landing recommendation. |
| `get_sol_network` | $0.005 | `/api/sol-network` | Solana network health: recent average TPS, current slot, epoch and epoch progress. |

### Base / EVM

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_base_gas` | $0.001 | `/api/base-gas` | Current gas price on Base (chain 8453) in BOTH gwei and wei, with base fee, priority fee and block number when the node supplies them. Both units are returned because a caller asking in wei and a caller asking in gwei are asking the same question. Served from keyless public RPC with three-node fallback, so there is no API key to rotate or expire. |
| `get_base_balance` | $0.002 | `/api/base-balance` | Native ETH or any ERC20 balance for an address on Base or Ethereum mainnet. decimals() and symbol() are read from the contract at request time rather than assumed, because assuming 18 reports a USDC balance a trillion times too large. Accepts a 0x address or an ENS name; ENS is resolved through two independent resolvers and the answer is used only when they agree, so a wrong address can never produce a confident balance for the wrong wallet. An unsupported chain is refused rather than silently answered from the wrong one. |

### DeFi / macro

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_tvl` | $0.005 | `/api/tvl` | TVL for any DeFi protocol (with 1d/7d change) or top-15 chains ranking. DefiLlama-backed. |
| `get_stablecoin_flows` | $0.01 | `/api/stablecoin-flows` | Total stablecoin supply with 7d/30d deltas and top stables — the macro risk-on/risk-off dial for crypto. |
| `get_dex_quote` | $0.005 | `/api/dex-quote` | Live Jupiter swap quote for any SPL pair: output amount, price impact, route. The real executable price on Solana, not an index price. |
### Free tasters

Seven, of which three have an HTTP route — those three are the ones published at `/` under
`free_tools`. The other four are MCP-only and have no paid HTTP equivalent to undercut.

| Tool | Route |
|---|---|
| `get_fear_greed` | `/api/fear-greed` |
| `get_last_liquidation` | `/api/last-liquidation` (15-min delayed) |
| `get_exit_method` | `/api/exit-method` |
| `get_cascade_forecast_free` | MCP only — full-quality SOL liquidation forecast, nothing withheld |
| `get_forecast_question` | MCP only — what the forecast answers and how to settle it yourself |
| `get_forecast_record` | MCP only — live settled track record with the raw rows |
| `pricing` | MCP only — lists everything with live prices |

A free route answers `"paid": false`, and a paid one `"paid": true`, because that field is
per-request: it reports whether the route you called is priced. `curl`ing any of the three
above costs nothing and says so.

## Use it from an elizaOS agent

```bash
npm i @seekdaseek/plugin-agentfeed   # v0.5.0 (npm latest, 2026-09-23)
```

Set `AGENTFEED_PRIVATE_KEY` to a funded Solana wallet and the agent pays per call automatically. Default spend cap $0.50/call (`AGENTFEED_MAX_SPEND_PER_CALL` to change).

## Try it free right now

```bash
curl https://x402.ochinimus.app/api/fear-greed       # "paid": false — it really is free
curl https://x402.ochinimus.app/api/last-liquidation
curl https://x402.ochinimus.app/api/exit-method
curl https://x402.ochinimus.app/                    # full pricing index + live coverage
curl https://x402.ochinimus.app/api/cascade-scan    # returns 402 + payment terms
```

x402 clients pay and retry automatically.

## Pay for a call

### x402 — the client that ships in this repo

`test-client.mjs` is the repo's own Solana x402 payer: `@x402/svm`'s `ExactSvmScheme` behind
`wrapFetchWithPaymentFromConfig`, reading a standard `solana-keygen` 64-byte JSON keypair.

```bash
node test-client.mjs https://x402.ochinimus.app/api/sol-price ./payer-wallet.json
```

`test-client-evm.mjs` is the same thing over Base (`eip155:8453`) with a viem account, and
`test-mcp-client.mjs` pays MCP tool calls over Streamable HTTP. Settlements land in the audit
table with the payer and the transaction signature; the last run of this client from the
project's own payer `GBFoGJXvLsgBXAKJw9cGK18BGxaevpYtAyQKoqgcSQKz` settled
`4ixeZSHSYcBcx5PhRDvPbLwMY2Vgj24FPkjnCaBkewhfcva2kHj32suXv7UE2M4NGsh4q31yGJRqx5nvqbBLNxvD`.

### MPP — the Foundation's `pay` CLI

```bash
pay --mainnet --mpp --account <account> curl -s https://x402.ochinimus.app/api/btc-price
```

Two MPP payments settled against this service on 2026-09-19, at 21:53:39 and 21:57:36 UTC,
and both signatures are recorded in the replay store so neither can be spent twice.

**The `pay` CLI needs an interactive session.** An account with `auth_required: true` blocks on
a Touch ID prompt that cannot render in CI, a headless agent or a scheduled task, and it blocks
*without a timeout* — it looks exactly like a network hang while holding zero TCP sockets. That
is [`solana-foundation/pay` #469](https://github.com/solana-foundation/pay/issues/469). Run it
from a real GUI session, or use an account without `auth_required`.

## MCP quickstart

Point any MCP client at `https://x402.ochinimus.app/mcp` (Streamable HTTP, POST). Paid tools
return payment terms; an x402-capable client settles and retries.

`createx402MCPClient` is exported by the published `@x402/mcp` (checked against
the npm tarball, 2.27.0, 2026-09-23). This is what `test-mcp-client.mjs` in this
repo actually does:

```js
import { createx402MCPClient } from '@x402/mcp';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = createx402MCPClient({
  name: 'agentfeed-test',
  version: '1.0.0',
  schemes: [{ network: 'solana:*', client: new ExactSvmScheme(signer) }],
  autoPayment: true,
});

await client.connect(new StreamableHTTPClientTransport(new URL('https://x402.ochinimus.app/mcp')));
const { tools } = await client.listTools();
const result = await client.callTool('get_sol_price', {});   // pays and retries
```

Also available as an [elizaOS plugin](https://www.npmjs.com/package/@seekdaseek/plugin-agentfeed).

---

## Configuration

Every variable the service reads, derived from the source
(`grep -rhoE "process\.env\.[A-Z0-9_]+"`). Only `HELIUS_API_KEY`, `PAY_TO` and — when MPP is
on — `MPP_SECRET_KEY` have no working default.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3006` | |
| `HELIUS_API_KEY` | — | **required**; Solana RPC + DAS + enhanced transactions |
| `HELIUS_RPC` | `https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY` | |
| `HELIUS_ENH` | `https://api.helius.xyz` | |
| `X402_MODE` | `on` | `off` serves every route free |
| `X402_NETWORK` | `devnet` | set `mainnet` in production |
| `PAY_TO` | — | **required**; Solana treasury that receives USDC |
| `PAY_TO_EVM` | — | Base treasury; unset drops the Base rail from the challenge |
| `FACILITATOR_URL` | `https://facilitator.x402.org` | |
| `MPP_ENABLED` | unset (off) | `true` mounts the `solana/charge` layer |
| `MPP_SECRET_KEY` | — | **required when `MPP_ENABLED=true`; must be 32 characters or longer** — mppx HMAC-binds the challenge id so verification is stateless, and init refuses anything shorter |
| `MPP_NETWORK` | `mainnet` | |
| `MPP_REALM` | `x402.ochinimus.app` | the `realm` in the `WWW-Authenticate` challenge |
| `MPP_RPC_URL` | Helius, from `HELIUS_API_KEY` | |
| `LIQ_DB` | `/opt/agentfeed/liquidations.db` | the liquidation tape (read-only) |
| `PEGWATCH_DB` | `/opt/pegwatch/pegwatch.db` | tokenized-equity peg tape (read-only) |
| `OVERHANG_DB_PATH` | `/opt/overhang/overhang.db` | collateral exit-liquidity tape (read-only) |
| `CALIPER_DIR` | `/opt/caliper` | forecast model directory |
| `CALIPER_MODEL` | `$CALIPER_DIR/model.json` | |
| `CALIPER_RECORD_DB` | `$CALIPER_DIR/record.db` | |
| `CALIPER_LIQ_DB` | `/opt/agentfeed/liquidations.db` | |
| `TELEGRAPH_LOG` | alongside the source | request-shape log |
| `BYBIT_WS` `BYBIT_REST` `BYBIT_API` `BYBIT_MAX_SYMBOLS` | Bybit public | `1000` symbol cap |
| `OKX_WS` `OKX_REST` `OKX_API` | OKX public | |
| `BINANCE_WS` | Binance public | |
| `HL_API` | `https://api.hyperliquid.xyz/info` | |
| `JUP_API` | `https://lite-api.jup.ag` | |
| `JITO_API` | `https://bundles.jito.wtf` | |
| `LLAMA_API` | `https://api.llama.fi` | |
| `STABLES_API` | `https://stablecoins.llama.fi` | |
| `BASE_RPC` | `https://mainnet.base.org` | |

`DB_PATH`, `SIGNATURE`, `VERIFY_DELAY_MS`, `HOME` and `PATH` appear only in the MPP test
harness (`mpp/test/helpers/`) and are not service configuration.

## Tests

```bash
npm install
cd mpp && npm install && cd ..    # separate tree: mppx pins express>=5, this service is express 4

node --test test/tool.test.js     # 10 tests — the route wrapper and the `paid` flag
node --test mpp/test/*.js         # 40 tests — MPP conformance, offline, every RPC call stubbed
```

Neither `package.json` declares a `test` script; the commands above are the ones the test
files themselves document.

`test/tool.test.js` mounts the real wrapper from `lib/tool.js` — the same module `server.js`
mounts, not a copy — on a throwaway express app over a real socket, so `req.route` is
populated exactly as in production. It covers a priced route, a path-parameter route (which
is what proves the flag matches on the registered *pattern* and not the request URL), an
unpriced route that is nonetheless registered with a price argument, `X402_MODE=off`, the
audit row's field set on success / error / bad_request, and prototype pollution through
`req.route.path`.

Two of the MPP tests fork real worker processes to race the replay store across process
boundaries rather than simulating the race in one event loop.

---

## Free dataset

A multi-venue liquidation dataset — normalized, growing daily, free — ships with a full
quality statement covering coverage dates, known gaps, exchange throttles, and field
definitions: **[ochinimuse.gumroad.com/l/liqdata](https://ochinimuse.gumroad.com/l/liqdata)**

Read `DATASET_QUALITY.md` before you use it. It tells you exactly where the data is wrong.

---

## Links

[MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=agentfeed) ·
[Smithery](https://smithery.ai/servers/ochinimus/agentfeed) ·
[x402 manifest](https://x402.ochinimus.app/.well-known/x402.json) ·
[ochinimus](https://ochinimus.app)

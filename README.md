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
perpetual on all three, recorded continuously since 2026-07-08.

The size of that tape is not a claim, it is a query. Measured 2026-09-23:

| | |
|---|---|
| Rows | **4,595,128** |
| Distinct perp markets, whole tape | **906** |
| Distinct perp markets, last 7 days | **874** — binance 727 · bybit 711 · okx 468 |
| Range (UTC) | 2026-07-08 16:42:32 → 2026-09-23 09:17:56 |

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

## Tools

| Tool | Price | Description |
| --- | --- | --- |
| get_sol_price | $0.001 | SOL spot price |
| get_btc_price | $0.001 | BTC spot price |
| get_eth_price | $0.001 | ETH spot price across seven venues, with every venue quote that answered |
| get_funding_rate | $0.002 | SOL+BTC perp funding rates |
| get_market_snapshot | $0.003 | Full market snapshot in one call |
| get_wallet_holdings | $0.008 | Solana wallet holdings via Helius DAS |
| get_token_metadata | $0.005 | SPL token metadata via Helius DAS |
| get_recent_liquidations | $0.003 | Recent liquidations across 874 USDT perps |
| get_cascade_alert | $0.01 | Live liquidation cascade detector for the 5 majors |
| get_cascade_scan | $0.05 | Full-universe cascade scan across 874 USDT perps |
| get_liquidation_leaders | $0.02 | Top symbols by liquidation USD right now |
| get_liquidation_stats | $0.004 | 1h/24h liquidation totals, long/short split |
| get_positioning | $0.004 | SOL+BTC long/short ratio + open interest |
| get_trade_context | $0.01 | Full market state in one call |
| get_token_risk | $0.01 | SPL token rug-risk signals |
| get_liq_history | $0.05 | Historical liquidation tape, time-bucketed |
| get_liq_heatmap | $0.05 | Liquidation heatmap by price level from our tape |
| get_cascade_history | $0.03 | Past liquidation cascades from our tape |
| get_cascade_forecast | $0.02 | FORWARD-LOOKING: probability a symbol liquidates more in the next 15 min than its own p90 window |
| get_squeeze_score | $0.10 | FLAGSHIP: 0-100 short-squeeze / long-flush signal |
| get_venue_liq_share | $0.02 | Which venue is flushing whom |
| get_funding_cross | $0.01 | Funding for any USDT perp across Bybit + OKX + Hyperliquid |
| get_funding_extremes | $0.02 | Most crowded funding trades across 874 perps |
| get_open_interest | $0.01 | Open interest for any USDT perp with 1h/24h change |
| get_oi_spike_scan | $0.02 | Abnormal open-interest jumps across 874 perps |
| get_long_short | $0.01 | Long/short account ratio for any USDT perp |
| get_basis | $0.01 | Perp-vs-spot basis for any USDT pair |
| get_volatility | $0.01 | Realized volatility for any USDT perp |
| get_funding_history | $0.005 | Funding-rate history for any USDT perp |
| get_top_movers | $0.01 | 24h top gainers and losers across 874 perps |
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
| get_peg_deviation | $0.02 | Tokenized-equity peg deviation vs the underlying last trade |
| get_peg_sessions | $0.03 | Peg deviation by session: open, premarket, afterhours, overnight, weekend |
| get_peg_universe | $0.05 | Tracked tokenized equities ranked by off-hours peg risk |
| get_exit_quote | $0.02 | Exit liquidity on seized Kamino collateral: what a liquidator actually realises vs the oracle mark |
| get_base_gas | $0.001 | Base (8453) gas price in gwei and wei, with base fee, priority fee and block |
| get_base_balance | $0.002 | Native ETH or any ERC20 balance on Base or Ethereum, decimals read from the contract |

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
| [`solana-foundation/pay-kit` #328](https://github.com/solana-foundation/pay-kit/pull/328) | `fix(mpp): send preflightCommitment with sendTransaction so confirmed-only blockhashes are accepted` — a challenge blockhash minted at `confirmed` is rejected by a preflight bank that defaults to `finalized`, so a client that pays *fast* always fails |
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
| `get_squeeze_score` | $0.1 | `/api/squeeze-score` | FLAGSHIP: short-squeeze / long-flush score 0-100 for any USDT perp |
| `get_liq_history` | $0.05 | `/api/liq-history` | HISTORICAL liquidation tape, time-bucketed: total/long/short USD, prints, biggest print per bucket |
| `get_liq_heatmap` | $0.05 | `/api/liq-heatmap` | Liquidation heatmap by PRICE LEVEL from our own tape: where leverage actually got flushed in the last N hours — USD, prints, long/short s… |
| `get_cascade_history` | $0.03 | `/api/cascade-history` | PAST liquidation cascades reconstructed from our tape: clustered same-side flush events with start/end, prints, USD total, peak print |
| `get_venue_liq_share` | $0.02 | `/api/venue-liq-share` | Which venue is flushing whom: per-exchange liquidation share (Bybit/OKX/Binance) with long/short split and biggest print, any symbol or w… |

### The second moat — our own tokenized-equity peg tape

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_peg_universe` | $0.05 | `/api/peg-universe` | Every tokenized US equity we track, ranked by off-hours peg risk: p95 and max deviation bps, market-open as control, median liquidity |
| `get_peg_sessions` | $0.03 | `/api/peg-sessions` | Peg deviation by trading session — open, premarket, afterhours, overnight, weekend — worst off-hours window flagged |
| `get_peg_deviation` | $0.02 | `/api/peg-deviation` | Peg deviation for one tokenized equity: on-chain DEX price vs the underlying last real trade, in bps |

Sampled every 5 minutes since 19 July 2026. Deviation is measured against the underlying's last real trade — outside US market hours that is the last print before the close, not a live quote. Dead pools are excluded rather than reported as perfect pegs.

### The third moat — our own collateral exit-liquidity tape

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_exit_quote` | $0.02 | `/api/exit-quote` | Exit liquidity on seized collateral: what a liquidator actually realises selling a Kamino reserve into live routing versus the oracle mark — max exitable USD, exitable fraction, haircut and liquidator margin in bps |
| `get_exit_method` | free | `/api/exit-method` | How the measurement works and the row counts behind every paid answer, computed from the tape at request time |

### Live liquidations & cascades

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_recent_liquidations` | $0.003 | `/api/liquidations` | Recent liquidations across 874 USDT perps (Bybit complete tape + OKX + Binance) |
| `get_cascade_alert` | $0.01 | `/api/cascade` | Liquidation cascade detector for the 5 majors (SOL/BTC/ETH/XRP/DOGE) across Bybit+OKX+Binance |
| `get_cascade_scan` | $0.05 | `/api/cascade-scan` | FULL-UNIVERSE cascade scan: 874 USDT perps across Bybit+OKX+Binance |
| `get_liquidation_leaders` | $0.02 | `/api/liquidation-leaders` | What is blowing up right now: top symbols by liquidation USD across 874 USDT perps, with long/short split, biggest print and venue count |
| `get_liquidation_stats` | $0.004 | `/api/liquidation-stats` | 1h/24h liquidation totals for the 5 majors (SOL/BTC/ETH/XRP/DOGE), long/short split, biggest print, per-exchange breakdown |

### Derivatives

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_funding_cross` | $0.01 | `/api/funding-cross` | Funding for ANY USDT perp across Bybit + OKX + Hyperliquid in one call, with cross-venue spread and crowding read |
| `get_funding_extremes` | $0.02 | `/api/funding-extremes` | Most crowded trades across 874 USDT perps: top most-positive and most-negative funding with annualized %, 24h price move and OI |
| `get_open_interest` | $0.01 | `/api/open-interest` | Open interest for ANY USDT perp: Bybit OI in base + USD with 1h/24h change, plus OKX OI |
| `get_oi_spike_scan` | $0.02 | `/api/oi-spike-scan` | Abnormal open-interest jumps across 874 USDT perps vs a 30min+ baseline — where new leverage is piling in, with funding and price context |
| `get_long_short` | $0.01 | `/api/long-short` | Long/short account ratio for ANY USDT perp with 1h and 24h trend (retail crowding gauge) |
| `get_basis` | $0.01 | `/api/basis` | Perp-vs-spot basis for any USDT pair: premium/discount %, contango/backwardation read, funding context |
| `get_volatility` | $0.01 | `/api/volatility` | Realized volatility for any USDT perp: 7d and 30d annualized from daily closes, plus today's range |
| `get_funding_history` | $0.005 | `/api/funding-history` | Funding-rate history for any USDT perp (up to 200 intervals): average, annualized, share of positive intervals — what the carry has actua… |
| `get_top_movers` | $0.01 | `/api/top-movers` | 24h top gainers and losers across 874 USDT perps with a liquidity floor, funding attached |

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
| `get_sol_price` | $0.001 | `/api/sol-price` | SOL spot price |
| `get_btc_price` | $0.001 | `/api/btc-price` | BTC spot price |
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

A free HTTP route still answers with `"paid": true` in its body. That field reports whether
the x402 layer is mounted on this process, not whether *your* call was charged — it was not,
and the audit row for it records `free`.

## Use it from an elizaOS agent

```bash
npm i @seekdaseek/plugin-agentfeed   # v0.5.0 (npm latest, 2026-09-23)
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

```js
import { createx402MCPClient } from "@x402/mcp";
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
node --test mpp/test/*.js         # 40 tests, offline — every RPC call is stubbed
```

Neither `package.json` declares a `test` script; the command above is the one the test files
themselves document. Two of the tests fork real worker processes to race the replay store
across process boundaries rather than simulating the race in one event loop.

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

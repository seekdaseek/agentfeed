<!-- mcp-name: io.github.seekdaseek/agentfeed -->
# AgentFeed

[![LightNow capabilities](https://lightnow.ai/badge/io.github.seekdaseek/agentfeed)](https://lightnow.ai/servers/io.github.seekdaseek/agentfeed)

**Crypto market data for AI agents (liquidations, funding, open interest, prices), Solana pre-trade checks, OFAC sanctions screening, scholarly papers, utilities and fixed-purpose language tasks (OCR, translate, summarize, extract, classify, prompt-injection check, transcribe). Pay per call in USDC. No accounts, no subscriptions, and no API key needed (prepaid keys are optional, for bots that cannot pay x402).**

AgentFeed sells live trading data through the [x402 payment protocol](https://solana.com/x402) on Solana, Base, Polygon, Arbitrum, Arc, Algorand, Optimism, Monad and Avalanche, and on request on Celo, HyperEVM, Unichain, Scroll, SKALE Base, BNB Chain, Ethereum, Robinhood Chain, World Chain, Sei and X Layer (`GET /api/<route>|<network>`). An agent hits an endpoint, gets a `402 Payment Required` with the price, pays a fraction of a cent in USDC (or the dollar token the network names) from its own wallet, and receives the data — in about two seconds, gas sponsored by the facilitator.

Two rails, same data:

| Rail | Endpoint | For |
|------|----------|-----|
| **MCP** (Streamable HTTP) | `https://x402.ochinimus.app/mcp` | Claude, Cursor, MCP-native frameworks |
| **HTTP** (x402) | `https://x402.ochinimus.app/api/*` | Anything that speaks HTTP |

---

## What makes this different: the liquidation tape

We run our own liquidation collector across **Bybit, OKX and Binance** — every USDT-margined
perpetual on all three, recorded continuously since 2026-07-08.

The size of that tape is not a claim, it is a query. Measured **2026-09-28 06:56 UTC**:

| | |
|---|---|
| Rows | **4,924,729** |
| Distinct perp markets, whole tape | **907** |
| Distinct perp markets, last 7 days | **861** — binance 728 · bybit 693 · okx 454 |
| Range (UTC) | 2026-07-08 16:42:32 → 2026-09-28 06:56:17 |

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
read 2026-10-18 — names, prices and routes are the manifest's, not a copy kept
in sync by hand. What each one returns is under
[90 tools](#90-tools-83-paid-data-routes--7-free--pricing), word for word as
the service publishes it.

| Tool | Price | Route |
|---|---|---|
| `buy_key_pass` | $25 | `/api/keys/buy-pass` |
| `buy_key_20` | $20 | `/api/keys/buy-20` |
| `topup_key_20` | $20 | `/api/keys/topup-20` |
| `buy_key_5` | $5 | `/api/keys/buy-5` |
| `topup_key_5` | $5 | `/api/keys/topup-5` |
| `buy_key_1` | $1 | `/api/keys/buy-1` |
| `buy_key_day_pass` | $1 | `/api/keys/buy-day-pass` |
| `buy_key_trial` | $0.25 | `/api/keys/buy-trial` |
| `get_squeeze_score` | $0.1 | `/api/squeeze-score` |
| `get_cascade_scan` | $0.05 | `/api/cascade-scan` |
| `get_liq_history` | $0.05 | `/api/liq-history` |
| `get_peg_universe` | $0.05 | `/api/peg-universe` |
| `get_ocr` | $0.04 | `/api/ocr` |
| `get_translate` | $0.04 | `/api/translate` |
| `get_cascade_history` | $0.03 | `/api/cascade-history` |
| `get_peg_sessions` | $0.03 | `/api/peg-sessions` |
| `get_extract` | $0.025 | `/api/extract` |
| `get_sol_token_check` | $0.025 | `/api/sol-token-check/:mint` |
| `get_base_launches` | $0.02 | `/api/base-launches` |
| `get_cascade_forecast` | $0.02 | `/api/cascade-forecast` |
| `get_exit_quote` | $0.02 | `/api/exit-quote` |
| `get_funding_extremes` | $0.02 | `/api/funding-extremes` |
| `get_funding_radar` | $0.02 | `/api/funding-radar` |
| `get_hl_whales` | $0.02 | `/api/hl-whales` |
| `get_liq_heatmap` | $0.02 | `/api/liq-heatmap` |
| `get_liquidation_leaders` | $0.02 | `/api/liquidation-leaders` |
| `get_market_state` | $0.02 | `/api/market-state` |
| `get_oi_spike_scan` | $0.02 | `/api/oi-spike-scan` |
| `get_peg_deviation` | $0.02 | `/api/peg-deviation` |
| `get_summarize` | $0.02 | `/api/summarize` |
| `get_token_holders` | $0.02 | `/api/token-holders/:mint` |
| `get_tradfi_radar` | $0.02 | `/api/tradfi-radar` |
| `get_transcribe` | $0.02 | `/api/transcribe` |
| `get_venue_liq_share` | $0.02 | `/api/venue-liq-share` |
| `get_wallet_activity` | $0.02 | `/api/wallet-activity/:wallet` |
| `get_papers` | $0.015 | `/api/papers` |
| `get_basis` | $0.01 | `/api/basis` |
| `get_cascade_alert` | $0.01 | `/api/cascade` |
| `get_equity_24h` | $0.01 | `/api/equity-24h` |
| `get_honeypot_check` | $0.01 | `/api/honeypot-check` |
| `get_insider_trades` | $0.01 | `/api/insider-trades` |
| `get_liquidation_stats` | $0.01 | `/api/liquidation-stats` |
| `get_open_interest` | $0.01 | `/api/open-interest` |
| `get_orderbook_imbalance` | $0.01 | `/api/orderbook-imbalance` |
| `get_orderbook_walls` | $0.01 | `/api/orderbook-walls` |
| `get_pdf_markdown` | $0.01 | `/api/pdf-markdown` |
| `get_sec_8k` | $0.01 | `/api/sec-8k` |
| `get_signal_board` | $0.01 | `/api/signal-board` |
| `get_token_risk` | $0.01 | `/api/token-risk/:mint` |
| `get_top_movers` | $0.01 | `/api/top-movers` |
| `get_trade_context` | $0.01 | `/api/trade-context` |
| `get_volatility` | $0.01 | `/api/volatility` |
| `get_sanctions_check` | $0.008 | `/api/sanctions-check/:address` |
| `get_sol_holder_clusters` | $0.008 | `/api/sol-holder-clusters/:mint` |
| `get_sol_token_flow` | $0.008 | `/api/sol-token-flow/:mint` |
| `get_wallet_holdings` | $0.008 | `/api/wallet-holdings/:wallet` |
| `get_base_balance` | $0.005 | `/api/base-balance` |
| `get_base_gas` | $0.005 | `/api/base-gas` |
| `get_classify` | $0.005 | `/api/classify` |
| `get_convert` | $0.005 | `/api/convert` |
| `get_domain` | $0.005 | `/api/domain/:domain` |
| `get_email_verify` | $0.005 | `/api/email-verify` |
| `get_funding_history` | $0.005 | `/api/funding-history` |
| `get_funding_pulse` | $0.005 | `/api/funding-pulse` |
| `get_funding_rate` | $0.005 | `/api/funding-rate` |
| `get_hash` | $0.005 | `/api/hash` |
| `get_jito_tips` | $0.005 | `/api/jito-tips` |
| `get_liq_pulse` | $0.005 | `/api/liq-pulse` |
| `get_macro_calendar` | $0.005 | `/api/macro-calendar` |
| `get_market_snapshot` | $0.005 | `/api/market-snapshot` |
| `get_paper` | $0.005 | `/api/paper/:doi` |
| `get_perp` | $0.005 | `/api/perp` |
| `get_positioning` | $0.005 | `/api/positioning` |
| `get_priority_fees` | $0.005 | `/api/priority-fees` |
| `get_qr` | $0.005 | `/api/qr` |
| `get_recent_liquidations` | $0.005 | `/api/liquidations` |
| `get_sec_filings` | $0.005 | `/api/sec-filings` |
| `get_sol_network` | $0.005 | `/api/sol-network` |
| `get_time` | $0.005 | `/api/time` |
| `get_token_metadata` | $0.005 | `/api/token-metadata/:mint` |
| `get_tradfi_perps` | $0.005 | `/api/tradfi-perps` |
| `get_web_markdown` | $0.005 | `/api/web-markdown` |
| `get_wiki` | $0.005 | `/api/wiki` |
| `get_coin_signal` | $0.004 | `/api/coin-signal/:coin` |
| `get_injection_check` | $0.004 | `/api/injection-check` |
| `get_fx_rates` | $0.002 | `/api/fx-rates` |
| `get_btc_price` | $0.001 | `/api/btc-price` |
| `get_eth_price` | $0.001 | `/api/eth-price` |
| `get_liq_feed` | $0.001 | `/api/liq-feed` |
| `get_sol_price` | $0.001 | `/api/sol-price` |
| `get_spot` | $0.001 | `/api/price` |

## Two payment protocols on one 402

Every paid route answers `402` with an x402 v2 challenge in the `PAYMENT-REQUIRED` header, and
the same challenge as an x402 v1 body (`{x402Version: 1, accepts}`) for Base and Solana. Pay with
`PAYMENT-SIGNATURE` (v2, any rail) or `X-PAYMENT` (v1 on Base or Solana, verified and settled
through the CDP facilitator's v1 kinds; Polygon and Arbitrum have no v1 kind there and stay v2).
Nine networks are in every 402 and eleven more are offered on request (see "Pay on any chain"). Each network is settled by
exactly one facilitator: CDP for Solana, Base, Polygon, Arbitrum and World Chain; Circle's Facilitator Service for Arc, to a
dedicated Arc address; GoPlausible for Algorand; Ultravioleta for Optimism, Monad, Avalanche, Celo, HyperEVM, Unichain, Scroll,
SKALE Base, BNB Chain, Ethereum and Robinhood Chain; PayAI for Sei and X Layer. `payments.js` gives each facilitator client only
its own networks, so a payment on one network can never reach another's facilitator.
Every paid route also carries MPP `tempo`/`charge` challenges in `WWW-Authenticate` (Tempo
mainnet, chain 4217, OUSD first, then USDC.e, at the route's price; no fee payer, the payer pays
gas). Only signed transactions (pull mode) are accepted: the server validates the transfer, runs
the request, and broadcasts it only when the response is below 400, so a failed call is never
charged; an already-broadcast hash credential is refused. `/api/sol-price` and `/api/btc-price`
additionally carry an MPP `solana`/`charge` challenge. All of them ride the *same* response, so
a client settles with whichever protocol it speaks. The two live in disjoint header namespaces, so an x402-only client never sees the MPP
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

## Half price for high-frequency callers

A bot that calls often pays half the route's price, minimum $0.0005, through either of two schemes that ride the same 402 as the per-call accepts. Per-call prices do not change. The six prepaid-key purchase routes carry per-call accepts only. The Gateway accept is offered on Arc only: it was withdrawn from Base, Polygon and Arbitrum on 18 Oct 2026, because buyers whose client picked it as the cheapest accept of the chain signed a plain USDC authorization to the Gateway wallet, which is not a Gateway payment and was refused.

| | batch-settlement | Circle Gateway nanopayment |
|---|---|---|
| Networks | Base, Polygon, Arbitrum | Arc |
| Accept | `scheme: batch-settlement` | `scheme: exact`, `extra.name: GatewayWalletBatched` |
| Pays | the treasury `0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6` | Gateway seller `0xA853129ACF56A851f9d51CD8cb47619465260Fa9` |
| Buyer does once | opens a channel with one deposit (`extra.minDeposit` in the accept); every later call is an off-chain voucher | deposits USDC into the GatewayWallet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` |
| Settlement | we claim the vouchers every 30 minutes | Circle batches the authorizations |
| Unspent money | comes back through the channel's timed withdrawal (24 h delay) | stays in the buyer's Gateway balance |

A call that answers 400 or more is never charged on either scheme.

### batch-settlement, on Base

```js
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';

const account = privateKeyToAccount(process.env.EVM_KEY);
const pub = createPublicClient({ chain: base, transport: http() });
const signer = Object.assign(account, { readContract: (args) => pub.readContract(args) });
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new BatchSettlementEvmScheme(signer) }],
});

// the first call opens the channel (one EIP-3009 authorization, no ETH needed); the rest are vouchers
for (let i = 0; i < 5; i++) {
  const res = await pay('https://x402.ochinimus.app/api/eth-price');
  console.log(res.status, await res.json());
}
```

Keep the `pay` object alive between calls. A client that starts a fresh process for every call is asked once to resync while vouchers are outstanding, and is then served in the same request.

Full script, with a guard that checks the accept before anything is signed: `ops/proof-batch.mjs`.

### Gateway, on Arc

The Gateway accept is on Arc only (see "Pay on Arc" below for the full walk-through): `ops/proof-gateway.mjs` (`CHAIN=arc`, the default) deposits into the GatewayWallet once and pays one nanopayment.

### Proven on mainnet

- 13 Oct 2026, batch-settlement on Base: a channel opened with deposit [0x6175…4492](https://basescan.org/tx/0x61756295ac7bfe27d7d3e897b1985f0bb7986f5062cc68bbc5492a67a6344492), ten 0.0005 USDC vouchers, claimed and settled to the treasury; a second run paid 8 calls while the claim job ran.
- 13 Oct 2026, Gateway on Arc: see "Pay on Arc" below.

All of them were paid from our own test wallets.

## Pay on Arc

Every paid route takes USDC on Arc mainnet (`eip155:5042`, USDC `0x3600000000000000000000000000000000000000`, 6 decimals) in two ways. Both sit in the same 402 as the other rails (the prepaid-key purchase routes offer the exact one only), so a client pays with whatever it holds. Gas on Arc is paid in USDC, so a buyer needs nothing else.

| | x402 exact | Circle Gateway nanopayment |
|---|---|---|
| Accept | `scheme: exact` | `scheme: exact`, `extra.name: GatewayWalletBatched` |
| Price | the route's price | half the route's price, minimum $0.0005 |
| Settled by | Circle Facilitator Service, one transaction per call | Circle Gateway, batched |
| Pays | `0x0Cf44185564F2b72E291050DC79E578429E52f83` | Gateway seller `0xA853129ACF56A851f9d51CD8cb47619465260Fa9` |
| Buyer needs | USDC on Arc | a one-time deposit into the GatewayWallet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` |

### One call: x402 exact

```js
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';

const account = privateKeyToAccount(process.env.ARC_KEY);
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:5042', client: new ExactEvmScheme(account) }],
});
const res = await pay('https://x402.ochinimus.app/api/liquidation-stats');
console.log(res.status, await res.json());
```

Full script: `ops/pay-arc.mjs`.

### Many calls: Gateway nanopayments

```js
import { GatewayClient } from '@circle-fin/x402-batching/client';

const client = new GatewayClient({ chain: 'arc', privateKey: process.env.ARC_KEY });
await client.deposit('0.02'); // once: approve + deposit, gas paid in USDC
const res = await client.pay('https://x402.ochinimus.app/api/liquidation-stats');
console.log(res.formattedAmount, res.data);
```

Full script, with a deposit sized from a live gas estimate and a dry run: `ops/proof-gateway.mjs` (`CHAIN=arc`).

### Proven on mainnet

- 12 Oct 2026, x402 exact through Circle's facilitator: [0x15e8…41d0](https://explorer.arc.io/tx/0x15e83159a25d280a78b5f4fc4bf46935582f3e4acfc7cac2bee271862eca41d0)
- 13 Oct 2026, Gateway deposit [0xffe7…9d50](https://explorer.arc.io/tx/0xffe7818566106b5412f2f8025c56f4d49a4743ed74338011a8022b948f849d50), then a 0.0005 USDC nanopayment (Circle transfer `d32e4ea9-2d62-4fd6-ad4c-6de70affba00`)
- 14 Oct 2026, x402 exact through Circle's facilitator with the production key: [0xee59…bf33](https://explorer.arc.io/tx/0xee5973cda3f2683f74695e4813e7979712dafc6bb317d918365e80ff222fbf33), a 0.001 USDC call to `/api/eth-price`, status ok

All of them were paid from our own test wallets.

### Where it lives in the code

- `lib/rails.js`: the Arc rail (network, asset, payTo).
- `lib/circle-arc.js`: the Circle Facilitator Service client: Arc-only `/supported`, `/verify`, `/settle` and settlement-status polling. A payment still pending is withheld and logged for `ops/arc-reconcile.js`.
- `lib/hf.js`: the half-price tier: batch-settlement on Base, Polygon and Arbitrum, the Gateway offer on Arc, the half-price rule, and `routeGateway`, which hands Gateway payments to Circle's `BatchFacilitatorClient` while every other payment keeps its facilitator.
- `ops/batch-claim.js`: claims and settles batch-settlement vouchers every 30 minutes.
- `payments.js`: facilitator order: Coinbase CDP first, Circle for Arc, then the Gateway tier.
- `ops/gateway-withdraw.mjs` and `ops/arc-sweep.mjs`: revenue out of the hot addresses.
- `test/arc.test.js`.

## Pay on any chain

Nine networks are in every paid route's `402`; eleven more are offered on request. Ask for one by suffixing the route: `GET /api/<route>|<network>` (the `|` may be sent as `%7C`), for example `/api/sol-price|eip155:42220` for Celo. The `402` that comes back carries the default accepts plus that network's accept, and a payment on any network is accepted on the plain URL too. The prepaid-key purchase routes carry the nine only. The first six networks (Solana, Base, Polygon, Arbitrum, Arc, Algorand) are described under "Two payment protocols on one 402" and "Pay on Arc"; the table lists the other fourteen, generated from `lib/ext-rails.js`. Every row is `scheme: exact` (EIP-3009), paid to the same EVM treasury, settled by the one facilitator named in the row.

| Network | CAIP-2 id | Token and address | Decimals | Facilitator | Offered | Minimum route price |
|---|---|---|---|---|---|---|
| Optimism | `eip155:10` | USDC `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | 6 | Ultravioleta | every 402 | none |
| Monad | `eip155:143` | USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | 6 | Ultravioleta | every 402 | none |
| Avalanche | `eip155:43114` | USDC `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | 6 | Ultravioleta | every 402 | none |
| Celo | `eip155:42220` | USDC `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | 6 | Ultravioleta | on request | none |
| HyperEVM | `eip155:999` | USDC `0xb88339CB7199b77E23DB6E890353E22632Ba630f` | 6 | Ultravioleta | on request | none |
| Unichain | `eip155:130` | USDC `0x078D782b760474a361dDA0AF3839290b0EF57AD6` | 6 | Ultravioleta | on request | none |
| Scroll | `eip155:534352` | USDC `0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4` | 6 | Ultravioleta | on request | none |
| SKALE Base | `eip155:1187947933` | USDC.e `0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20` | 6 | Ultravioleta | on request | none |
| BNB Chain | `eip155:56` | AUSD `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` | 6 | Ultravioleta | on request | none |
| Ethereum | `eip155:1` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 | Ultravioleta | on request | none |
| Robinhood Chain | `eip155:4663` | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 | Ultravioleta | on request | none |
| World Chain | `eip155:480` | USDC `0x79A02482A880bCE3F13e09Da970dC34db4CD24d1` | 6 | CDP | on request | none |
| Sei | `eip155:1329` | USDC `0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392` | 6 | PayAI | on request | $0.005 |
| X Layer | `eip155:196` | USDC `0xB6CEceAB302E2E4948951eE7843FC24E92933061` | 6 | PayAI | on request | $0.005 |

The token is not USDC everywhere: BNB Chain settles AUSD, Robinhood Chain USDG and SKALE Base USDC.e. Sei and X Layer are offered only on routes priced $0.005 or more, because PayAI charges per settlement.

### Paying with @x402/fetch

`@x402/fetch` 2.28 refuses any token outside `@x402/evm`'s `DEFAULT_ASSETS` unless the client opts in with `spendControls.allowedAssets`. Out of the box a stock client pays Monad, Avalanche, Celo, Ethereum and Sei. It is refused on Optimism, HyperEVM, Unichain, Scroll, SKALE Base, BNB Chain, Robinhood Chain, World Chain and X Layer until the token is allowed. The option shape, from `@x402/core`'s own type definitions:

```ts
spendControls?: {
  maxAmountPerPayment?: Money | false;                 // USD cap on default assets, default "$1"
  allowedAssets?: true | SpendControlAsset[];          // true allows any asset
}
interface SpendControlAsset {
  network: Network;                                    // CAIP-2, e.g. 'eip155:10'
  asset: string;                                       // on-chain token address, or a default-asset symbol
  maxAmountPerPayment?: string;                        // integer atomic units, e.g. '50000' = $0.05 at 6 decimals
}
```

A payment on Optimism, with the token allowed explicitly (the cap `'50000'` is $0.05; the token is the address in the table):

```js
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';

const account = privateKeyToAccount(process.env.EVM_KEY);
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:10', client: new ExactEvmScheme(account) }],
  spendControls: { allowedAssets: [{ network: 'eip155:10', asset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', maxAmountPerPayment: '50000' }] },
});
const res = await pay('https://x402.ochinimus.app/api/sol-price');
console.log(res.status, await res.json());
```

Without the `spendControls` line the same client throws "All payment requirements were rejected by spendControls". Full script, with a dry run that prints the accept before anything is signed: `ops/r10-proof-evm.mjs`.

### Proven on mainnet

- 14 Oct 2026, three proof payments of 0.001 USDC on `/api/sol-price|<network>`, each one USDC transfer from our test wallet to the treasury: Optimism [0xdc64…d4c5](https://optimism.blockscout.com/tx/0xdc642dc7c4c3e96fa59e0704737adce62693e69cd534961676e43501ff55d4c5), Monad [0xdf06…da2d](https://monadscan.com/tx/0xdf06372e33166459c41944703f536b4e551c136e483d0366664f38a9f004da2d), Avalanche [0x5c3e…70d0](https://snowscan.xyz/tx/0x5c3ee5c2d858732abca327500e761e0977807a53a4de0f44d4cd57ddc14d70d0).
- The other eleven networks are offered on request and have no settled payment yet.

All of them were paid from our own test wallets.

## 90 tools (83 paid data routes + 7 free) & pricing

**83 paid + 7 free**, 90 total on the MCP rail (the eight prepaid-key routes below are HTTP only). Every call is metered individually in USDC over
x402 — no bundles, no minimums. Calling all 83 paid data tools once costs **$1.137**. Counts and prices are summed from
[the live manifest](https://x402.ochinimus.app/.well-known/x402.json), read 2026-10-15.

The flagship is [`get_squeeze_score`](#the-moat--our-own-liquidation-tape) — a 0-100 short-squeeze / long-flush composite built from funding, crowding, OI build and the liq-skew of our exclusive tape. One number, one dime, answers "is this trade crowded and about to hurt someone."

### The moat — our own liquidation tape

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_squeeze_score` | $0.1 | `/api/squeeze-score` | Short squeeze score and long flush score, 0-100, for any Hyperliquid perp. Composite of Hyperliquid funding (35), whale crowding (25: the net-long share of the top 250 Hyperliquid accounts in the coin, not retail), the 24h open-interest build from our own 5-minute sampler (20) and liquidation skew from our own tape (20). One number for whether a trade is crowded and about to hurt someone. A symbol nothing lists answers 400; while the open-interest record is under 24 hours deep, or Hyperliquid or the whale snapshot is unavailable, it answers 503; both are never billed. A listed coin none of the top 250 accounts holds returns 200 with a decline naming the missing input. |
| `get_liq_history` | $0.05 | `/api/liq-history` | Liquidation history, time-bucketed: total, long and short USD, prints and biggest print per bucket, for any USDT perp or the whole recorded universe, up to 7 days back. Bybit is the only complete liq tape in crypto and no exchange publishes history of it. |
| `get_liq_heatmap` | $0.02 | `/api/liq-heatmap` | Liquidation heatmap by PRICE LEVEL: where leverage actually got flushed in the last N hours — USD, prints and long/short split per price zone, with the hottest zone flagged. Built from real liquidation prints, not entry-price estimates. BTC, ETH, SOL, HYPE or any other USDT perp on our multi-venue liquidation tape. |
| `get_cascade_history` | $0.03 | `/api/cascade-history` | Liquidation cascade history: past clustered same-side flush events reconstructed from our own tape, with start and end, prints, USD total and peak print, up to 72h back. /api/cascade tells you what is happening NOW; this tells you what already happened. |
| `get_venue_liq_share` | $0.02 | `/api/venue-liq-share` | Liquidations by exchange: per-venue liquidation share across Bybit, OKX and Binance with long/short split and biggest print, for any symbol or the whole recorded universe. Which venue is flushing whom. |
| `get_cascade_forecast` | $0.02 | `/api/cascade-forecast` | Liquidation forecast, FORWARD-LOOKING and not a description of what already happened. Returns the probability that a symbol will liquidate more in the NEXT 15 minutes than its own 90th-percentile 15-minute window. Calibrated on our whole multi-venue liquidation tape, over 6 million liquidations, refit every 6 hours; no exchange publishes that history, so it cannot be rebuilt. Every answer carries the exact question, the threshold in USD, the window it read, the number of historical occurrences behind the number, and instructions for settling it yourself from the public feed. When a state has too little history the tool DECLINES rather than guessing, and says why. The settled record is free at /api/forecast-record. |

### The second moat — our own tokenized-equity peg tape

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_peg_universe` | $0.05 | `/api/peg-universe` | Tokenized stocks ranked by off-hours peg risk: every tokenized US equity we track, with p95 and max deviation bps, market-open deviation as the control, and median liquidity. Dead pools are excluded rather than reported as perfect pegs. |
| `get_peg_sessions` | $0.03 | `/api/peg-sessions` | Tokenized stock peg by trading session: deviation broken out across open, premarket, afterhours, overnight and weekend — mean, p95, max bps and median liquidity each, with the worst off-hours window flagged. Market-open acts as the control. |
| `get_peg_deviation` | $0.02 | `/api/peg-deviation` | Tokenized stock peg deviation on Solana: the on-chain DEX price of a tokenized US equity versus the underlying's last real trade, in bps, with 24h stats split into market-open and off-hours. Sampled every 5 minutes by our own collector; the token price is read on-chain. latest.reference is null: the underlying's reference price is not returned (its source does not allow redistribution), only the deviation computed from it. |

Sampled every 5 minutes. Deviation is measured against the underlying's last real trade — outside US market hours that is the last print before the close, not a live quote. Dead pools are excluded rather than reported as perfect pegs.

### The third moat — our own collateral exit-liquidity tape

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_exit_method` | free | `/api/exit-method` | How the measurement works and the row counts behind every paid answer, computed from the tape at request time |
| `get_exit_quote` | $0.02 | `/api/exit-quote` | EXIT LIQUIDITY on seized collateral: what a liquidator ACTUALLY realises selling a Kamino reserve into live routing, versus the oracle price the protocol marks it at. Returns max_exitable_usd (largest clip whose liquidator margin is still positive, found by bisection, with its resolution width), the exitable fraction, the conservative bound at the 2% penalty floor, and for the nearest clip actually probed: realised USD, haircut bps and liquidator margin bps. Distinguishes a router that REFUSES to quote a token (permissioning, not illiquidity) from a book with no route (a real liquidity finding) - they are different facts and were one status until this split. A terminal verdict requires six consecutive agreeing observations from the symbol's own tape, so a single bad quote cannot produce a finding; withheld verdicts fall back to the last corroborated measurement with its age rather than returning null. Zero bad debt today does not disprove any of this - it means nobody has been forced to test it at size. Method, corroboration rules and row counts are free via get_exit_method. |

### Live liquidations & cascades

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_recent_liquidations` | $0.005 | `/api/liquidations` | Crypto liquidations, live tape: recent perp liquidation prints across Bybit, OKX and Binance with timestamp, side liquidated, size, price and USD value. Any USDT perp we record, not just majors. The Bybit tape is complete and unthrottled. |
| `get_cascade_alert` | $0.01 | `/api/cascade` | Liquidation cascade detector, live: clustered same-side liquidations happening NOW on SOL, BTC, ETH, XRP and DOGE across venues, with side, USD total, prints, duration and severity. For every perp we record use /api/cascade-scan. |
| `get_cascade_scan` | $0.05 | `/api/cascade-scan` | Liquidation cascade scan across EVERY USDT perp we record at once, not just the majors: symbol, side liquidated, USD total, prints, duration, severity. Computed from our own multi-venue liquidation tape. |
| `get_liquidation_leaders` | $0.02 | `/api/liquidation-leaders` | Liquidation leaderboard: top symbols by liquidation USD right now across every USDT perp we record on Bybit, OKX and Binance, with long/short split, biggest single print and venue count. What is blowing up, ranked. |
| `get_liquidation_stats` | $0.01 | `/api/liquidation-stats` | Liquidation stats, 1h and 24h totals for SOL, BTC, ETH, XRP and DOGE: long vs short USD split, biggest single print, and a per-exchange breakdown across Bybit, OKX and Binance. |
| `get_liq_pulse` | $0.005 | `/api/liq-pulse` | Use when an agent needs to know what is being liquidated right now. Returns the last 60 minutes across every USDT perp we record: total USD, long/short split, prints and the top 5 symbols. If our recording is stale it answers 503 and is never billed. |
| `get_liq_feed` | $0.001 | `/api/liq-feed` | Use when an agent needs liquidation pressure as it happens. Returns 5-second buckets per symbol of long and short USD liquidated across venues, the dominant side and pressure against the symbol's own baseline, from a gap-free cursor. |

### Derivatives

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_funding_radar` | $0.02 | `/api/funding-radar` | Funding radar over every Hyperliquid perp: 337 on 13 Oct 2026, 178 on the main dex and 159 on the HIP-3 dexes (stocks, indices, commodities, FX). Per perp: the current funding at its 8h equivalent, its 30-day z-score against its own settled history, the dex and asset class, and a flag on any \|z\| of 2 or more, most extreme first. By default it returns the perps with $10M and up of open interest; min_oi_usd changes that and 0 returns them all. Precomputed every 5 minutes with as_of; a snapshot older than 15 minutes answers 503 and is never billed. |
| `get_market_state` | $0.02 | `/api/market-state` | Market state for BTC, ETH, SOL or HYPE in one call: spot and the perp's basis against the Hyperliquid oracle, realized vol 7d and 30d, funding with its 30-day z-score, open interest and its changes, the top Hyperliquid accounts' net-long share, liquidations 1h and 24h by side, Fear and Greed, the next FOMC or CPI release, and flags with stated thresholds. Every part carries its source and as-of time; a part we do not hold is null with a reason. When nothing of the market itself could be built it answers 503 and is never billed. |
| `get_funding_extremes` | $0.02 | `/api/funding-extremes` | Funding rate extremes across every Hyperliquid perp above a liquidity floor: the most positive and most negative funding with annualized %, 24h price move and open interest. The most crowded trades in the market — crowded shorts are squeeze candidates. |
| `get_open_interest` | $0.01 | `/api/open-interest` | Open interest for ANY Hyperliquid perp: OI in base units and in USD with the mark price, and its 1h and 24h change from our own 5-minute sampler (null until that record reaches back so far). /api/positioning adds the whale net-long share for SOL and BTC. |
| `get_oi_spike_scan` | $0.02 | `/api/oi-spike-scan` | Open interest spikes across every Hyperliquid perp: coins whose open interest moved abnormally in the last hour against their own previous day, with the 1h, 4h and 24h change (in coin units, so a price move does not count), a spike z-score, the price move and funding. Read from our own 5-minute sampler: it answers 503 and is never billed until that record is 24 hours deep. |
| `get_basis` | $0.01 | `/api/basis` | Perp basis for any Hyperliquid perp: its mark price against Hyperliquid's oracle price (the validators' weighted median of spot venues), as a premium or discount in %, with a contango or backwardation read and the funding context. |
| `get_volatility` | $0.01 | `/api/volatility` | Realized volatility for any Hyperliquid perp: 7-day and 30-day annualized from daily candles, plus today's range in %. A position-sizing input. |
| `get_funding_history` | $0.005 | `/api/funding-history` | Funding rate history for any Hyperliquid perp, up to 200 hourly settlements: the average rate, its annualized %, the share of intervals that were positive, and the raw series. What the carry has actually been. |
| `get_top_movers` | $0.01 | `/api/top-movers` | Top gainers and losers over 24h across every Hyperliquid perp above a liquidity floor, each with its funding rate attached. The "what moved" screener. |
| `get_perp` | $0.005 | `/api/perp` | Use when an agent needs one perp market in a single call. Returns Hyperliquid funding and open interest (with 1h/24h change from our 5-minute sampler) and 24h liquidations with long/short split and biggest print from our own tape. A symbol nothing lists answers 400 and a failed read answers 503; neither is ever billed. |
| `get_funding_pulse` | $0.005 | `/api/funding-pulse` | Use when an agent needs the most extreme funding rates right now. Returns the 5 largest absolute annualised rates across the Hyperliquid perps above a liquidity floor, each with 8h rate, open interest and 24h price move. One call, not a full screen. |

### Microstructure

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_orderbook_imbalance` | $0.01 | `/api/orderbook-imbalance` | Orderbook imbalance for any Hyperliquid perp: resting bid and ask liquidity in USD within ±N bps of mid, the ratio between the two sides, and a skew read. |
| `get_orderbook_walls` | $0.01 | `/api/orderbook-walls` | Orderbook walls for any Hyperliquid perp: the largest resting orders on each side of the book, with USD size and distance from mid. |

### Market & positioning

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_spot` | $0.001 | `/api/price` | Use when an agent needs a spot price without choosing a venue. Returns the on-chain DEX price for SOL, BTC or ETH, the median of deep USDC pools on Solana, Ethereum and Base read from chain state, and the pools that served it. Any other symbol answers 400 with the supported list and is never billed. |
| `get_sol_price` | $0.001 | `/api/sol-price` | SOL price / Solana spot price in USD, live, read on-chain: the median of the two deepest SOL/USDC pools on Solana (Orca Whirlpool, Raydium CLMM), computed from chain state. Returns the price, the read time and the pools that answered. |
| `get_btc_price` | $0.001 | `/api/btc-price` | BTC price / Bitcoin spot price in USD, live, read on-chain: the median of three Uniswap V3 reads on Base and Ethereum (cbBTC/USDC, and cbBTC and WBTC through WETH/USDC), computed from chain state. Returns the price, the read time and the pools that answered. |
| `get_eth_price` | $0.001 | `/api/eth-price` | ETH spot price in USD, read on-chain from the two deepest WETH/USDC Uniswap V3 pools, on Ethereum and on Base. Returns their median plus each pool's own price, so a caller can see the spread between chains. Computed from chain state; no exchange feed. |
| `get_funding_rate` | $0.005 | `/api/funding-rate` | Funding rate for any Hyperliquid perp: the raw rate, its interval in hours, the 8h equivalent, the annualised rate, next funding time and mark price. Without a symbol: funding rates for the SOL and BTC perps on Hyperliquid, with open interest. The whole table with 30-day z-scores: /api/funding-radar. |
| `get_market_snapshot` | $0.005 | `/api/market-snapshot` | Crypto market snapshot in one call: SOL and BTC spot prices read on-chain from DEX pools, both Hyperliquid perp funding rates with mark price and open interest, and the Fear & Greed index with its classification. Five reads, one payment. |
| `get_positioning` | $0.005 | `/api/positioning` | Positioning for SOL and BTC perps on Hyperliquid: open interest with its 1h and 24h change, and the net-long share of the top 250 Hyperliquid accounts. For any other Hyperliquid perp use /api/open-interest. |
| `get_trade_context` | $0.01 | `/api/trade-context` | Crypto trading context in one call: SOL and BTC prices read on-chain from DEX pools, perp funding rates, Fear & Greed, positioning (open interest and the top Hyperliquid accounts' net-long share) and 1h/24h liquidation stats. The whole pre-trade picture, one payment. |
| `get_hl_whales` | $0.02 | `/api/hl-whales` | Use when an agent needs to know how the biggest Hyperliquid traders are positioned. Returns the open perp positions of the largest Hyperliquid accounts aggregated per coin: net long or short USD, account counts, size-weighted entries, notional-weighted distance to liquidation, notional within 10% of liquidation and uPnL. With coin=BTC: whale liquidation levels in 5% price bands and the largest positions. Refreshed every 5 minutes; stale data answers 503. |

### Solana on-chain

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_wallet_holdings` | $0.008 | `/api/wallet-holdings/:wallet` | Solana wallet holdings for any address: native SOL with its USD value at AgentFeed's own on-chain SOL price, every SPL token with mint, symbol and amount (no token prices), and an NFT count. Balances and on-chain metadata via Helius DAS getAssetsByOwner, up to 100 assets. |
| `get_token_metadata` | $0.005 | `/api/token-metadata/:mint` | SPL token metadata for any Solana mint: name, symbol, URI, decimals, total supply, mint and freeze authority, token program, and whether the metadata is still mutable. Read from the mint account and its metadata account. |
| `get_token_risk` | $0.01 | `/api/token-risk/:mint` | Solana token rug check / risk signals for any SPL mint: mint and freeze authority status (revoked is safer), top-1 and top-10 holder concentration, supply, and a list of risk flags. Not a honeypot or LP-lock checker. |
| `get_token_holders` | $0.02 | `/api/token-holders/:mint` | Top holders of any SPL token: per-account share with top-1, top-5 and top-10 concentration for a Solana mint. A deeper cut than the summary in /api/token-risk. |
| `get_wallet_activity` | $0.02 | `/api/wallet-activity/:wallet` | Solana wallet activity: recent transactions for any address, each with the wallet's SOL and token balance changes, the fee, failures and the programs invoked. Read from the chain and summarised by us. |
| `get_priority_fees` | $0.005 | `/api/priority-fees` | Solana priority fees right now: percentiles from min to max of the per-slot minimum fee paid on the busiest SOL/USDC pools over the last ~150 slots, in micro-lamports per compute unit, with a recommended level. For bots that need their transactions to land. |
| `get_jito_tips` | $0.005 | `/api/jito-tips` | Jito tips sampled on-chain: p25 to p99 in SOL of the newest transfers into Jito's tip accounts, what landed bundles actually paid, refreshed every 15 minutes (the age is in the answer), with a landing recommendation. |
| `get_sol_network` | $0.005 | `/api/sol-network` | Solana network health: recent average TPS, the current slot, the current epoch and epoch progress in %. |
| `get_sol_token_check` | $0.025 | `/api/sol-token-check/:mint` | Use when an agent needs a pre-trade check on a Solana token. Returns mint and freeze authority, Token-2022 traps, top holders, deepest pool and USD depth, the price impact of $100 and $1,000 buys, pump.fun progress, and a verdict with every rule. |
| `get_sol_token_flow` | $0.008 | `/api/sol-token-flow/:mint` | Use when an agent needs to know who is trading a Solana token. Returns the unique traders over its latest swaps, top-5 share of volume, round-trip wallets, share of brand-new buyer wallets and launch-slot bundle size for mints under 7 days. |
| `get_sol_holder_clusters` | $0.008 | `/api/sol-holder-clusters/:mint` | Use when an agent needs to know whether a Solana token's holders are one owner. Returns the account that first funded each of the top 20 wallets, the clusters sharing a funder and their supply share. A shared funder can be an exchange. |

### Base / EVM

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_base_gas` | $0.005 | `/api/base-gas` | Base gas price (chain 8453) in BOTH gwei and wei, with base fee, priority fee and block number when the node supplies them. Both units are returned because a caller asking in wei and a caller asking in gwei are asking the same question. Served from keyless public RPC with three-node fallback, so there is no API key to rotate or expire. |
| `get_base_balance` | $0.005 | `/api/base-balance` | ERC20 and native ETH wallet balance on Base or Ethereum mainnet, for a 0x address or an ENS name. decimals() and symbol() are read from the contract at request time rather than assumed, because assuming 18 reports a USDC balance a trillion times too large. ENS is resolved through two independent resolvers and the answer is used only when they agree, so a wrong address can never produce a confident balance for the wrong wallet. An unsupported chain is refused rather than silently answered from the wrong one. |

| `get_honeypot_check` | $0.01 | `/api/honeypot-check` | Use when an agent needs to know whether a token on Base, BNB Chain or Ethereum can be sold before it buys. Returns a verdict from our own buy-then-sell simulation on the token's deepest pool, with the buy and sell tax measured. Also: whether a wallet transfer works, bytecode flags (mintable, blacklist, proxy, pausable, owner), where simulation and bytecode disagree, and the block. Uniswap, Aerodrome and PancakeSwap pools. No pool found is a finding; RPC failure answers 503. |
| `get_base_launches` | $0.02 | `/api/base-launches` | Use when an agent needs the newest token launches on Base. Returns pools created on Base in the last 24 hours on Uniswap V4, V3, V2 and Aerodrome, newest first, with launchpad, liquidity and volume. Each carries its pair, creation time, launchpad named from the V4 hook (Zora, Clanker, Doppler, Flaunch), quote-side liquidity, 24h volume and swaps, and our honeypot simulation for the busiest. Read from Base logs every minute; a snapshot older than 5 minutes answers 503. |

### Filings, documents & web

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_sec_filings` | $0.005 | `/api/sec-filings` | Use when an agent needs a US company's latest SEC filings. Returns the most recent EDGAR filings for a ticker, optionally one form type (10-K, 10-Q, 8-K, 4, S-1, 13F-HR), with filing date, report date, accession number, description, 8-K item codes and links to the document and the filing index. Source: SEC EDGAR public filings. |
| `get_insider_trades` | $0.01 | `/api/insider-trades` | Use when an agent needs what a company's insiders bought and sold. Returns one row per transaction from the company's recent SEC Form 4 filings: insider, role, transaction code and meaning, shares, price, value, shares owned after and date, plus open-market buy and sale totals for the window. Source: SEC EDGAR Form 4 filings. |
| `get_sec_8k` | $0.01 | `/api/sec-8k` | Use when an agent needs the material events US companies disclosed in the last hours. Returns the 8-K filings filed across the market in the window, with company, CIK, filing time, accession number, the 8-K item codes and titles (e.g. 2.02 results, 5.02 officer changes, 1.01 agreements) and a count per item. Source: SEC EDGAR current filings. |
| `get_web_markdown` | $0.005 | `/api/web-markdown` | Use when an agent needs the readable text of a web page as markdown. Returns the main content of the one URL you pass as clean markdown (Mozilla Readability, then turndown), with title, final URL, fetch time and word count. http or https on ports 80 and 443, 5 MB, 10 s; robots.txt honoured and private addresses refused. A blocked or unreachable URL is never charged. |
| `get_pdf_markdown` | $0.01 | `/api/pdf-markdown` | Use when an agent needs the text of a PDF as markdown. Returns the text of the one PDF URL you pass, page by page as markdown, with title, page count and word count. http or https, 10 MB, 10 s; robots.txt honoured and private addresses refused. A file that is not a PDF, a PDF with no text layer (a scan), or an unreachable URL, is never charged. |

### Macro

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_macro_calendar` | $0.005 | `/api/macro-calendar` | FOMC, CPI, NFP and PCE calendar for traders: the next Fed rate decisions and the CPI, nonfarm payrolls and PCE release dates with UTC times converted from New York time (DST-aware), each with its official Fed, BLS or BEA source URL and the time we verified it. Read daily from the agencies' own pages and never entered by hand; data verified more than 35 days ago answers 503 and is never charged. |
| `get_fx_rates` | $0.002 | `/api/fx-rates` | Use when an agent needs official daily exchange rates. Returns the ECB euro foreign exchange reference rates for about 30 currencies, as published or as crosses for another base, plus Hyperliquid HIP-3 FX and commodity marks. The ECB rates are available free of charge on the ECB's website; they are for information only, not for transactions. |

### TradFi perps & stocks

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_tradfi_radar` | $0.02 | `/api/tradfi-radar` | Stock perps, S&P 500, Nasdaq, gold and oil perps ranked by funding rate: every stock, index, commodity and FX perp on the Hyperliquid HIP-3 dexes (trade[XYZ], Paragon, Markets by Kinetiq, Entropy), with funding at its 8h equivalent, a 30-day funding z-score, open interest and its 24h change, mark minus oracle basis and 24h volume. Filter by asset class. Precomputed every 5 minutes; stale data answers 503. |
| `get_equity_24h` | $0.01 | `/api/equity-24h` | Weekend price for US stocks: an indicative 24/7 price for a stock or index (TSLA, NVDA, S&P 500, Nasdaq) from stock perps on Hyperliquid and our tokenized stocks DEX price, with the last regular-session price, its time and source, the implied gap in %, each source's liquidity and the session (open, pre, after, overnight, weekend). Indicative, never an exchange quote; 503 when no source has liquidity. |
| `get_tradfi_perps` | $0.005 | `/api/tradfi-perps` | Use when an agent needs a 24/7 price for a stock, index, commodity or currency outside market hours. Returns Hyperliquid HIP-3 perp markets: oracle and mark price, premium, hourly and 8h funding, open interest, 24h change and the dex. With symbol (TSLA, GOLD, EUR or xyz:TSLA): every live market for it. Without: the whole list. Prices are each market's own HIP-3 oracle and mark. |

### Research, compliance & utilities

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_sanctions_check` | $0.008 | `/api/sanctions-check/:address` | Use when an agent needs to screen a crypto wallet before paying or being paid. Returns an exact match of a Bitcoin, Ethereum, Tron, Solana or other address against the OFAC SDN list, with entry, program and list date. No match is not a clearance. |
| `get_email_verify` | $0.005 | `/api/email-verify` | Use when an agent needs to know whether an email address can plausibly receive mail. Returns syntax, MX, disposable-domain, role-account and free-provider checks with a deliverable_likely, risky or undeliverable verdict and its reasons. No SMTP probe. |
| `get_domain` | $0.005 | `/api/domain/:domain` | Use when an agent needs the basic facts about a domain. Returns its DNS A, AAAA, MX, NS and TXT records and the live TLS certificate: issuer, alternative names, validity dates and days to expiry. Public hosts only; no registrar data. |
| `get_papers` | $0.015 | `/api/papers` | Use when an agent needs scholarly papers on a topic. Returns OpenAlex works (CC0 data) for a search: title, year, DOI, authors, venue, citation count and open-access link, up to 25, optionally from a given year. Cached 24 hours. |
| `get_paper` | $0.005 | `/api/paper/:doi` | Use when an agent needs the paper behind a DOI. Returns title, year, authors, venue, citation count, open-access URL and the abstract where OpenAlex holds it (CC0 data). The DOI goes in the path as written, slash included: /api/paper/10.1038/nature14539. |
| `get_wiki` | $0.005 | `/api/wiki` | Use when an agent needs a reliable plain-text summary of a topic. Returns the Wikipedia summary and lead section for a page title in any language, with the CC BY-SA 4.0 licence, the article URL and the authors link. Cached 24 hours. |
| `get_qr` | $0.005 | `/api/qr` | Use when an agent needs a QR code for a link, address or payment string. Returns an SVG or PNG (base64 and data URI) at error-correction level M, scaled for scanning. Input up to 2 KB; over that is a 400, never billed. |
| `get_hash` | $0.005 | `/api/hash` | Use when an agent needs a hash it should not compute itself. Returns SHA-256, Keccak-256 (the Ethereum hash) or BLAKE2b-512 of UTF-8 text or hex bytes, as hex and 0x-hex. Input up to 2 KB; over that is a 400, never billed. |
| `get_time` | $0.005 | `/api/time` | Use when an agent needs an exact time conversion with the right daylight-saving rules. Returns an ISO time or epoch in any IANA time zone: local time with offset, weekday, abbreviation, DST flag and epoch. Defaults to now in UTC. |
| `get_convert` | $0.005 | `/api/convert` | Use when an agent needs an exact unit conversion. Returns the value converted between units of length, mass, volume, time, data, speed, area, pressure, energy or temperature, to 12 significant digits. Mixing categories is a 400, never billed. |

Sources and their terms: the OFAC SDN list (a US federal government work), the CC0 disposable-email-domains list, DNS and a live
TLS handshake, OpenAlex (CC0 data), Wikipedia (CC BY-SA 4.0, attribution in every answer); details in
[docs/SOURCES.md](docs/SOURCES.md).

### Language tasks (fixed-purpose, Gemini)

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_ocr` | $0.04 | `/api/ocr` | Use when an agent needs the text inside an image. Returns the text of a PNG, JPEG, WebP or GIF (5 MB, 4096 px a side) in reading order, as blocks with their line breaks, plus the detected language. It transcribes; it never follows text in the image. |
| `get_summarize` | $0.02 | `/api/summarize` | Use when an agent needs the gist of a web page or PDF. Returns a short or medium summary with key points, and says whether the document was cut at 20,000 tokens and how much was read. Uses only what the document says. |
| `get_extract` | $0.025 | `/api/extract` | Use when an agent needs named fields from a page or PDF. Returns JSON for a schema of up to 20 fields (string, number, boolean, date, string[]), with null for anything the document does not state, never an invented value. |
| `get_translate` | $0.04 | `/api/translate` | Use when an agent needs text in another language. Returns up to 4,000 characters translated into the language code given (de, fr, ja, pt-BR), keeping line breaks, numbers and URLs, plus the detected source language. It never obeys the text. |
| `get_classify` | $0.005 | `/api/classify` | Use when an agent needs text sorted into its own categories. Returns a score per label that sums to 1 and the best label, for up to 4,000 characters and 2 to 20 labels. Labels are names, never instructions. Cached 24 hours. |
| `get_injection_check` | $0.004 | `/api/injection-check` | Use when an agent needs untrusted text screened for prompt-injection attempts. Returns no_injection_found, suspicious or malicious for up to 4,000 characters, with the matched rules (role tags, hidden Unicode, encoded payloads) and a model's view. |
| `get_transcribe` | $0.02 | `/api/transcribe` | Use when an agent needs the words in an audio file. Returns the text, timed segments and the spoken language for mp3, wav, m4a, ogg or webm audio (10 MB, 5 minutes, checked from the file). Cached 24 hours by the audio itself. |

Each one is a single fixed task on Google's Gemini API (paid tier): the caller supplies content, never a prompt, model or setting.
Untrusted content travels as delimited data, every output is schema-checked, and a provider failure is a 503 that is never billed.
These seven are available only to callers inside [Google's available regions](https://ai.google.dev/gemini-api/docs/available-regions):
elsewhere they answer 451 before any payment.

### Signals for trading bots

| Tool | Price | Route | What you get |
|---|---|---|---|
| `get_signal_board` | $0.01 | `/api/signal-board` | The Hyperliquid perp market in one table, ranked by open interest: price change, funding, OI and its change, last-hour liquidations with a z-score against the coin's own 7 days, whale net position and tilt, and the flags crowded_long, crowded_short, squeeze_risk, liq_spike (rules in the description). Poll every 1-5 minutes. |
| `get_coin_signal` | $0.004 | `/api/coin-signal/:coin` | The same row for one coin plus the 15-minute cascade probability, the nearest liquidation clusters above and below price and the top 3 whale positions. |

Both read only data this service records itself (the Hyperliquid OI sampler, the liquidation tape, the whale snapshot) and name every source with its `as_of`; a stale source answers 503 and is never billed. With a [prepaid key](#prepaid-keys-for-bots-that-cannot-pay-x402) they cost $0.005 and $0.002.

### Liquidation pressure feed for bots

`GET /api/liq-feed` is cross-venue liquidation pressure, computed by AgentFeed from its own liquidation recording and served the way a bot polls: 5-second buckets, a cursor that never skips and never repeats, and a floor price.

- **What a row is.** One row per symbol per closed 5-second bucket that held a liquidation: `longs` and `shorts` (USD, base quantity and VWAP of the long and the short positions liquidated, all venues combined into one figure), `dominant` (`longs`, `shorts` or `balanced`: the side holding at least 60% of the bucket) and `pressure` (the bucket's USD against the symbol's own typical USD per 5 seconds, its median hour of the last 7 days floored at $5,000 an hour). Numbers are rounded to 2 significant figures (3 for the VWAP) and no count of prints is returned.
- **The cursor.** Send `since=<ms>` once (up to 24 h back; without it the first call begins 2 minutes back), then send each answer's `next` back unchanged. A bucket is served only after it has been closed for 10 seconds, every closed bucket is served exactly once, and `has_more` tells you to ask again at once. Up to 20 symbols and 500 rows a call (`symbols=BTC,ETH,SOL`, or `BTC-USDT` style).
- **What it costs a bot.** $0.001 a call over x402, $0.0005 on a [prepaid key](#prepaid-keys-for-bots-that-cannot-pay-x402). One call every 5 seconds (one bucket) per caller, an x402 payer or a prepaid key, and every 10 seconds for a pass key (a refused poll is a 429 with `Retry-After`, never billed; a call that follows an answer saying `has_more` is exempt). A key has the same single clock over REST and over the MCP tool `get_liq_feed`; an x402 payer is keyed by IP over REST and by paying wallet over MCP. The horizon moves in 5-second steps, so a call sooner than that could not carry a new bucket. At the 5-second floor that is 17,280 calls and **$8.64 a day** on a key; at a 30-second poll 2,880 calls and **$1.44 a day**; at 60 seconds, $0.72. A [bot pass](#prepaid-keys-for-bots-that-cannot-pay-x402) ($25 flat for 30 days, this route only) is $0.83 a day at any poll rate.

```bash
curl -s -H "X-AgentFeed-Key: $AGENTFEED_KEY" \
  "https://x402.ochinimus.app/api/liq-feed?symbols=BTC,ETH,SOL&since=$(( $(date +%s) * 1000 - 300000 ))"
```

### Free tasters

Seven, of which four have an HTTP route — those four are the ones published at `/` under
`free_tools`. The other three are MCP-only and have no paid HTTP equivalent to undercut.

| Tool | Route |
|---|---|
| `get_fear_greed` | `/api/fear-greed` |
| `get_last_liquidation` | `/api/last-liquidation` (15-min delayed) |
| `get_exit_method` | `/api/exit-method` |
| `get_cascade_forecast_free` | MCP only — full-quality SOL liquidation forecast, nothing withheld |
| `get_forecast_question` | MCP only — what the forecast answers and how to settle it yourself |
| `get_forecast_record` | `/api/forecast-record` — live settled track record with the raw rows |
| `pricing` | MCP only — lists everything with live prices |

Two more free HTTP endpoints carry no tool of their own:

| Endpoint | What you get |
|---|---|
| `GET /api/sample` | Lists every paid route that has a stored sample response |
| `GET /api/sample/<route>` | The real captured response for one of the paid routes — the same example its Bazaar listing carries — with its price, input schema and paid URL. See what a route returns before paying for it. |

A free route answers `"paid": false`, and a paid one `"paid": true`, because that field is
per-request: it reports whether the route you called is priced. `curl`ing either of the two
above costs nothing and says so.

## Use it from an elizaOS agent

```bash
npm i @seekdaseek/plugin-agentfeed   # one action per data route; the current version is on npm
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

## Prepaid keys (for bots that cannot pay x402)

A bot that can set an HTTP header but cannot sign an x402 payment (n8n, Freqtrade, Hummingbot, a plain script, a gateway such as claw402) buys a key once and spends it per call.

- **Buy once**, with any x402 client, on any exact rail the route offers: `GET /api/keys/buy-trial` ($0.25), `buy-1`, `buy-5`, `buy-20`. Top up with `topup-5` or `topup-20`, sending the key as the header. Or in a browser at [/keys](https://x402.ochinimus.app/keys) with a Base wallet: the page loads no library and sends nothing but the key's hash.
- **Spend per call:** send `X-AgentFeed-Key: afk_...` (or `Authorization: Bearer afk_...`) on any paid GET or on `POST /mcp`. Each call draws **half the route's x402 price, minimum $0.0005**, from the balance; a 400, 404, 500 or 503 is never drawn. 120 requests per minute per key.
- **Bring your own key:** generate `afk_` + base58 of 32 random bytes yourself and buy with `?key_hash=<sha256 hex>&prefix=<8 characters after afk_>`; the server registers the hash and never sees the key, and a dropped connection after payment loses nothing. Without `key_hash` the server generates the key and returns it once.
- **Bot pass:** `GET /api/keys/buy-pass` ($25) is a different kind of key for a bot that polls `/api/liq-feed` all day: valid for 30 days from the moment its payment settles, good **only** on `/api/liq-feed` (and the MCP tool `get_liq_feed`), nothing drawn per call, still one call per 10 seconds. Every other route answers 403 to it, it cannot be topped up, and `GET /api/keys/balance` shows its routes and expiry. At a 30-second poll it costs $0.83 a day, against $1.44 a day on an ordinary key.
- **Day pass:** `GET /api/keys/buy-day-pass` is **$1.00 flat for 24 hours** from the moment its payment settles, good **only** on `/api/liq-feed` and `/api/liquidations`, nothing drawn per call, each of the two routes one call every 10 seconds per key (6 a minute; a call inside the 10 seconds is a 429 with `Retry-After`, never billed). It is the pass a default x402 client can buy as it is: `@x402/fetch` 2.28 refuses any payment over $1 before signing and accepts exactly $1.00 (measured), so the $5 and $20 packs and the $25 bot pass need `spendControls` raised and this one does not. Every other route answers 403 to it, it cannot be topped up, and `GET /api/keys/balance` shows its routes, expiry and hours left. Also in the browser at [/keys](https://x402.ochinimus.app/keys).
- **Balance:** `GET /api/keys/balance` with the header, free.
- **Terms:** a prepaid balance is usage credit, non-refundable, with no expiry (a bot pass is a flat price, non-refundable, valid for 30 days, and the day pass the same for 24 hours); the key is a bearer secret (anyone holding it spends the balance); abuse means revocation. Purchase routes offer the exact accepts only, because credit bought through the half-price batch or Gateway tier would be a free 50%.
- **In the books:** a purchase is a settled payment (status `paid`); the calls it funds are rows of status `key`, consumption of credit already counted, never revenue.

## No wallet? Use Apify Store

Five AgentFeed data sets are also Apify Store actors. The Store bills in fiat through Apify, so no wallet is needed.

| Actor | Returns | Price |
|---|---|---|
| [Crypto Liquidation Heatmap & Map: real Hyperliquid positions](https://apify.com/ochinimus/crypto-liquidation-map-hyperliquid) | Liquidation levels in 5% price bands from the open positions of the largest Hyperliquid accounts | $0.008 per coin |
| [Scholarly Paper Search: OpenAlex, Google Scholar alternative](https://apify.com/ochinimus/scholarly-paper-search) | Papers from OpenAlex's CC0 data, by search or DOI | $0.003 per paper |
| [US Company Filings by Ticker: 10-K, 10-Q, 8-K, Form 4](https://apify.com/ochinimus/us-company-filings) | Recent public filings from the SEC's EDGAR system, per ticker | $0.002 per filing |
| [PDF to Markdown: clean text from any PDF URL](https://apify.com/ochinimus/pdf-to-markdown) | The text of a PDF as markdown, page by page | $0.01 per PDF |
| [AI Data Extractor: web page or PDF to JSON by your schema](https://apify.com/ochinimus/ai-data-extractor) | Structured JSON from a web page or PDF, for the fields you name; a field the page does not state is null | $0.02 per page |

Prices are per result, plus Apify's $0.00005 start fee per run.

## Use AgentFeed in NOFX

[NOFX](https://github.com/NoFxAiOS/nofx) is an open-source AI trading terminal. `get_signal_board` and `get_coin_signal` are shaped for its External Data Sources: `data.coins` is an object keyed by coin in open-interest order, `data.ranked` is the list, `data.sources` names each source, and the board is about 10 KB for 30 coins. **Read this first:** at NOFX commit `ef476f2` nothing calls the function that fetches External Data Sources (`StrategyEngine.FetchExternalData`), so stock NOFX saves the two entries and never reads them into a prompt; they work on a NOFX build that calls it, and the same key works from anything else that sends a header. [docs/nofx.md](docs/nofx.md) ([中文](docs/nofx.zh-CN.md)) has the exact strategy JSON, how to buy a key from the wallet NOFX already pays claw402 with, the cost per trader (about $0.48 a day for the board and $0.19 a day per coin at NOFX's default 15-minute scan) and the proof harness that replays NOFX's fetch and `data_path` walk against the live routes.

## Pay for a call

**Copy `payTo` only from a fresh 402 response, never from transaction history.** On
2026-07-31 a lookalike of the Base treasury (same first and last characters as
`0x22DB…76e6`) sent zero-value address-poisoning transfers to our biggest buyer, so a
wallet's history can show a fake payee next to the real one.

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
| `HELIUS_API_KEY` | — | **required**; builds the primary Solana RPC URL (chain state only, no DAS). If Helius is out of credits or down, calls move to `RPC_FALLBACKS` (below) |
| `HELIUS_RPC` | `https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY` | |
| `SOLANA_RPC_URL` | Helius, from `HELIUS_API_KEY` | the PRIMARY standard-RPC endpoint for every Solana read: on-chain spot, the peg tape, token and wallet routes (`lib/solrpc.js`) |
| `RPC_FALLBACKS` | `https://api.mainnet-beta.solana.com` | comma list of https URLs (empty = none). On HTTP 429, 402, 403, 5xx, a dropped connection or a timeout from the primary the same call goes to the next URL, and the primary is left alone for 10 minutes. No endpoint answering is a 503 (not charged), never a stale or partial paid answer. A devnet or testnet primary gets no fallbacks. One `rpc_usage` line every 10 minutes counts calls per method and host (hosts only, never a key) |
| `JITO_RPC_PRIMARY`, `JITO_RPC_FALLBACKS` | the public mainnet RPC; the primary above | the Jito tip collector (`bin/jito-tips-collect.js`, every 15 minutes) reads from the free public RPC first and uses Helius only as its fallback |
| `X402_MODE` | `on` | `off` serves every route free |
| `X402_NETWORK` | — | **required** when `X402_MODE` is on: `mainnet` in production, `devnet` for tests; boot fails without it |
| `PAY_TO` | — | **required**; Solana treasury that receives USDC |
| `PAY_TO_EVM` | — | EVM treasury for every EVM rail; unset drops every EVM rail from the challenge |
| `X402_EVM_NETWORKS` | unset (all) | comma-separated CAIP-2 ids to narrow the original EVM rails (Base, Polygon, Arbitrum, Arc), e.g. `eip155:8453` for Base only; the R10 networks are narrowed by `X402_EXT_NETWORKS` |
| `X402_EXT_NETWORKS` | unset (all) | comma-separated CAIP-2 ids to narrow the R10 networks (`lib/ext-rails.js`); `X402_EXT=off` removes all of them, `X402_ULTRAVIOLETA=off` and `X402_PAYAI=off` remove one facilitator's rows |
| `FACILITATOR_URL` | — | **required** when `X402_MODE` is on; boot fails without it. Production uses the CDP facilitator, `https://api.cdp.coinbase.com/platform/v2/x402` |
| `MPP_ENABLED` | unset (off) | `true` mounts the `solana/charge` layer |
| `MPP_SECRET_KEY` | — | **required when `MPP_ENABLED=true`; must be 32 characters or longer** — mppx HMAC-binds the challenge id so verification is stateless, and init refuses anything shorter |
| `MPP_NETWORK` | `mainnet` | |
| `MPP_REALM` | `x402.ochinimus.app` | the `realm` in the `WWW-Authenticate` challenge |
| `MPP_RPC_URL` | Helius, from `HELIUS_API_KEY` | |
| `LIQ_DB` | `/opt/agentfeed/liquidations.db` | the liquidation tape (read-only) |
| `PEGWATCH_DB` | `/opt/pegwatch/pegwatch.db` | tokenized-equity peg tape before our cutover, and its reference (read-only) |
| `PEG_ONCHAIN_DB` | `peg-onchain.db` alongside the source | our on-chain peg tape, written by `bin/peg-collect.js` |
| `JITO_TIPS_FILE` | `jito-tips.json` alongside the source | the on-chain Jito tip sample, written by `bin/jito-tips-collect.js` |
| `OVERHANG_DB_PATH` | `/opt/overhang/overhang.db` | collateral exit-liquidity tape (read-only) |
| `CALIPER_DIR` | `/opt/caliper` | forecast model directory |
| `CALIPER_MODEL` | `$CALIPER_DIR/model.json` | |
| `CALIPER_RECORD_DB` | `$CALIPER_DIR/record.db` | |
| `CALIPER_LIQ_DB` | `/opt/agentfeed/liquidations.db` | |
| `TELEGRAPH_LOG` | alongside the source | request-shape log |
| `BYBIT_WS` `BYBIT_API` `BYBIT_MAX_SYMBOLS` | Bybit public, the liquidation tape only (no route reads Bybit market data since R7) | `1000` symbol cap |
| `OKX_WS` `OKX_API` | OKX public, the liquidation tape only (no route reads OKX market data since R6) | |
| `BINANCE_WS` | Binance public, the liquidation tape only (no route reads Binance market data since R6) | |
| `HL_API` | `https://api.hyperliquid.xyz/info` | |
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

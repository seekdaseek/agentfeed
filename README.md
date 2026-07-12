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

## Tools & pricing

### Liquidations

| Tool | Route | Price | Data |
|------|-------|-------|------|
| `get_cascade_scan` | `/api/cascade-scan` | $0.05 | **Full-universe cascade detection** across ~600 USDT perps on 3 venues. Clustered same-side liquidations with symbol, side, USD total, prints, duration, severity. |
| `get_liquidation_leaders` | `/api/liquidation-leaders` | $0.02 | What's blowing up right now: top symbols by liquidation USD, long/short split, biggest print, venue count. |
| `get_cascade_alert` | `/api/cascade` | $0.01 | Cascade detector for the 5 majors (SOL/BTC/ETH/XRP/DOGE). |
| `get_liquidation_stats` | `/api/liquidation-stats` | $0.004 | 1h/24h totals for the majors, long/short split, biggest print, per-exchange breakdown. |
| `get_recent_liquidations` | `/api/liquidations` | $0.003 | Raw liquidation prints. Any USDT perp, filterable by symbol / min USD. |
| `get_last_liquidation` | `/api/last-liquidation` | **free** | Last liquidation per major, 15-min delayed. Taster. |

### Market & positioning

| Tool | Route | Price | Data |
|------|-------|-------|------|
| `get_trade_context` | `/api/trade-context` | $0.01 | Full pre-trade picture in one call: prices, funding, fear/greed, positioning, OI, liquidations. |
| `get_positioning` | `/api/positioning` | $0.004 | SOL+BTC long/short account ratio (retail crowding) + OI with 1h/24h change. |
| `get_market_snapshot` | `/api/market-snapshot` | $0.003 | SOL+BTC prices, funding, fear & greed. |
| `get_funding_rate` | `/api/funding-rate` | $0.002 | SOL+BTC perp funding, mark price, open interest. |
| `get_sol_price` | `/api/sol-price` | $0.001 | Live SOL/USD + confidence (Pyth oracle). |
| `get_btc_price` | `/api/btc-price` | $0.001 | Live BTC/USD + confidence (Pyth oracle). |
| `get_fear_greed` | `/api/fear-greed` | **free** | Crypto Fear & Greed index. |

### Solana on-chain

| Tool | Route | Price | Data |
|------|-------|-------|------|
| `get_token_risk` | `/api/token-risk/:mint` | $0.01 | Rug-risk signals: mint/freeze authority, top-holder concentration, risk flags. Not a honeypot/LP-lock checker. |
| `get_wallet_holdings` | `/api/wallet-holdings/:wallet` | $0.008 | SOL, SPL tokens with USD values, NFT count (Helius DAS). |
| `get_token_metadata` | `/api/token-metadata/:mint` | $0.005 | Name, symbol, decimals, supply, price. |
| `pricing` | `/` | **free** | This table, machine-readable. |

Payments settle as USDC on **Solana mainnet** (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) or **Base** (`eip155:8453`), x402 v2, scheme `exact`.

---

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

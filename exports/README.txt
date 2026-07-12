AGENTFEED Liquidation Dataset — build 20260712
=============================================
Multi-exchange crypto perpetual liquidation ticks.

COVERAGE
- Symbols: SOLUSDT, BTCUSDT (from 2026-07-08); ETHUSDT, XRPUSDT, DOGEUSDT (from 2026-07-10)
- Exchanges: Bybit (complete feed), OKX (sampled by exchange), Binance (sampled: largest print per symbol per 1000ms, from 2026-07-10)
- Rows: 7888 | Range (UTC): 2026-07-08 16:42:32 -> 2026-07-11 23:59:59

SCHEMA (CSV)
ts_ms       epoch milliseconds of liquidation
utc_time    human-readable UTC
symbol      e.g. SOLUSDT
exchange    bybit | okx
event       long_liquidated | short_liquidated
size        position size in coins (OKX converted via contract value)
price       bankruptcy/execution price
usd         size * price, rounded 2dp

HONEST CAVEATS
- OKX and Binance feeds are sampled BY THE EXCHANGE; treat those rows as representative, not exhaustive.
- Bybit rows are the complete public liquidation stream.
- Collector downtime gaps possible; cross-check row continuity for your window.

LICENSE: single-seat, personal or internal commercial use. No redistribution or resale.
Real-time access for AI agents: https://x402.ochinimus.app

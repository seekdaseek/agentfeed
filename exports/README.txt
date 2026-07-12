AGENTFEED Liquidation Dataset — build 20260712
=============================================
Crypto perpetual liquidation ticks: Bybit + OKX + Binance, USDT-margined perps.
Rows: 7888 | Range (UTC): 2026-07-08 16:42:32 -> 2026-07-11 23:59:59

- binance: 5 symbols, 2296 rows
- bybit: 5 symbols, 3962 rows
- okx: 5 symbols, 1630 rows

See coverage_20260712.csv for per-symbol, per-exchange first/last timestamps and row counts.

NOTE: OUR SYMBOL UNIVERSE WIDENED ON 2026-07-12 16:23 UTC — THIS BUILD PREDATES IT
---------------------------------------------------------------
Every row here is from the original 5-symbol era: SOLUSDT, BTCUSDT, ETHUSDT,
XRPUSDT, DOGEUSDT. On 2026-07-12 16:23 UTC the collector widened to ~600 USDT perps across all
three venues.

Later builds will contain BOTH eras. When they do, plotting liquidation counts or volume
across 2026-07-12 16:23 UTC will show a large jump that is OUR ARTIFACT, not a market event.

FEED COMPLETENESS — the venues are NOT equivalent
--------------------------------------------------
- BYBIT   COMPLETE. 'allLiquidation' pushes every liquidation on the exchange (500ms).
          The only complete, unthrottled public liquidation stream among the major perp venues.
- BINANCE UNDERCOUNTS. Liquidation streams are snapshots: max ONE order per symbol per
          1000ms, per Binance's own docs. 'allForceOrders' REST is unmaintained.
- OKX     UNDERCOUNTS. Max one update per second per contract.

The undercount is WORST DURING CASCADES, when many liquidations land in the same second —
i.e. exactly when the data matters most. This is a limit of the exchanges' public feeds, not
of our collection, and it applies to every liquidation dataset on the market. Treat Binance
and OKX rows as a lower bound. Bybit rows are the highest-integrity part of this dataset.

NOT INCLUDED: Hyperliquid. It exposes no public liquidation stream at all — its public
WebSocket carries no liquidation marker, and the data lives only in user-scoped feeds.
Capturing it requires running a node. We don't, so we don't claim it.

SCHEMA (CSV)
------------
ts_ms       epoch milliseconds of the liquidation (exchange event time)
utc_time    human-readable UTC
symbol      normalized USDT perp symbol, e.g. SOLUSDT
exchange    bybit | okx | binance
event       long_liquidated | short_liquidated
size        position size in COINS (OKX converted from contracts via contract value)
price       see PRICE FIELD below
usd         size * price, rounded 2dp

PRICE FIELD — the venues publish different things
--------------------------------------------------
- bybit    'p' from the allLiquidation stream
- okx      'bkPx' — the BANKRUPTCY price
- binance  'ap' — the AVERAGE FILL price (what actually executed)

These are not the same concept. OKX's bankruptcy price is not an execution price. 'usd'
inherits this difference. Be careful with cross-venue price or notional comparisons.

SIDE CONVENTION — three exchanges, three conventions, normalized here
----------------------------------------------------------------------
- bybit    'S' is already the POSITION side. Passed through.
- binance  'S' is the ORDER side — a SELL order is what closes a long. FLIPPED.
- okx      'posSide' is explicit. Mapped.
In this file: long_liquidated = a LONG position was force-closed. short_liquidated = a SHORT was.
Get this backwards and every long/short ratio you compute is inverted for some venues.

KNOWN GAPS
----------
- Collector downtime is NOT backfillable for Bybit or Binance — neither publishes an archive.
  Binance DELETED their historical liquidationSnapshot (verified 2026-07-12; the directory on
  data.binance.vision is empty). Bybit never published one. OKX offers 7 rolling days.
  There is no public historical liquidation data for any major venue, at any price.
- Some symbols list on only one or two of the three venues. A low venue count is usually
  correct, not a gap. Check coverage_20260712.csv.
- Inverse (coin-margined) contracts are excluded: their contract value is denominated in USD,
  so including them would mix USD figures into the coin-quantity column.

LICENSE: free to use, including commercially. Redistribution permitted. Attribution required. No warranty.
Real-time access for AI agents (full-universe cascade detection, ~600 perps):
  https://x402.ochinimus.app   ·   MCP: https://x402.ochinimus.app/mcp

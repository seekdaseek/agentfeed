#!/bin/bash
# AGENTFEED dataset export — nightly build.
#
# v2: everything factual is QUERIED FROM THE DB. The old version hardcoded the symbol list
# and the exchange list into the README, so they silently went stale the moment the collector
# changed. Coverage now cannot drift from reality.
set -e
cd /opt/agentfeed/exports

DB=/opt/agentfeed/liquidations.db
CUTOFF=$(date -u -d "today 00:00" +%s)000
STAMP=$(date -u +%Y%m%d)

# The collector universe widened from 5 symbols to ~600 at this instant. Anyone plotting
# volume across it sees a cliff that is OUR ARTIFACT, not a market event. Must be disclosed.
UCHANGE_MS=$(date -u -d "2026-07-12 16:23:00" +%s)000
UCHANGE_TXT="2026-07-12 16:23 UTC"

q() { sqlite3 "$DB" "$1"; }

# ---- data
sqlite3 -header -csv "$DB" "
  SELECT ts AS ts_ms, datetime(ts/1000,'unixepoch') AS utc_time, symbol, exchange,
         CASE side WHEN 'Buy' THEN 'long_liquidated' ELSE 'short_liquidated' END AS event,
         size, price, ROUND(usd,2) AS usd
  FROM liquidations WHERE ts < $CUTOFF ORDER BY ts;" > liquidations_full_$STAMP.csv

sqlite3 -header -csv "$DB" "
  SELECT ts AS ts_ms, datetime(ts/1000,'unixepoch') AS utc_time, symbol, exchange,
         CASE side WHEN 'Buy' THEN 'long_liquidated' ELSE 'short_liquidated' END AS event,
         size, price, ROUND(usd,2) AS usd
  FROM liquidations WHERE ts >= $CUTOFF-43200000 AND ts < $CUTOFF ORDER BY ts;" > sample_12h_$STAMP.csv

# ---- machine-readable coverage: every symbol x exchange, first seen, last seen, rows
sqlite3 -header -csv "$DB" "
  SELECT symbol, exchange, COUNT(*) AS rows,
         datetime(MIN(ts)/1000,'unixepoch') AS first_utc,
         datetime(MAX(ts)/1000,'unixepoch') AS last_utc,
         ROUND(SUM(usd),2) AS total_usd
  FROM liquidations WHERE ts < $CUTOFF
  GROUP BY symbol, exchange ORDER BY total_usd DESC;" > coverage_$STAMP.csv

# ---- facts, from the DB
ROWS=$(q "SELECT COUNT(*) FROM liquidations WHERE ts < $CUTOFF;")
RANGE=$(q "SELECT datetime(MIN(ts)/1000,'unixepoch')||' -> '||datetime(MAX(ts)/1000,'unixepoch') FROM liquidations WHERE ts < $CUTOFF;")
SYM_BEFORE=$(q "SELECT COUNT(DISTINCT symbol) FROM liquidations WHERE ts < $UCHANGE_MS;")
SYM_AFTER=$(q "SELECT COUNT(DISTINCT symbol) FROM liquidations WHERE ts >= $UCHANGE_MS AND ts < $CUTOFF;")
BY_EX=$(q "SELECT '- '||exchange||': '||COUNT(DISTINCT symbol)||' symbols, '||COUNT(*)||' rows' FROM liquidations WHERE ts < $CUTOFF GROUP BY exchange;")

if [ "$SYM_AFTER" -eq 0 ]; then
UNIVERSE_BLOCK="NOTE: OUR SYMBOL UNIVERSE WIDENED ON $UCHANGE_TXT — THIS BUILD PREDATES IT
---------------------------------------------------------------
Every row here is from the original $SYM_BEFORE-symbol era: SOLUSDT, BTCUSDT, ETHUSDT,
XRPUSDT, DOGEUSDT. On $UCHANGE_TXT the collector widened to ~600 USDT perps across all
three venues.

Later builds will contain BOTH eras. When they do, plotting liquidation counts or volume
across $UCHANGE_TXT will show a large jump that is OUR ARTIFACT, not a market event."
else
UNIVERSE_BLOCK="!! READ THIS FIRST: THE SYMBOL UNIVERSE CHANGED ON $UCHANGE_TXT
---------------------------------------------------------------
Before that instant this build holds $SYM_BEFORE symbols. After it, $SYM_AFTER.

IF YOU PLOT LIQUIDATION COUNTS OR VOLUME ACROSS THAT TIMESTAMP YOU WILL SEE A LARGE JUMP.
IT IS AN ARTIFACT OF OUR COLLECTOR WIDENING, NOT A MARKET EVENT.

For a continuous series: either filter to SOLUSDT/BTCUSDT/ETHUSDT/XRPUSDT/DOGEUSDT, or start
your series after $UCHANGE_TXT."
fi

cat > README.txt << RDME
AGENTFEED Liquidation Dataset — build $STAMP
=============================================
Crypto perpetual liquidation ticks: Bybit + OKX + Binance, USDT-margined perps.
Rows: $ROWS | Range (UTC): $RANGE

$BY_EX

See coverage_$STAMP.csv for per-symbol, per-exchange first/last timestamps and row counts.

$UNIVERSE_BLOCK

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
  correct, not a gap. Check coverage_$STAMP.csv.
- Inverse (coin-margined) contracts are excluded: their contract value is denominated in USD,
  so including them would mix USD figures into the coin-quantity column.

LICENSE: free to use, including commercially. Redistribution permitted. Attribution required. No warranty.
Real-time access for AI agents (full-universe cascade detection, ~600 perps):
  https://x402.ochinimus.app   ·   MCP: https://x402.ochinimus.app/mcp
RDME

zip -q agentfeed-liq-dataset_$STAMP.zip liquidations_full_$STAMP.csv coverage_$STAMP.csv README.txt
zip -q agentfeed-liq-SAMPLE_$STAMP.zip sample_12h_$STAMP.csv coverage_$STAMP.csv README.txt
rm liquidations_full_$STAMP.csv sample_12h_$STAMP.csv coverage_$STAMP.csv

ls -t agentfeed-liq-dataset_*.zip | tail -n +8 | xargs -r rm   # keep 7 builds
ls -t agentfeed-liq-SAMPLE_*.zip  | tail -n +8 | xargs -r rm
echo "$(date -u) export ok: $ROWS rows, $SYM_AFTER symbols post-change -> agentfeed-liq-dataset_$STAMP.zip"

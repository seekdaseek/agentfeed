#!/bin/bash
# AGENTFEED dataset export — nightly product build (liq ticks -> CSV bundle)
set -e
cd /opt/agentfeed/exports
CUTOFF=$(date -u -d "today 00:00" +%s)000   # everything before today UTC midnight
STAMP=$(date -u +%Y%m%d)

sqlite3 -header -csv /opt/agentfeed/liquidations.db "
  SELECT ts AS ts_ms, datetime(ts/1000,'unixepoch') AS utc_time, symbol, exchange,
         CASE side WHEN 'Buy' THEN 'long_liquidated' ELSE 'short_liquidated' END AS event,
         size, price, ROUND(usd,2) AS usd
  FROM liquidations WHERE ts < $CUTOFF ORDER BY ts;" > liquidations_full_$STAMP.csv

sqlite3 -header -csv /opt/agentfeed/liquidations.db "
  SELECT ts AS ts_ms, datetime(ts/1000,'unixepoch') AS utc_time, symbol, exchange,
         CASE side WHEN 'Buy' THEN 'long_liquidated' ELSE 'short_liquidated' END AS event,
         size, price, ROUND(usd,2) AS usd
  FROM liquidations WHERE ts >= $CUTOFF-43200000 AND ts < $CUTOFF ORDER BY ts;" > sample_12h_$STAMP.csv

ROWS=$(( $(wc -l < liquidations_full_$STAMP.csv) - 1 ))
RANGE=$(sqlite3 /opt/agentfeed/liquidations.db "SELECT datetime(MIN(ts)/1000,'unixepoch')||' -> '||datetime(MAX(ts)/1000,'unixepoch') FROM liquidations WHERE ts < $CUTOFF;")
cat > README.txt << RDME
AGENTFEED Liquidation Dataset — build $STAMP
=============================================
Multi-exchange crypto perpetual liquidation ticks.

COVERAGE
- Symbols: SOLUSDT, BTCUSDT (from 2026-07-08); ETHUSDT, XRPUSDT, DOGEUSDT (from 2026-07-10)
- Exchanges: Bybit (complete feed), OKX (sampled by exchange), Binance (sampled: largest print per symbol per 1000ms, from 2026-07-10)
- Rows: $ROWS | Range (UTC): $RANGE

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
RDME

zip -q agentfeed-liq-dataset_$STAMP.zip liquidations_full_$STAMP.csv README.txt
zip -q agentfeed-liq-SAMPLE_$STAMP.zip sample_12h_$STAMP.csv README.txt
rm liquidations_full_$STAMP.csv sample_12h_$STAMP.csv
ls -t agentfeed-liq-dataset_*.zip | tail -n +8 | xargs -r rm   # keep 7 builds
ls -t agentfeed-liq-SAMPLE_*.zip | tail -n +8 | xargs -r rm
echo "$(date -u) export ok: $ROWS rows -> agentfeed-liq-dataset_$STAMP.zip"

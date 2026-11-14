#!/bin/bash
# Alerts to Telegram when a collector stops WRITING. Freshness, not process state:
# linewatch sat "online" for 12 days while refreshFixtures threw every cycle.
set -u
TG_BOT_TOKEN=$(grep -m1 '^TG_BOT_TOKEN=' /opt/liqbot/.env | cut -d= -f2-)
TG_CHANNEL=$(grep -m1 '^TG_CHAT_ID=' /opt/solwatch-trigger/.env | cut -d= -f2-)
NOW=$(date +%s); ALERTS=""
# INFO is printed to this script's own log every run and never sent: measurements worth seeing while
# healthy (writes left, runway, "rate unmeasured") that must not move the alert signature.
INFO=""
STATE=/var/lib/watchdog-state
mkdir -p "$STATE" 2>/dev/null || true
# Every curl probe of a PUBLIC URL retries: one tunnel or edge blip must not page. -m stays per attempt
# (measured: -m 2 with two retries took 8 s against a blackhole), so a dead host costs 3x the timeout plus
# 10 s of delays. A transient HTTP 5xx is retried too. Probes that read a body write it to a file: without
# -o, curl appends every failed attempt's error page to stdout ahead of the good one (measured, 1,609 bytes
# of 503 page in front of a 9-byte answer), so a recovered blip would still fail to parse. -o FILE is
# truncated before each retry (measured). -D FILE is NOT: it keeps every attempt's headers (measured, 3
# status blocks after 2 retries), so a header probe must read only the LAST block - see lasthdr().
RETRY=(--retry 2 --retry-delay 5 --retry-connrefused)
# Count of header $2 in the final response of a -D dump $1 (the count resets at every status line).
lasthdr() { awk -v h="$2" 'BEGIN{h=tolower(h)} /^HTTP\//{c=0} index(tolower($0), h":")==1{c++} END{print c+0}' "$1" 2>/dev/null || echo 0; }
# --- R6 helpers begin (13 Oct 2026). Unit-tested by sourcing exactly this block (AF-R6-report W2f). ---
# method="..." values of the WWW-Authenticate challenges in the LAST response of a -D dump $1, one per line.
# lasthdr()'s rule applies: a retried curl keeps every attempt's headers, so the list restarts at each status line.
lastmethods() {
  awk '/^HTTP\//{n=0} tolower($0) ~ /^www-authenticate:/{s=$0; while (match(s, /[ ,]method="[a-z0-9_-]+"/)) {n++; m[n]=substr(s, RSTART+9, RLENGTH-10); s=substr(s, RSTART+RLENGTH)}} END{for(i=1;i<=n;i++) print m[i]}' "$1" 2>/dev/null
}
# MPP verdict for one route from a -D dump. $1 route, $2 dump file, $3 gated|ungated. It asserts WHICH methods the
# challenge offers, not how many lines it has: mpp/tempo.js appends one tempo challenge per token (OUSD, USDC.e), so a
# gated route carries solana + tempo + tempo and an ungated one tempo + tempo. A line count of exactly 1 cannot hold.
#   gated:   >=1 method="solana" AND >=1 method="tempo"
#   ungated: 0 solana (the gate was not widened beyond what PAY.md declares) AND >=1 tempo
mppverdict() {
  local r=$1 f=$2 kind=$3 ns nt has
  if ! grep -q '^HTTP/' "$f" 2>/dev/null; then ALERTS="${ALERTS} | agentfeed MPP: ${r} gave no response"; return 0; fi
  ns=$(lastmethods "$f" | grep -c '^solana$'); nt=$(lastmethods "$f" | grep -c '^tempo$')
  has=$(lastmethods "$f" | tr '\n' ' ' | sed 's/ $//'); has=${has:-none}
  if [ "$kind" = gated ]; then
    [ "$ns" -lt 1 ] && ALERTS="${ALERTS} | agentfeed MPP: ${r} is missing method=\"solana\" (challenge methods: ${has})"
  else
    [ "$ns" -gt 0 ] && ALERTS="${ALERTS} | agentfeed MPP: ${r} has an extra method=\"solana\" (gate widened beyond what PAY.md declares; challenge methods: ${has})"
  fi
  [ "$nt" -lt 1 ] && ALERTS="${ALERTS} | agentfeed MPP: ${r} is missing method=\"tempo\" (challenge methods: ${has})"
  return 0
}
# Freshness of one snapshot file a paid route serves, by mtime. $1 path, $2 name, $3 limit in seconds.
# chk() returns silently when its input is missing; for these routes a missing file IS the outage, so it is reported.
fchk() {
  local f=$1 name=$2 lim=$3 mt age
  mt=$(stat -c %Y "$f" 2>/dev/null)
  case "$mt" in ''|*[!0-9]*) ALERTS="${ALERTS} | agentfeed ${name}: snapshot ${f} missing or unreadable"; return 0 ;; esac
  age=$(( NOW - mt ))
  [ "$age" -gt "$lim" ] && ALERTS="${ALERTS} | agentfeed ${name}: snapshot stale ${age}s (limit ${lim}s)"
  return 0
}
# Same, for a sqlite table whose newest row is the freshness mark. $1 db, $2 table, $3 name, $4 limit in seconds (ts = epoch s).
afdbchk() {
  local db=$1 t=$2 name=$3 lim=$4 mx age
  mx=$(sqlite3 -readonly -cmd '.timeout 3000' "$db" "SELECT COALESCE(MAX(ts),0) FROM $t;" 2>/dev/null)
  case "$mx" in ''|*[!0-9]*) ALERTS="${ALERTS} | agentfeed ${name}: newest-row time UNMEASURED (cannot read ${db})"; return 0 ;; esac
  if [ "$mx" = 0 ]; then ALERTS="${ALERTS} | agentfeed ${name}: ${t} has no rows"; return 0; fi
  age=$(( NOW - mx ))
  [ "$age" -gt "$lim" ] && ALERTS="${ALERTS} | agentfeed ${name}: newest row ${age}s old (limit ${lim}s)"
  return 0
}
# Batch-settlement (ops/batch-claim.js, root cron every 30 min: claim the vouchers, then settle what was claimed). Four signals,
# all read off the code and the job's own record (batch-claim-state.json `networks`, lib/batch-claim-core.js):
#  1. batch-claim-state.json is rewritten at the end of every COMPLETED run, failed claims included. batch-claim.log is
#     empty whenever nothing is claimable, so the state file's mtime is the only liveness mark. Limit 2h = 4 missed slots.
#  2. UNCLAIMED: batch_channels in agentfeed.db: a channel is owed money while chargedCumulativeAmount > totalClaimed. withdrawDelay
#     is 24h; after it a payer can withdraw what was never claimed. The value counts as held since the row was last
#     written, or since totalClaimed last moved (remembered in $STATE/batch-unclaimed) for a channel that keeps being
#     charged while its claims fail. Alert past 6h, unless that channel's unclaimed value is at or below the largest amount the CDP
#     facilitator has refused to claim for ONE channel (claim_refused_atomic; the job records it only from single-channel claims,
#     never from a refused batch): a refusal is not a fault, and the loss it allows is at most that amount per channel.
#  3. UNSETTLED: claimed but not yet swept to the receiver (the job reads it off the chain). unsettled_atomic above the largest
#     settle the facilitator has refused (settle_refused_atomic) for over 6h (unsettled_since) means the settle is failing for a
#     reason other than a minimum. A claimed bucket is the receiver's and a payer cannot withdraw it: a delay, not a loss.
#  4. WITHDRAWAL: at_risk_count > 0 -- the job found a payer's timed withdrawal pending on-chain for a channel that still holds
#     unclaimed value. Alert at once when that value is above the refused amount: the 24h delay is already running.
bcheck() {
  local st=${BC_STATE_FILE:-/opt/agentfeed/batch-claim-state.json} db=${BC_DB:-/opt/agentfeed/agentfeed.db}
  local run_max=${BATCH_CLAIM_RUN_MAX_S:-7200} hold_max=${BATCH_UNCLAIMED_MAX_S:-21600}
  local sf="$STATE/batch-unclaimed" mt tbl rows nets k ch cl up since held n=0 oldest=0 owed=0
  local net crf srf usa uss ars aro ari
  local -A bcc bcs ncrf
  local ow
  mt=$(stat -c %Y "$st" 2>/dev/null)
  case "$mt" in
    ''|*[!0-9]*) ALERTS="${ALERTS} | agentfeed batch-claim: no completed run on record (${st} missing; batch-settlement off or the cron gone?)" ;;
    *) [ $(( NOW - mt )) -gt "$run_max" ] && ALERTS="${ALERTS} | agentfeed batch-claim: no run has completed in $(( (NOW - mt) / 60 ))min (limit $(( run_max / 60 ))min, cron every 30min)" ;;
  esac
  # the job's per-network record: network|claim refused|settle refused|unsettled|unsettled since (epoch s)|at-risk channels|at-risk owed|at-risk since
  nets=$(sqlite3 -separator '|' :memory: "SELECT j.key, COALESCE(json_extract(j.value,'\$.claim_refused_atomic'),0), COALESCE(json_extract(j.value,'\$.settle_refused_atomic'),0), COALESCE(json_extract(j.value,'\$.unsettled_atomic'),0), COALESCE(CAST(strftime('%s', json_extract(j.value,'\$.unsettled_since')) AS INTEGER),0), COALESCE(json_extract(j.value,'\$.at_risk_count'),0), COALESCE(json_extract(j.value,'\$.at_risk_owed_atomic'),0), COALESCE(json_extract(j.value,'\$.at_risk_initiated_at'),0) FROM json_each(json_extract(CAST(readfile('$st') AS TEXT),'\$.networks')) j;" 2>/dev/null) || nets=""
  while IFS='|' read -r net crf srf usa uss ars aro ari; do
    [ -z "$net" ] && continue
    case "$crf$srf$usa$uss$ars$aro$ari" in *[!0-9]*) continue ;; esac
    ncrf[$net]=$crf
    if [ "$usa" -gt "$srf" ] && [ "$uss" -gt 0 ] && [ $(( NOW - uss )) -gt "$hold_max" ]; then
      ALERTS="${ALERTS} | agentfeed batch-settle: $(awk -v m="$usa" 'BEGIN{printf "%.4f", m/1e6}') USDC claimed on ${net} has not been settled to the receiver for over $(( (NOW - uss) / 3600 ))h (the facilitator's largest refusal as below its minimum was $(awk -v m="$srf" 'BEGIN{printf "%.4f", m/1e6}') USDC, so this is something else; a claimed bucket is the receiver's, a payer cannot withdraw it)"
    fi
    if [ "$ars" -gt 0 ] && [ "$aro" -gt "$crf" ]; then
      ALERTS="${ALERTS} | agentfeed batch-claim: ${ars} channel(s) on ${net} have a payer withdrawal pending while holding $(awk -v m="$aro" 'BEGIN{printf "%.4f", m/1e6}') USDC unclaimed (withdrawDelay started $(( (NOW - ari) / 3600 ))h ago; claim before it ends)"
    fi
  done <<< "$nets"
  tbl=$(sqlite3 -readonly -cmd '.timeout 3000' "$db" "SELECT name FROM sqlite_master WHERE type='table' AND name='batch_channels';" 2>/dev/null) || tbl=ERR
  if [ "$tbl" = ERR ]; then ALERTS="${ALERTS} | agentfeed batch-claim: unclaimed value UNMEASURED (cannot read ${db})"; return 0; fi
  [ -z "$tbl" ] && return 0
  rows=$(sqlite3 -readonly -cmd '.timeout 3000' -separator '|' "$db" "SELECT network||':'||channel_id, json_extract(data,'\$.chargedCumulativeAmount'), json_extract(data,'\$.totalClaimed'), updated_at FROM batch_channels WHERE CAST(json_extract(data,'\$.chargedCumulativeAmount') AS INTEGER) > CAST(json_extract(data,'\$.totalClaimed') AS INTEGER);" 2>/dev/null) \
    || { ALERTS="${ALERTS} | agentfeed batch-claim: unclaimed value UNMEASURED (query on ${db} failed)"; return 0; }
  if [ -f "$sf" ]; then
    while IFS='|' read -r k cl since; do if [ -n "$k" ]; then bcc[$k]=$cl; bcs[$k]=$since; fi; done < "$sf"
  fi
  : > "$sf.new"
  while IFS='|' read -r k ch cl up; do
    [ -z "$k" ] && continue
    case "$up" in ''|*[!0-9]*) up=$(( NOW * 1000 )) ;; esac
    if [ -n "${bcs[$k]:-}" ] && [ "${bcc[$k]:-}" = "$cl" ]; then since=${bcs[$k]}; else since=$(( up / 1000 )); fi
    printf '%s|%s|%s\n' "$k" "$cl" "$since" >> "$sf.new"
    held=$(( NOW - since ))
    ow=0; case "$ch$cl" in *[!0-9]*) ;; *) ow=$(( ch - cl )) ;; esac
    if [ "$held" -gt "$hold_max" ] && [ "$ow" -gt "${ncrf[${k%:*}]:-0}" ]; then
      n=$(( n + 1 )); [ "$held" -gt "$oldest" ] && oldest=$held
      case "$ch$cl" in *[!0-9]*) ;; *) owed=$(( owed + ch - cl )) ;; esac
    fi
  done <<< "$rows"
  mv "$sf.new" "$sf"
  if [ "$n" -gt 0 ]; then
    ALERTS="${ALERTS} | agentfeed batch-claim: ${n} channel(s) hold unclaimed value for over $(( hold_max / 3600 ))h (oldest $(( oldest / 3600 ))h, about $(awk -v m="$owed" 'BEGIN{printf "%.4f", m/1e6}') USDC; a payer can withdraw what is unclaimed after the 24h withdrawDelay)"
  fi
  return 0
}
# --- R6 helpers end ---
# pm2 state of one process as "status SEND" ("missing -" when absent, empty when pm2 cannot be read).
# pm2 jlist carries every process's env, secrets included, so the parse prints two fields and nothing else.
pm2st() {
  pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    print(''); sys.exit(0)
m=[p for p in d if p.get('name')==sys.argv[1]]
if not m:
    print('missing -'); sys.exit(0)
e=m[0].get('pm2_env') or {}
s=(e.get('env') or {}).get('SEND', e.get('SEND'))
print('%s %s' % (e.get('status') or '?', s if s not in (None, '') else '-'))
" "$1" 2>/dev/null || echo ""
}
chk() {
  local db=$1 t=$2 u=$3 lim=$4 name=$5 mx age
  [ -f "$db" ] || return 0
  mx=$(sqlite3 "$db" "SELECT COALESCE(MAX(ts),0) FROM $t;" 2>/dev/null) || return 0
  [ -z "$mx" ] || [ "$mx" = 0 ] && return 0
  [ "$u" = ms ] && mx=$((mx/1000))
  age=$(( (NOW - mx) / 60 ))
  [ "$age" -gt "$lim" ] && ALERTS="${ALERTS} | ${name}: stale ${age}min (limit ${lim})"
  return 0
}
chk /opt/agentfeed/liquidations.db liquidations ms 30 liquidations
# linewatch only matters when a fixture is actually near: no matches = no odds,
# and alerting through a 2-month off-season trains you to ignore the watchdog.
# It also only matters while the collector is MEANT to run. linewatch (and sharpbot) were stopped on
# purpose on 2026-08-19 when TxODDS started answering 403, but fixtures still holds Friendlies rows inside
# the window (Oct 3-7, Nov 12/15), so a deliberately stopped collector paged "stale" every cycle. The check
# runs only while pm2 reports linewatch online; stopped, missing or unreadable pm2 = silent here (the
# lictor block below already reports an unreadable pm2).
LW_ST=$(pm2st linewatch | cut -d' ' -f1)
if [ "$LW_ST" = online ]; then
  UPC=$(sqlite3 /opt/linewatch/linewatch.db "SELECT COUNT(*) FROM fixtures WHERE start_ts/1000 BETWEEN strftime('%s','now')-10800 AND strftime('%s','now')+172800;" 2>/dev/null || echo 0)
  [ "${UPC:-0}" -gt 0 ] && chk /opt/linewatch/linewatch.db odds ms 360 linewatch
fi
chk /opt/pegwatch/pegwatch.db ticks sec 30 pegwatch
chk /opt/launchledger/launchledger.db checks sec 120 launchledger
chk /opt/rwayield/rwayield.db snapshots sec 720 rwayield
chk /opt/markgap/markgap.db sweeps sec 20 markgap
chk /opt/overhang/overhang.db sweeps sec 45 overhang
# agentfeed-algo is not a collector: it writes only when somebody pays, so a
# stale ledger means no customers, not a fault. What matters is that the paywall
# still answers. 402 proves the route is up AND the facilitator handshake works.
# 503 = payment rail down, 000 = service down, anything else = broken.
CODE=$(curl -s -o /dev/null -m 10 "${RETRY[@]}" -w '%{http_code}' "https://algo.ochinimus.app/v1/liquidations/window?symbol=SOL&hours=24" || true); CODE=${CODE:-000}
[ "$CODE" != 402 ] && ALERTS="${ALERTS} | agentfeed-algo: paid route returned ${CODE}, expected 402"

# The /telegraph mirror was removed on 2026-09-19. Track 3 ran Aug 31 - Sep 7
# and is long over, so the registration that justified an unmetered mirror of the
# whole paid catalogue no longer exists.
#
# Three probes replace what two used to assert, split apart because no single URL
# carries all of it any more:
#
#   /health          the process is up and answering through the tunnel and the
#                    Cloudflare edge. This is what /telegraph/ping proved, minus
#                    the mount assertion -- which is gone on purpose.
#   /api/liquidation-stats  402, NOT 200. The paywall is in-process, so a paid route
#                    answers 402 even from localhost. That 402 still proves the
#                    route is MOUNTED and the x402 layer fronts it; a 200 here
#                    would mean the paywall vanished and paid data is being given
#                    away. What it can no longer prove is that the handler runs,
#                    because the 402 returns before the handler is reached.
#                    This probe was /api/tvl until 2026-10-12. tvl was withdrawn
#                    on purpose (lib/compat.js WITHDRAWN, it answers 410), so it
#                    paged every cycle and counted as downtime in bazaarwatch.
#                    liquidation-stats is live, paid and earning.
#   /api/fear-greed  200 carrying a number. This is the replacement for "tvl
#                    proves the handlers and the upstream still work". It is
#                    absent from PRICES in payments.js so it is genuinely
#                    unpaywalled, and it calls a third-party upstream
#                    (alternative.me), so a numeric value proves a handler ran
#                    end to end against a live upstream.
#
# 000 = host down, on all three.
HLT=$(curl -s -o /dev/null -m 10 "${RETRY[@]}" -w '%{http_code}' "https://x402.ochinimus.app/health" || true); HLT=${HLT:-000}
[ "$HLT" != 200 ] && ALERTS="${ALERTS} | agentfeed: /health returned ${HLT}, expected 200"
LSTC=$(curl -s -o /dev/null -m 15 "${RETRY[@]}" -w '%{http_code}' "https://x402.ochinimus.app/api/liquidation-stats" || true); LSTC=${LSTC:-000}
[ "$LSTC" != 402 ] && ALERTS="${ALERTS} | agentfeed: PAID /api/liquidation-stats returned ${LSTC}, expected 402"
FGT=$(mktemp)
curl -s -m 15 "${RETRY[@]}" -o "$FGT" "https://x402.ochinimus.app/api/fear-greed" 2>/dev/null || true
FGV=$(python3 -c "import sys,json;d=json.load(open(sys.argv[1])).get('data',{});v=d.get('value');print(v if isinstance(v,(int,float)) else '')" "$FGT" 2>/dev/null || echo "")
rm -f "$FGT"
[ -z "$FGV" ] && ALERTS="${ALERTS} | agentfeed: free /api/fear-greed carries no numeric value (handler or upstream down)"

# PRICE UPSTREAM. On 2026-08-27 hermes.pyth.network started answering 401 to
# unauthenticated callers. It was the only source behind getPrice(), so the PAID
# /api/sol-price and /api/btc-price, market-snapshot, trade-context and the MCP
# price tools all returned 502 - and nothing announced it. prices.js is now
# multi-source (coinbase -> kraken -> pyth), which means the NEW silent failure
# is every source being down at once, and that is what these probes catch.
#
# WHY THE PROBE IS A DIRECT CALL AND NOT AN HTTP REQUEST. The paid route answers
# 402 to an unpaid caller, so a 402 proves only that the paywall is up - it
# cannot see past it to whether the price upstream works.
#
# The mirror did NOT cover that gap either, which is worth stating because the
# comment here used to claim it did. telegraph.js:254-255 called getPriceQuotes,
# while the paid route (server.js:197-198) calls getPrice. They are different
# functions: getPrice is an ordered 3-source failover (coinbase -> kraken ->
# pyth) that throws when all three are down; getPriceQuotes fans out over 8
# venues and succeeds if ANY one answers. Six of those venues are not in
# getPrice's list at all. So a green mirror probe never did prove the paid route
# would serve - with coinbase, kraken and pyth all down and coingecko up, the
# old probe stayed green while paid /api/sol-price returned 502. That blind spot
# existed from the Aug-30 quotes rewrite until this change closed it.
#
# With the mirror gone, NO unpaywalled HTTP route reaches getPrice() any more --
# checked, not assumed: every getPrice call site in server.js is /api/sol-price,
# /api/btc-price or /api/market-snapshot, and all three are priced in
# payments.js. So the probe calls getPrice() directly on the box instead. That
# drops the HTTP layer out of this particular test, which the paid-route 402
# check below already covers, and keeps the part that actually matters: does the
# multi-source fetcher still return a number.
#
# console.log is silenced inside the call because prices.js prints
# "[prices] SOL served by coinbase at ..." to STDOUT, which would otherwise sit
# in front of the JSON and break the parse below.
#
# RETURNING IS NOT ENOUGH. getPrice() can resolve carrying a null or zero price
# rather than rejecting, so the probe reads the payload and checks the number.
# getPrice returns {symbol, price, confidence, publish_time, source:'coinbase'};
# the mirror's getPriceQuotes returned a different object (a quotes[] array and
# source:'multi:a+b+c'). Both carry `price` and `source`, which is all the parse
# below reads, so it works unchanged - but it is NOT the same object, and a
# future edit must not assume it is.
pxchk() {
  local sym=$1 body px src
  # Probe shape: cd into the deployed service,
  # timeout, node -e, empty output on any failure. console.log is silenced
  # because prices.js writes "[prices] SOL served by coinbase at ..." to STDOUT
  # -- measured -- and it would otherwise sit in front of the JSON.
  # Measured cost: ~250ms, one node process per symbol, one upstream call.
  # --env-file=.env is required since R5 C1 (2026-10-12): tools/dexspot.js reads the SOL pools over Solana RPC with
  # the Helius key from env, and `node -e` does not load .env (only server.js does, via dotenv). Without it SOL
  # fails with http 401 on both pools and this probe paged a false "returned nothing" while production priced fine.
  # BTC and ETH read public EVM RPCs, which is why only SOL failed.
  body=$(cd /opt/agentfeed && timeout 20 node --env-file=.env -e '
console.log=()=>{};
const {getPrice}=require("./tools/prices");
getPrice(process.argv[1].toUpperCase())
  .then(r=>process.stdout.write(JSON.stringify(r)))
  .catch(()=>process.exit(1));
' "$sym" 2>/dev/null || echo "")
  if [ -z "$body" ]; then
    ALERTS="${ALERTS} | agentfeed price: getPrice(${sym}) returned nothing (threw, timed out, or module unloadable)"
    return 0
  fi
  px=$(printf '%s' "$body" | python3 -c "import sys,json;d=json.load(sys.stdin);p=d.get('price');print(p if isinstance(p,(int,float)) else '')" 2>/dev/null || echo "")
  src=$(printf '%s' "$body" | python3 -c "import sys,json;print(json.load(sys.stdin).get('source',''))" 2>/dev/null || echo "")
  if [ -z "$px" ]; then
    ALERTS="${ALERTS} | agentfeed price: getPrice(${sym}) returned but carries no numeric price (all sources down?)"
    return 0
  fi
  awk -v v="$px" 'BEGIN{exit !(v>0)}' || ALERTS="${ALERTS} | agentfeed price: ${sym} price is ${px}, expected above zero (source ${src})"
  return 0
}
pxchk sol
pxchk btc

# trade-context is the flagship paid route. It used to be probed through the
# mirror for a 200, because a REGISTERED Telegraph route that cannot answer is
# what costs the miner its registration. That reason died with the mirror, and
# its second job -- being a canary for getPrice() -- is now done more directly by
# the call above.
#
# What is still worth asserting is that the flagship route is MOUNTED and GATED,
# so it is probed for 402. Dropping it entirely would leave the most valuable
# route in the catalogue with no signal at all.
TGC=$(curl -s -o /dev/null -m 20 "${RETRY[@]}" -w '%{http_code}' "https://x402.ochinimus.app/api/trade-context?symbol=SOL" || true); TGC=${TGC:-000}
[ "$TGC" != 402 ] && ALERTS="${ALERTS} | agentfeed: PAID /api/trade-context returned ${TGC}, expected 402"

# The paywall itself. 402 proves the x402 layer still fronts the paid surface;
# 200 would mean the paywall vanished and paid data is being given away.
PXP=$(curl -s -o /dev/null -m 10 "${RETRY[@]}" -w '%{http_code}' "https://x402.ochinimus.app/api/sol-price" || true); PXP=${PXP:-000}
[ "$PXP" != 402 ] && ALERTS="${ALERTS} | agentfeed: PAID /api/sol-price returned ${PXP}, expected 402"

# MPP solana/charge, live since 2026-09-19 on sol-price and btc-price only.
#
# WHY THIS IS CHECKED AT ALL. The layer is deliberately FAIL-SOFT: any init
# failure logs "[mpp] DISABLED" and the service keeps serving x402 on every
# route, exit code 0, pm2 still `online`. That is the right trade for revenue,
# but it means MPP can vanish with no crash, no restart and no symptom that any
# other probe here would see. A missing MPP_SECRET_KEY, an unpatched
# @solana/mpp, an .env that lost a line -- all of them look perfectly healthy
# from outside. This is the only probe that would notice.
#
# BOTH DIRECTIONS MATTER. Present-on-gated catches a silent disable. Absent-on-
# ungated catches the opposite mistake: a gate accidentally widened to a route
# the published PAY.md does not declare, which would make the registry entry
# false the moment it shipped.
#
# R6 (2026-10-12): THE ASSERTION IS ON METHODS, NOT ON A LINE COUNT. This used to demand exactly ONE WWW-Authenticate
# line. Since R5 mpp/tempo.js gate() appends one tempo challenge per token (OUSD, USDC.e) after the solana one on every
# paid route, so the gated routes carry solana + tempo + tempo and the check paged forever. The "ungated" route moved
# from /api/tvl (withdrawn, answers 410, so it carried no challenge for the wrong reason) to /api/liquidation-stats:
# paid, live, tempo-only, no solana. Verdicts are in mppverdict(), which reads the LAST response block only.
# Overridable so the assertion itself can be tested; unset in production.
MPP_GATED="${MPP_GATED_ROUTES:-/api/sol-price /api/btc-price}"
MPP_UNGATED="${MPP_UNGATED_ROUTE:-/api/liquidation-stats}"
MPH=$(mktemp)
for r in $MPP_GATED; do
  : > "$MPH"
  curl -s -D "$MPH" -o /dev/null -m 12 "${RETRY[@]}" "https://x402.ochinimus.app${r}" 2>/dev/null || true
  mppverdict "$r" "$MPH" gated
done
: > "$MPH"
curl -s -D "$MPH" -o /dev/null -m 12 "${RETRY[@]}" "https://x402.ochinimus.app${MPP_UNGATED}" 2>/dev/null || true
mppverdict "$MPP_UNGATED" "$MPH" ungated
rm -f "$MPH"

# REVENUE STALL. Every agentfeed probe above asks whether the paywall still
# ANSWERS -- 402 on the paid routes, a WWW-Authenticate challenge on the MPP
# ones, a number out of getPrice(). All of them can sit green while not one
# customer completes a payment: a facilitator that settles nothing, a rotated
# treasury whose USDC ATA was never created, a listing that fell out of
# discovery. Nothing on this box watched the thing the business actually runs
# on, which is rows landing in calls with status='paid'.
#
# EVERY RAIL IS COVERED, AND THAT IS READ OFF THE CODE, NOT OFF A SAMPLE. There
# are exactly two production sites that write a paid row, and both set the same
# marker: server.js:245 `status: s ? 'paid' : 'free'` (s = the x402 settlement
# header, or req.mppSettlement when the MPP gate supplied it -- one expression
# covering both of those rails) and mcp.js:125 `status: 'paid'` for the MCP
# rail. A future rail that books revenue anywhere other than the calls table
# would be invisible here; `grep -rn --include=*.js -F "'paid'" /opt/agentfeed`
# is how you find out, and it must keep returning only those two.
#
# THE PREDICATE IS status ONLY, DELIBERATELY. MPP push mode can settle without
# a `source`, which lands a genuine paid row with NULL payer_wallet and NULL
# tx_sig (mpp/test/concurrency-push.test.js). Counting on status alone means
# this check still sees that money, and means the U4 payer fix cannot move it.
#
# ts IS EPOCH MILLISECONDS (13 digits, verified against datetime()), hence the
# *1000 on both cutoffs. sqlite3 evaluates 'now' once per statement, so the
# two windows below share one boundary and cannot overlap or leave a hole.
#
# THE WINDOW IS 8 DAYS AND THAT IS MEASURED, NOT CAUTION. Paid traffic is
# sparse and bursty: 667 paid calls all time, and in the 30 days to 2026-09-19
# only 117 of 720 hours carried a single one. The two longest quiet stretches
# were 175.0h (Sep 7 12:49 -> Sep 14 19:50) and 145.4h (Aug 26 -> Sep 1), both
# with paying customers on either side. Backtesting THIS EXACT condition at
# this cron's 15-minute cadence over those 30 days (2881 simulated runs): a 1h
# window fires 69 times, 24h fires 505, 72h fires 576, and 168h STILL fires 28
# times inside the 175h gap. The smallest window that fires zero times is 175h.
# 192h is that rounded up to 8 days -- a 9.7% margin over the worst gap ever
# recorded -- and it fires zero times over the full history too (2026-07-08 on).
#
# WHAT IT BUYS AND WHAT IT DOES NOT. This catches "revenue stopped completely
# for over a week" and nothing finer. It cannot see a partial break -- one rail
# down, one route delisted -- because at this volume a partial break is
# indistinguishable from a quiet Tuesday. That is a traffic problem, not a
# tuning problem. Do NOT shorten the window without re-running the backtest.
#
# MIN-PREV IS 1 ON PURPOSE. A 24h window also backtests to zero fires if the
# previous window is required to hold 50+ calls. That is a trap, not a tuning:
# it is quiet only because it ignores every window without a 50-call burst, and
# the typical day here is 1-4 calls, so it would sleep through a real outage.
#
# SELF-CLEARING IS A KNOWN WART. After 16 days of total silence the previous
# window empties too, this goes quiet, and the recovery line will announce that
# all checks are clear. That is inherent in "compared with the previous
# comparable window", which is what was asked for. To latch instead, delete the
# lower bound from the second subquery so it counts every paid row before the
# window; backtested at the same 192h that variant also fires zero times over
# 30 days and over all time.
#
# agentfeed.db is journal_mode=wal -- checked -- so this read cannot be blocked
# by the writer and cannot produce the lock-race UNMEASURED that record.db
# does. A failed read still reports UNMEASURED rather than healthy, the rule
# the haircut publisher probe follows.
# Overridable so the assertion itself can be tested; unset in production.
REV_STALL_MIN="${REV_STALL_WINDOW_MIN:-11520}"
if [ -f /opt/agentfeed/agentfeed.db ]; then
  REV=$(sqlite3 /opt/agentfeed/agentfeed.db "SELECT (SELECT COUNT(*) FROM calls WHERE status='paid' AND ts >= (strftime('%s','now')-${REV_STALL_MIN}*60)*1000) || ' ' || (SELECT COUNT(*) FROM calls WHERE status='paid' AND ts >= (strftime('%s','now')-2*${REV_STALL_MIN}*60)*1000 AND ts < (strftime('%s','now')-${REV_STALL_MIN}*60)*1000);" 2>/dev/null || echo "")
  REV_CUR=$(printf '%s' "$REV" | cut -d' ' -f1)
  REV_PREV=$(printf '%s' "$REV" | cut -d' ' -f2)
  REV_H=$(awk -v m="$REV_STALL_MIN" 'BEGIN{printf "%.0f", m/60}' 2>/dev/null || echo "?")
  case "${REV_CUR:-x}${REV_PREV:-x}" in
    *[!0-9]*) ALERTS="${ALERTS} | agentfeed revenue: paid-call counts UNMEASURED" ;;
    *) [ "$REV_CUR" -eq 0 ] && [ "$REV_PREV" -gt 0 ] && ALERTS="${ALERTS} | agentfeed REVENUE STALLED: 0 paid calls in the last ${REV_H}h, previous ${REV_H}h had ${REV_PREV}" ;;
  esac
fi

# FRESHNESS OF THE AGENTFEED COLLECTORS (R6, 2026-10-12). Only liquidations.db was watched, so a collector could stop and
# its paid route would keep serving an ageing snapshot, or 503, with nothing paging. Each check reads what the route
# itself serves, at the path the collector writes by default; .env sets no *_SNAPSHOT or *_DB override (checked), and the
# crontab lines set none either. Note funding-radar's daily history refresh (from about 21:05 UTC, runs of 3m40s measured
# on 8 to 12 Oct) stretches one gap to about 8 min; the 900 s limit clears it.
# LIMIT = the smaller of 3x the cron cadence and the route's own staleness cutoff:
#   collector      cadence  3x      route cutoff                          limit
#   funding-radar  5 min    15 min  STALE_AFTER_S 15 min (flags stale)    900 s   funding-radar.json
#   hl-oi          5 min    15 min  window must be covered (503)          900 s   newest hl_oi.ts, hl-oi.db (R7: the OI sampler)
#   macro          daily    72 h    STALE_AFTER_DAYS 35 (503)             259200 s  macro.json
#   base-launches  1 min    3 min   STALE_MS 5 min (503)                  180 s   base-launches.json
#   hl-whales      5 min    15 min  SNAPSHOT_MAX_MS 6.5 min (else slow)   390 s   hl-whales.json
#   peg-collect    5 min    15 min  latest() maxAgeS 20 min (503)         900 s   newest ticks.ts, peg-onchain.db
#   jito-tips      15 min   45 min  45 min (503)                          1800 s  jito-tips.json (R26: 2 x REFRESH_S via ops/watchdog-jito-limit.js, two missed runs page, not the 3x rule)
#   sanctions      daily    30 h    48 h (503, tools/sanctions.js)          108000 s  data/sanctions-ofac.json (R11; cron 03:37, refresh keeps the last good copy)
#   disposable     weekly   8 d     21 d (503, tools/emailverify.js)        691200 s  data/disposable-domains.txt (R11; cron Mon 03:47)
# Every snapshot is written tmp + rename, so its mtime is the end of the last COMPLETED run.
fchk /opt/agentfeed/funding-radar.json funding-radar 900
afdbchk /opt/agentfeed/hl-oi.db hl_oi hl-oi 600   # R31: 600 s (two missed 5-min runs); the only sampler gap over 7 min in 20 days was the 10 Nov outage (4.3 h)
fchk /opt/agentfeed/macro.json macro 259200
fchk /opt/agentfeed/base-launches.json base-launches 180
fchk /opt/agentfeed/hl-whales.json hl-whales 390
afdbchk /opt/agentfeed/peg-onchain.db ticks peg-collect 900
fchk /opt/agentfeed/jito-tips.json jito-tips "$(/usr/bin/node /opt/agentfeed/ops/watchdog-jito-limit.js 2>/dev/null || echo 1800)"
fchk /opt/agentfeed/data/sanctions-ofac.json sanctions-list 108000
fchk /opt/agentfeed/data/disposable-domains.txt disposable-list 691200
bcheck

# Services that broke on the same Pyth 401. agentfeed and riskguard now carry
# their own multi-source fetcher.
# Each keeps its OWN copy of that fetcher, so one being healthy says nothing
# about the others - which is why each is probed separately.
#
# ERRORS ARE COUNTED AS A DELTA, NOT SCANNED. The first version of this check
# read `tail -50` of each error log and alerted on what it found there. That
# cannot tell a fault happening NOW from one that happened an hour ago and has
# since been fixed: right after the Pyth fix landed, both repaired services
# still tripped it on their own pre-fix history. Comparing the line count to the
# previous run measures only what actually arrived since then, needs no
# timestamps in the log, and goes quiet by itself once a fault stops producing
# new lines.
errdelta() {
  local svc=$1 threshold=$2 counter=${3:-} log now prev f
  log="/root/.pm2/logs/${svc}-error.log"
  [ -f "$log" ] || return 0
  if [ -n "$counter" ]; then now=$("$counter" "$log" 2>/dev/null || echo 0); else now=$(wc -l < "$log" 2>/dev/null || echo 0); fi
  f="$STATE/errlines-${svc}"
  prev=$(cat "$f" 2>/dev/null || echo "")
  printf '%s' "$now" > "$f"
  # First sighting: record the baseline and say nothing, so a service is never
  # alerted on for history it accumulated before this check existed.
  [ -z "$prev" ] && return 0
  # A shrinking count means the log was rotated or flushed; re-baseline.
  [ "$now" -lt "$prev" ] && return 0
  local grew=$(( now - prev ))
  [ "$grew" -ge "$threshold" ] && ALERTS="${ALERTS} | ${svc}: ${grew} new error lines since last check"
  return 0
}
# 15min between runs: riskguard polls every 20s (~45 lines if fully broken).
# A handful of lines is noise; a sustained fault
# produces far more than these floors.
errdelta riskguard 20

# KERNEL OOM KILLS. On 2026-09-16/17 the kernel killed a caliper recorder every
# 15 minutes for a day - 69 kills - and this watchdog said nothing, because
# every other check here asks whether a service still ANSWERS. An OOM kill is
# invisible to all of them: the cron job died and cron started a fresh one 15
# minutes later, and pm2-root (OOMPolicy=stop at the time) restarted every
# process without moving a single freshness timestamp.
#
# Counted as a delta for the same reason errdelta is: journalctl -k covers the
# whole boot, so a raw count would alert forever on history already dealt with.
# A reboot starts a new journal and the count drops, which re-baselines exactly
# like a rotated log. One "oom-kill:" line is one kill - 69 of them matched 69
# "Out of memory: Killed process" lines - so the number reported is kills, not
# log lines. Any growth alerts: unlike error lines there is no noise floor for
# a kernel OOM kill.
oomdelta() {
  local now prev f grew
  now=$(journalctl -k --no-pager 2>/dev/null | grep -c 'oom-kill:')
  # grep -c exits 1 when it counts zero and journalctl can print nothing at all,
  # so the count is validated rather than trusted. Bailing without writing the
  # state file leaves the previous baseline intact.
  case "$now" in ''|*[!0-9]*) return 0 ;; esac
  f="$STATE/oom-kills"
  prev=$(cat "$f" 2>/dev/null || echo "")
  printf '%s' "$now" > "$f"
  # First sighting: record the baseline and say nothing, so the box is never
  # alerted on for kills that happened before this check existed.
  [ -z "$prev" ] && return 0
  case "$prev" in *[!0-9]*) return 0 ;; esac
  # A shrinking count means a reboot rolled the journal; re-baseline.
  [ "$now" -lt "$prev" ] && return 0
  grew=$(( now - prev ))
  [ "$grew" -gt 0 ] && ALERTS="${ALERTS} | kernel OOM: ${grew} new oom-kill(s) since last check (${now} this boot)"
  return 0
}
oomdelta

# needrestart runs from the APT hook in Ubuntu mode, which with no explicit
# $nrconf{restart} falls through to 'a' (automatic): on 2026-09-18 06:21 it ran
# "systemctl restart pm2-root.service" mid-upgrade and cycled all 38 processes
# at once. /etc/needrestart/conf.d/90-pm2.conf now maps that unit to 0, so
# needrestart DEFERS it instead — reported, never restarted. That trades a
# surprise mass restart for a pending item nobody would otherwise look at,
# which is what this surfaces. "-r l" is list-only and cannot restart anything.
# The absolute path matters: cron's PATH has no /usr/sbin.
nrpending() {
  local out
  out=$(/usr/sbin/needrestart -r l -b 2>/dev/null) || return 0
  # No banner line means needrestart errored or printed nothing. Stay silent
  # rather than read an empty result as "nothing pending" — the same reason
  # oomdelta validates its count before trusting it.
  printf '%s\n' "$out" | grep -q '^NEEDRESTART-VER:' || return 0
  printf '%s\n' "$out" | grep -q '^NEEDRESTART-SVC: pm2-root\.service$' \
    && ALERTS="${ALERTS} | pm2-root: needrestart reports a restart pending (deferred, not performed) — cycle PM2 by hand when convenient"
  return 0
}
nrpending

# riskguard serves its price cache straight out of GET /price, and before
# 2026-08-27 it never cleared that cache on failure - so through the whole Pyth
# outage it answered 200 with a pre-outage price (measured: SOL 95.835 while SOL
# was 101.005). It now nulls a value it can no longer confirm, which makes the
# outage VISIBLE here: a null is the honest signal, and it is what this probes.
RG=$(curl -s -m 10 http://127.0.0.1:3004/price || echo "")
if [ -z "$RG" ]; then
  ALERTS="${ALERTS} | riskguard: :3004/price NOT ANSWERING"
else
  RG_SOL=$(printf '%s' "$RG" | python3 -c "import sys,json;p=json.load(sys.stdin).get('SOL');print(p if isinstance(p,(int,float)) else '')" 2>/dev/null || echo "")
  if [ -z "$RG_SOL" ]; then
    ALERTS="${ALERTS} | riskguard: SOL price is null — every price source is down"
  else
    awk -v v="$RG_SOL" 'BEGIN{exit !(v>0)}' || ALERTS="${ALERTS} | riskguard: SOL price ${RG_SOL}, expected above zero"
  fi
fi

# haircut stores ts as an ISO-8601 string, not an epoch, so chk() cannot read it:
# chk does arithmetic on MAX(ts) and would choke on the text. Let SQLite convert.
# Two failure modes matter here. The collector stopping is the obvious one. The
# collector still writing rows in which every fact is unmeasured is the dangerous
# one, because the row is fresh and worthless. One blip is the network, three in
# a row is a fault.
if [ -f /opt/haircut/haircut.db ]; then
  HC_AGE=$(sqlite3 /opt/haircut/haircut.db "SELECT CAST((strftime('%s','now') - strftime('%s', MAX(ts)))/60 AS INT) FROM readings;" 2>/dev/null || echo "")
  [ -n "$HC_AGE" ] && [ "$HC_AGE" -gt 20 ] && ALERTS="${ALERTS} | haircut: stale ${HC_AGE}min (limit 20)"
  HC_BLIND=$(sqlite3 /opt/haircut/haircut.db "SELECT COUNT(*) FROM (SELECT unmeasured FROM readings ORDER BY ts DESC LIMIT 3) WHERE unmeasured > 0;" 2>/dev/null || echo 0)
  [ "${HC_BLIND:-0}" -ge 3 ] && ALERTS="${ALERTS} | haircut: last 3 readings all had unmeasured facts"
fi

# The registry stops attesting silently when the publisher runs out of gas: the
# cron still fires, the transaction just never lands. Balance is the leading
# signal, on-chain age is the actual failure. A dead RPC must read as unmeasured,
# never as fresh.
HC_RPC=https://flare-api.flare.network/ext/C/rpc
# RUNWAY IS COUNTED IN WRITES, FROM THE UP-FRONT RESERVATION, NOT IN FLR. The daily publishes of Oct 2-6
# 2026 all failed "insufficient funds for intrinsic transaction cost" with 0.0985 FLR in the wallet, while
# a write only SPENDS ~0.069 FLR. The node refuses a tx unless the balance covers gasLimit x maxFeePerGas
# before anything runs, and publish.mjs sets neither: ethers 6.17 fills gasLimit from eth_estimateGas and
# maxFeePerGas as 2 x baseFee + eth_maxPriorityFeePerGas (1 gwei if the node has no such method). Measured
# Oct 6 with publish.mjs's own populate path on a live reading (keyless VoidSigner): gasLimit 106,794,
# maxFee 1,150 gwei (base 500 + tip 150), so a write needs 0.1228 FLR on hand to spend 105,791 x 650 gwei.
# The old "(about 7 writes)" under 1.0 FLR was a guess at an older gas price.
# N = writes the balance can still START: the first needs one reservation, each spends gasUsed x
# (base + tip), the last starts while the balance still covers a reservation. Gas price is live every run;
# the two gas figures are the measured ones above (105,791 is the most any of 57 logged publishes used).
# Alert under 7 writes: a week of the daily cron. Any failed read is UNMEASURED, never healthy.
hcrunway() {
python3 - "$1" <<'PY'
import sys, json, urllib.request
rpc = sys.argv[1]
def call(m, p):
    req = urllib.request.Request(rpc, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)["result"]
bal = int(call("eth_getBalance", ["0xdec77b9C8fCDBED952978730D96fEadC2fF59046", "latest"]), 16)
base = int(call("eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)
try:
    tip = int(call("eth_maxPriorityFeePerGas", []), 16)
except Exception:
    tip = 10**9
LIMIT, USED = 106794, 105791
up, cost = LIMIT * (2 * base + tip), USED * (base + tip)
n = (bal - up) // cost + 1 if bal >= up else 0
print("%d %.4f %.4f %.4f %d %d" % (n, bal / 1e18, up / 1e18, cost / 1e18, base // 10**9, tip // 10**9))
PY
}
HC_RUN=$(hcrunway "$HC_RPC" 2>/dev/null || echo "")
HC_N=$(printf '%s' "$HC_RUN" | cut -d' ' -f1)
case "$HC_N" in
  ''|*[!0-9]*) ALERTS="${ALERTS} | haircut publisher: balance UNMEASURED" ;;
  *)
    read -r _ HC_FLR HC_UP HC_COST HC_BASE HC_TIP <<< "$HC_RUN"
    HC_LINE="${HC_N} writes possible (${HC_FLR} FLR; a write reserves ${HC_UP} FLR up front and spends ${HC_COST} at ${HC_BASE}+${HC_TIP} gwei)"
    INFO="${INFO} | haircut publisher: ${HC_LINE}"
    [ "$HC_N" -lt 7 ] && ALERTS="${ALERTS} | haircut publisher: ${HC_LINE}"
    ;;
esac
HC_AGE_H=$(curl -s -m 10 -X POST "$HC_RPC" -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xFc581C88045608A1E6fb1C171cE1999AF039f212","data":"0xaab0d336"},"latest"]}' | python3 -c "import sys,json;print(int(json.load(sys.stdin)['result'],16)//3600)" 2>/dev/null || echo "")
if [ -n "$HC_AGE_H" ]; then
  [ "$HC_AGE_H" -gt 48 ] && ALERTS="${ALERTS} | haircut registry: newest on-chain reading is ${HC_AGE_H}h old (limit 48)"
else
  ALERTS="${ALERTS} | haircut registry: on-chain age UNMEASURED"
fi

# The track record has two ways to die quietly and they are different faults.
# Recording can stop, which leaves a gap in the forecasts. Or settling can stop,
# which leaves outcomes unwritten while forecasts keep piling up. The second is
# the dangerous one: a log full of predictions and no results is exactly what
# someone dropping their losses would produce, so it must never go unnoticed.
#
# WHY UNMEASURED APPEARS AND WHY IT IS NOT FIXED HERE. record.db is
# journal_mode=delete, so a writer takes an EXCLUSIVE lock and readers are
# blocked outright. caliper's recorder runs on the SAME */15 cron as this
# watchdog and writes ~774 rows per run as individual implicit transactions
# (387 settle UPDATEs then 387 INSERTs, no BEGIN around them), so the lock is
# taken and released hundreds of times while this script is probing. The
# sqlite3 CLI defaults to busy_timeout=0 and does not wait, so a read landing
# inside one of those bursts fails instantly with "database is locked (5)",
# stderr goes to /dev/null, and a HEALTHY record is reported UNMEASURED. The
# two probes run ~10ms apart against that flickering lock, which is why they
# disagree and why one appears to "recover" on its own: each read is an
# independent race, not a state.
#
# DO NOT ADD A BUSY TIMEOUT HERE. Tried 2026-08-27 07:25 (sqlite3 -cmd
# ".timeout 5000"). It silenced UNMEASURED, and on the very first collision -
# the 07:30 run - the waiting reader held its SHARED lock long enough to block
# caliper's WRITER, which has no busy timeout of its own. The recorder logged
# "XAUTUSDT: database is locked" / "ZHIPUUSDT: database is locked" and wrote
# 385 instead of 387. That trades a cosmetic false alert for real holes in a
# sealed, publicly-cited track record, which is a far worse bug. Reverted at
# 07:33. Those were the only two such lines in 2019 log lines.
#
# The honest fix is upstream and is a decision, not a patch: either put
# record.db in WAL (readers and writers stop blocking each other) or move this
# watchdog off the */15 boundary so the two jobs never overlap. Until one of
# those happens, UNMEASURED here can mean "lost a lock race", not "record
# broken" - and it stays visible rather than being silenced.
if [ -f /opt/caliper/record.db ]; then
  FC_AGE=$(sqlite3 /opt/caliper/record.db "SELECT CAST((strftime('%s','now')*1000 - MAX(window_start))/60000 AS INT) FROM forecasts;" 2>/dev/null || echo "")
  if [ -n "$FC_AGE" ]; then
    [ "$FC_AGE" -gt 45 ] && ALERTS="${ALERTS} | caliper record: newest forecast window is ${FC_AGE}min old (limit 45)"
  else
    ALERTS="${ALERTS} | caliper record: forecast age UNMEASURED"
  fi
  FC_STUCK=$(sqlite3 /opt/caliper/record.db "SELECT COUNT(*) FROM forecasts WHERE settled_at IS NULL AND window_end < strftime('%s','now')*1000 - 7200000;" 2>/dev/null || echo "")
  if [ -n "$FC_STUCK" ]; then
    [ "$FC_STUCK" -gt 0 ] && ALERTS="${ALERTS} | caliper record: ${FC_STUCK} forecasts closed over 2h ago and still unsettled"
  else
    ALERTS="${ALERTS} | caliper record: settlement backlog UNMEASURED"
  fi
fi

# alibi: check removed 2026-10-11. Judging ended Sep 15 and its CockroachDB Cloud cluster is gone
# (/api/state: "cluster not found", last snapshot ~2026-10-10 00:29 UTC); alibi-web keeps running.


# Four Cloud Run services in GCP project ata-agentfleet-2026 back two live
# hackathon entries and must stay reachable to judges until Oct 7 2026. They are
# probed the way a judge meets them: anonymous GET on the public URL. No gcloud
# on this box and no service-account token, deliberately - an authenticated
# check can pass while the public surface is broken, and the public surface is
# the only one that can cost the entries.
#
# TIMEOUT IS 15s BECAUSE CLOUD RUN SCALES TO ZERO. An idle service cold-starts
# on first hit, so the 10s used elsewhere in this file for always-warm hosts
# would page on nothing worse than an empty container pool. Measured from here:
# 0.22s warm, 2.0s waking.
#
# A 200 IS NOT THE TEST. Cloud Run serves its own error and placeholder pages
# with a 200 at the edge, so status alone cannot tell a live report from a dead
# deploy. Each probe reads the body instead: the two report pages must still
# carry their own name, and the two agent cards must still parse as JSON, which
# an HTML error page never does.
gcpchk() {
  local name=$1 url=$2 mode=$3 want=${4:-} code tmp
  tmp=$(mktemp) || return 0
  code=$(curl -s -m 15 "${RETRY[@]}" -o "$tmp" -w '%{http_code}' "$url" 2>/dev/null || true); code=${code:-000}
  if [ "$code" != 200 ]; then
    ALERTS="${ALERTS} | ${name}: returned ${code}, expected 200"
  elif [ "$mode" = has ]; then
    grep -qi -- "$want" "$tmp" || ALERTS="${ALERTS} | ${name}: 200 but body does not carry '${want}' (Cloud Run error page?)"
  else
    python3 -c "import sys,json;json.load(open(sys.argv[1]))" "$tmp" 2>/dev/null \
      || ALERTS="${ALERTS} | ${name}: 200 but body is not valid JSON (Cloud Run error page?)"
  fi
  rm -f "$tmp"
  return 0
}
GCPRUN=171666499035.us-central1.run.app
gcpchk "muster-report"       "https://muster-report-${GCPRUN}"       has  muster
gcpchk "recoup-report"       "https://recoup-report-${GCPRUN}"       has  recoup
gcpchk "contract-summarizer" "https://contract-summarizer-${GCPRUN}/.well-known/agent-card.json" json
gcpchk "invoice-triage"      "https://invoice-triage-${GCPRUN}/.well-known/agent-card.json"      json

# STATERA (X Layer). StateraFeed is read by CollateralGate, which REFUSES any
# row whose feed post is stale - so a keeper that stops posting turns the judged
# demo page to "refused" with nothing on this box saying why. The keeper's own
# balance-floor alert fires ONCE on the way down and nothing repeats it (Oct 6
# 2026: the publisher sat under the 0.0003 OKB floor for ~3.8h until topped up).
#   a) feed age: lastPublishedAt() is a view returning uint48 (ABI in
#      /opt/statera/src/keeper.ts:112), selector 0x065491a5 from
#      `cast sig "lastPublishedAt()"` (same tool gives 0xaab0d336 for the
#      haircut ageSeconds() above). The keeper heartbeats every 100 min, so
#      7200 s is one missed heartbeat plus a cron slot.
#   b) publisher runway in DAYS of posts above the floor (BALANCE_FLOOR_WEI,
#      policy.ts), at live gas: per post 486,930 gas - measured, the most any
#      of 253 logged posts used (none used the 436,458 in the brief) - and 18
#      posts a day, MAX_POSTS_PER_UTC_DAY, the most the keeper can spend
#      (it posted 12-15/day Sep 25 - Oct 5). Alert under 7 days.
# Any failed read is UNMEASURED, never healthy.
ST_RPC=https://rpc.xlayer.tech
ST_STALE_SEC=7200
ST_RUNWAY_DAYS=7
strd() {
python3 - "$1" "$2" <<'PY'
import sys, json, urllib.request
rpc, now = sys.argv[1], int(sys.argv[2])
def call(m, p):
    req = urllib.request.Request(rpc, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)["result"]
def tryint(f):
    try:
        return int(f(), 16)
    except Exception:
        return None
lpa = tryint(lambda: call("eth_call", [{"to": "0x879d9a5d1Fa688DDf94b13361490746Faf8b784C", "data": "0x065491a5"}, "latest"]))
bal = tryint(lambda: call("eth_getBalance", ["0x5B65b1e067270c46945e3bE5c0588FDb4dc7c018", "latest"]))
gp = tryint(lambda: call("eth_gasPrice", []))
age = "-" if lpa is None else str(now - lpa)
if bal is None or not gp:
    print(age, "-", "-", "-"); sys.exit(0)
FLOOR, GAS, PER_DAY = 300_000_000_000_000, 486_930, 18
days = max(0, bal - FLOOR) / (GAS * gp * PER_DAY)
print(age, "%.6f" % (bal / 1e18), "%.1f" % days, "%.3f" % (gp / 1e9))
PY
}
read -r ST_AGE ST_OKB ST_DAYS ST_GWEI <<< "$(strd "$ST_RPC" "$NOW" 2>/dev/null || echo "")"
case "${ST_AGE:-}" in
  ''|-|*[!0-9-]*) ALERTS="${ALERTS} | statera feed: lastPublishedAt UNMEASURED" ;;
  *)
    INFO="${INFO} | statera feed: last post ${ST_AGE}s ago"
    [ "$ST_AGE" -gt "$ST_STALE_SEC" ] && ALERTS="${ALERTS} | statera feed stale $((ST_AGE / 60))min: CollateralGate refuses, judged demo shows refused"
    ;;
esac
case "${ST_DAYS:-}" in
  ''|-) ALERTS="${ALERTS} | statera publisher: balance UNMEASURED" ;;
  *)
    ST_LINE="${ST_OKB} OKB, ${ST_DAYS} days of posts above the 0.0003 OKB floor (18/day, 486,930 gas, ${ST_GWEI} gwei)"
    INFO="${INFO} | statera publisher: ${ST_LINE}"
    awk -v d="$ST_DAYS" -v m="$ST_RUNWAY_DAYS" 'BEGIN{exit !(d<m)}' && ALERTS="${ALERTS} | statera publisher: ${ST_LINE}"
    ;;
esac

# ALEA KEEPER. On 2026-09-06 the round keeper ran for 10 hours with PM2 saying
# "online", restarts 0, while every 20s tick threw a codec error (round 2 had 3
# edges and the decoder refused the account's zero padding). No round opened,
# ~52 rounds were lost, and nothing on this box said a word: alea had no
# freshness check at all, only a process - the exact linewatch mistake this file
# opens with. The keeper keeps no database, so its DATA is read where it lives:
# on chain.
#
# ROUND PROGRESS is the real signal. Config.rounds_opened increments once per
# open_round, so a keeper that is up but not opening rounds cannot hide from it.
# Layout (lib.rs / IDL): 8 disc + authority[32] + keeper[32] + fee_bps u16 +
# rounds_opened u64 + bump u8 = 83 bytes, rounds_opened little-endian at 74.
# The stored timestamp is the moment the value was last seen to CHANGE, so one
# slow cycle does not page: it alerts only once the counter has sat still for
# over 40 minutes. A round is ~11.5 min but betting and the counted window run
# back to back, so the counter advances about every 23 min (measured Sep 7:
# opens at slots 23630139, 23633268, 23707306 at ~447 ms/slot) and this cron
# samples every 15 min - a page needs the keeper silent for roughly two rounds.
# A value going DOWN means the program was re-initialised: re-baseline, the way
# errdelta treats a rotated log. A dead RPC reads UNMEASURED, never healthy -
# the same rule the haircut publisher probe follows.
ALEA_RPC=https://rpc.cookiescan.io
ALEA_CONFIG=EH221jYN89kHiN33HXMAD9uVJzPXDGotRiJm7JHWUs14
ALEA_STALL_MIN=40
AR=$(curl -s -m 15 -X POST "$ALEA_RPC" \
  -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"${ALEA_CONFIG}\",{\"encoding\":\"base64\",\"commitment\":\"finalized\"}]}" \
  | python3 -c "import sys,json,base64
try:
    v=json.load(sys.stdin).get('result',{}).get('value')
    b=base64.b64decode(v['data'][0])
    print(int.from_bytes(b[74:82],'little') if len(b)==83 else '')
except Exception:
    print('')" 2>/dev/null || echo "")
if [ -z "$AR" ]; then
  ALERTS="${ALERTS} | alea: rounds_opened UNMEASURED"
else
  ARF="$STATE/alea-rounds"
  AR_PREV=$(cut -d' ' -f1 "$ARF" 2>/dev/null || echo "")
  AR_AT=$(cut -d' ' -f2 "$ARF" 2>/dev/null || echo "")
  if [ -z "$AR_PREV" ] || [ "$AR" != "$AR_PREV" ]; then
    # First sighting, a new round, or a re-initialised counter: (re)baseline.
    printf '%s %s\n' "$AR" "$NOW" > "$ARF"
  else
    AR_AGE=$(( (NOW - ${AR_AT:-$NOW}) / 60 ))
    [ "$AR_AGE" -gt "$ALEA_STALL_MIN" ] && ALERTS="${ALERTS} | alea STALLED: rounds_opened stuck at ${AR} for ${AR_AGE}min (limit ${ALEA_STALL_MIN}), keeper not opening rounds"
  fi
fi

# KEEPER BALANCE. The keeper pays the rent for every Round + vault PDA it opens
# plus the open and settle fees. One that runs dry keeps ticking and opens
# nothing, so it gets a balance probe.
# Measured Sep 7 from the round 3 transactions: open 1,988,600 lamports (rent +
# fee), settle 5,000, so 1,993,600 per round. Floor 5 COOK (5,000,000,000
# lamports, 9 decimals) is ~2,500 rounds, about 40 days at one round per 23 min,
# and the message counts the runway in rounds.
# Balance was 49.99 COOK when this was written.
ALEA_KEEPER=P5hP8saVjTLd3dGy2iziEz6HqcehRo8uLSZKLv7euZv
ALEA_KEEPER_FLOOR=5000000000
ALEA_ROUND_COST=1993600
AB=$(curl -s -m 15 -X POST "$ALEA_RPC" \
  -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"${ALEA_KEEPER}\"]}" \
  | python3 -c "import sys,json
try:
    v=json.load(sys.stdin).get('result',{}).get('value')
    print(v if isinstance(v,int) else '')
except Exception:
    print('')" 2>/dev/null || echo "")
if [ -z "$AB" ]; then
  ALERTS="${ALERTS} | alea keeper: balance UNMEASURED"
elif [ "$AB" -lt "$ALEA_KEEPER_FLOOR" ]; then
  ALERTS="${ALERTS} | alea keeper LOW: $(awk -v v="$AB" 'BEGIN{printf "%.4f", v/1e9}') COOK, floor 5 (~$((AB/ALEA_ROUND_COST)) rounds left)"
fi

# PM2 ERROR DELTA, same helper and rule as riskguard. One fact
# decides how it is wired: the keeper logs a failing tick through console.log,
# so the 1,654 "tick error" lines from the Sep 6 stall all went to alea-OUT.log
# and alea-error.log stayed at 0 lines. errdelta on the error log therefore
# catches only a crash (FATAL / uncaught, which PM2 writes to stderr). The tick
# errors are counted separately, from the out log, under the same
# baseline-then-delta rule, so the failure that actually happened is the one
# that pages. A stalled keeper writes one line per 20s tick, ~45 per 15-minute
# window; 10 is a safe floor for both.
errdelta alea 10
AO=/root/.pm2/logs/alea-out.log
if [ -f "$AO" ]; then
  # grep -c prints 0 and exits 1 on no match, so the exit code is ignored and
  # only a non-numeric result is treated as "could not count".
  AO_NOW=$(grep -c 'tick error' "$AO" 2>/dev/null)
  case "$AO_NOW" in ''|*[!0-9]*) AO_NOW=0 ;; esac
  AOF="$STATE/tickerrs-alea"
  AO_PREV=$(cat "$AOF" 2>/dev/null || echo "")
  printf '%s' "$AO_NOW" > "$AOF"
  if [ -n "$AO_PREV" ] && [ "$AO_NOW" -ge "$AO_PREV" ]; then
    AO_GREW=$(( AO_NOW - AO_PREV ))
    [ "$AO_GREW" -ge 10 ] && ALERTS="${ALERTS} | alea: ${AO_GREW} new tick errors since last check"
  fi
fi

# BACKBONE_JUDGED_V1. backbone-api is a judged surface: RevenueCat Shipaton
# judging runs Oct 1-13 2026 and every judge's rehearsal goes through this
# box. Three quiet ways it can die, one probe each:
#   1. process, tunnel or edge down. GET / on the public URL must answer
#      ok:true AND mock:false - a 200 serving canned mock replies as coaching
#      is a failure too.
#   2. the Anthropic key stops working (credits run out, key revoked). GET /
#      stays green while every turn and debrief fails, so the key is probed
#      directly: a 1-token call with the service's own key and turn model,
#      about 10 tokens a run. The key is read from the service's .env and
#      handed to curl on stdin, so it never sits on a command line or in a log.
#   3. requests failing for any other reason. The server writes one error
#      line per failed turn or debrief; 3 new lines in 15 minutes is a fault.
# Overridable so the assertion itself can be tested; unset in production.
BB_URL="${BACKBONE_URL:-https://backbone-api.ochinimus.app/}"
BB_ENV="${BACKBONE_ENV:-/opt/backbone-api/.env}"
bbenv() { grep -m1 "^$1=" "$BB_ENV" 2>/dev/null | cut -d= -f2- | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
# Body to a file, not a pipe, so a retried blip cannot prepend an error page to the JSON (see RETRY).
BBT=$(mktemp)
curl -s -m 10 "${RETRY[@]}" -o "$BBT" "$BB_URL" 2>/dev/null || true
BBS=$(python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print('ok' if d.get('ok') is True and d.get('mock') is False else 'wrong')" "$BBT" 2>/dev/null || echo "")
rm -f "$BBT"
[ "$BBS" != ok ] && ALERTS="${ALERTS} | backbone-api: public GET / ${BBS:-not answering}, app down for judges"
BBK=$(bbenv ANTHROPIC_API_KEY)
if [ -n "$BBK" ]; then
  BBM=$(bbenv MODEL)
  BBC=$(printf 'x-api-key: %s\n' "$BBK" | curl -s -o /dev/null -m 20 -w '%{http_code}' -H @- \
    -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
    -d "{\"model\":\"${BBM:-claude-haiku-4-5-20251001}\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}]}" \
    https://api.anthropic.com/v1/messages 2>/dev/null || true); BBC=${BBC:-000}
  [ "$BBC" != 200 ] && ALERTS="${ALERTS} | backbone-api: Anthropic key answered ${BBC}, expected 200 (credits or key), every rehearsal fails"
else
  ALERTS="${ALERTS} | backbone-api: ANTHROPIC_API_KEY UNMEASURED"
fi
unset BBK
errdelta backbone-api 3

# LICTOR (Enosys liquidation keeper, /opt/lictor, pm2 `lictor`). LIVE and
# earning since 2026-09-29. A mid-run death or a silent drop to SIM costs income
# and nothing else on this box would say so: the keeper's own Telegram alert
# fires only when it BOOTS with SEND=0. Three checks; a read that fails reports
# UNMEASURED, never healthy, the rule every probe in this file follows.
#   a) the pm2 process is online.
#   b) its heartbeat is fresh. The keeper upserts heartbeat.ts (epoch ms) in
#      /opt/lictor/state/ledger.db every ~15 s, and only from a COMPLETED sweep,
#      so the age is the age of the loop, not of the process (linewatch sat
#      "online" for 12 days). A keeper started before that table existed is read
#      from the last "heartbeat" line of its pm2 out log instead (one per 100
#      blocks, ~2 min). 5 min = two missed log beats, twenty missed row beats.
#      Skipped when (a) already says the process is down: one fault, one line.
#   c) it is SENDING: the running process was started with SEND=1 (pm2 env),
#      reports send=1 itself once it writes the row, and live.env still says
#      SEND=1 - which is what the NEXT cycle starts with. live.env is parsed the
#      way ecosystem.config.js parses it: `SEND = 1` counts, anything else is SIM.
# pm2 jlist carries every process's env, secrets included, so the parse (pm2st,
# defined at the top and shared with the linewatch gate) prints two fields and
# nothing else.
# Overridable so the assertion itself can be tested; unset in production.
LIC_NAME="${LICTOR_PM2_NAME:-lictor}"
LIC_DB="${LICTOR_LEDGER_DB:-/opt/lictor/state/ledger.db}"
LIC_ENV="${LICTOR_LIVE_ENV:-/opt/lictor/live.env}"
LIC_OUT="${LICTOR_OUT_LOG:-/root/.pm2/logs/lictor-out.log}"
LIC_HB_MIN=5
LIC=$(pm2st "$LIC_NAME")
LIC_ST=$(printf '%s' "$LIC" | cut -d' ' -f1)
LIC_SEND=$(printf '%s' "$LIC" | cut -d' ' -f2)
if [ -z "$LIC_ST" ]; then
  ALERTS="${ALERTS} | lictor: pm2 state UNMEASURED"
elif [ "$LIC_ST" != online ]; then
  ALERTS="${ALERTS} | lictor: pm2 process '${LIC_NAME}' is ${LIC_ST}, Enosys keeper DOWN and not earning"
elif [ "$LIC_SEND" != 1 ]; then
  ALERTS="${ALERTS} | lictor: running keeper was started with SEND=${LIC_SEND}, it is in SIM and not sending"
fi
if [ -z "$LIC_ST" ] || [ "$LIC_ST" = online ]; then
  LIC_HB=$(sqlite3 "$LIC_DB" "SELECT ts || ' ' || send FROM heartbeat WHERE id = 1;" 2>/dev/null || echo "")
  LIC_HB_TS=$(printf '%s' "$LIC_HB" | cut -d' ' -f1)
  LIC_HB_SEND=$(printf '%s' "$LIC_HB" | cut -d' ' -f2)
  LIC_HB_SRC=row
  if [ -z "$LIC_HB_TS" ]; then
    LIC_HB_TS=$(tac "$LIC_OUT" 2>/dev/null | grep -m1 '"evt":"heartbeat"' | python3 -c "
import sys,json,datetime
try:
    t=json.loads(sys.stdin.read())['t']
    print(int(datetime.datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()*1000))
except Exception:
    print('')" 2>/dev/null || echo "")
    LIC_HB_SEND=""
    LIC_HB_SRC=log
  fi
  case "$LIC_HB_TS" in
    ''|*[!0-9]*) ALERTS="${ALERTS} | lictor: heartbeat UNMEASURED (no row in ${LIC_DB}, no heartbeat line in ${LIC_OUT})" ;;
    *)
      LIC_AGE=$(( (NOW - LIC_HB_TS / 1000) / 60 ))
      [ "$LIC_AGE" -gt "$LIC_HB_MIN" ] && ALERTS="${ALERTS} | lictor: heartbeat (${LIC_HB_SRC}) stale ${LIC_AGE}min (limit ${LIC_HB_MIN}), keeper not sweeping"
      [ "$LIC_HB_SEND" = 0 ] && ALERTS="${ALERTS} | lictor: keeper reports send=0, it is in SIM and not sending"
      ;;
  esac
fi
LIC_LIVE=$(sed -n 's/^[[:space:]]*SEND[[:space:]]*=[[:space:]]*\([^[:space:]]*\).*/\1/p' "$LIC_ENV" 2>/dev/null | head -1)
if [ ! -r "$LIC_ENV" ]; then
  ALERTS="${ALERTS} | lictor: ${LIC_ENV} UNREADABLE, the next cycle would start in SIM"
elif [ "$LIC_LIVE" != 1 ]; then
  ALERTS="${ALERTS} | lictor: live.env has SEND=${LIC_LIVE:-unset}, the next cycle starts Enosys in SIM"
fi

[ "${1:-}" = --test ] && ALERTS=" | TEST: watchdog wiring check"

# REPEAT SUPPRESSION. This script had never been scheduled, so it had never had
# to think about repeats. Now that it runs every 15 minutes, an unchanged alert
# set must not re-send every cycle: a fault that takes a day to fix would post
# ~96 identical messages and train the reader to ignore the channel - the exact
# failure this file already calls out for linewatch's off-season.
#
# An alert set re-sends only when it CHANGES, or once every 6 hours as a
# reminder that the fault is still open. A change in either direction is
# interesting: a new fault appearing, or one clearing. Recovery is announced
# explicitly, because silence is indistinguishable from the watchdog being dead.
SIGF="$STATE/last-signature"; TIMF="$STATE/last-sent"
# SIGNATURE IS THE FAILING SET, NOT THE RENDERED TEXT. The signature used to be
# md5 of $ALERTS verbatim, which meant anything varying inside the message broke
# suppression for every alert standing beside it. Two live causes: counters
# ("solwatch: 30 new error lines") move almost every run, and a flapping member
# (caliper "forecast age" present at 07:00, gone at 07:15) reshuffles the string.
# Either way the signature never repeated and the whole message re-sent every 15
# minutes - 96 a day, the exact channel-fatigue failure this file warns about.
#
# Collapsing every run of digits to '#' leaves the alert IDENTITIES: which checks
# are failing and how, with the measurements stripped out. A changing counter no
# longer moves the signature. A member clearing or a new one appearing still
# does, because that changes the set - which is a real event and must re-send.
# The numbers are untouched in $ALERTS itself, so the message still carries them.
SIG=$(printf '%s' "$ALERTS" | sed 's/[0-9][0-9.]*/#/g' | md5sum | cut -d' ' -f1)
PREV_SIG=$(cat "$SIGF" 2>/dev/null || echo "")
PREV_AT=$(cat "$TIMF" 2>/dev/null || echo 0)
AGE=$(( NOW - ${PREV_AT:-0} ))

# R31 (14 Nov 2026): the state (signature, send time) is recorded ONLY when Telegram answers {"ok":true}. Before, a send that failed (the 10 Nov
# outage cut the box's own outbound traffic for hours) was recorded as sent, so the same alert was then suppressed for 6 h and a recovery
# notice was owed to a message nobody had received. A failed send now leaves the old state, so the next run (every 15 min) sends again.
send() {
  local resp
  resp=$(curl -s -m 20 -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHANNEL}" \
    --data-urlencode "text=$1" 2>/dev/null)
  case "$resp" in
    *'"ok":true'*) printf '%s' "$SIG" > "$SIGF"; printf '%s' "$NOW" > "$TIMF"; return 0 ;;
  esac
  echo "SEND FAILED (state not recorded, retried next run): $(printf '%s' "$resp" | head -c 120)"
  return 1
}

if [ -n "$ALERTS" ]; then
  if [ "$SIG" != "$PREV_SIG" ]; then
    send "WATCHDOG${ALERTS}" && echo "alerted (new):${ALERTS}" || echo "alert NOT delivered:${ALERTS}"
  elif [ "$AGE" -ge 21600 ]; then
    send "WATCHDOG (still open, 6h reminder)${ALERTS}" && echo "alerted (reminder):${ALERTS}" || echo "reminder NOT delivered:${ALERTS}"
  else
    printf '%s' "$SIG" > "$SIGF"
    echo "unchanged, suppressed (${AGE}s since last send):${ALERTS}"
  fi
else
  # Recovery has to be announced. A watchdog that only ever speaks when things
  # break cannot be told apart from one that has stopped running.
  if [ -n "$PREV_SIG" ] && [ "$PREV_SIG" != "$(printf '' | md5sum | cut -d' ' -f1)" ]; then
    if send "WATCHDOG recovered — all checks clear"; then
      : > "$SIGF"
      echo "recovered, alerted"
    else
      echo "recovered, NOT delivered (retried next run)"
    fi
  else
    echo "all collectors fresh"
  fi
fi
[ -n "$INFO" ] && echo "info:${INFO}"
exit 0

#!/bin/bash
# af-scratch-boot.sh <dir> <port> <logfile> <pidfile>
# Boots a scratch server and records its PID. `pkill -f` cannot be used to stop
# these: the cmdline is just `node --env-file=.env server.js` with no directory
# in it, so a pattern kill either matches nothing or matches the wrong process.
# Measured Sep 25 2026: a pkill that matched nothing left the old boot serving
# while the replacement died of EADDRINUSE, and the port looked healthy the
# whole time.
#
# EVERY scratch gets its own copy of the audit database. The line this replaced
# was `rm -f agentfeed.db`, which was useless against a scratch tree that
# symlinked db.js: node resolves a module's realpath first, so __dirname was
# /opt/agentfeed and the live calls table got 37 rows of test traffic. db.js now
# reads AGENTFEED_DB, and this refuses to boot if that is not set to something
# outside /opt/agentfeed -- a convention you have to remember is not a fix.
set -e
DIR="$1"; PORT="$2"; LOG="$3"; PIDF="$4"
if ss -ltn | grep -q ":$PORT "; then echo "REFUSING: port $PORT already in use"; exit 1; fi
cd "$DIR"

: "${AGENTFEED_DB:=$DIR/scratch-agentfeed.db}"
case "$AGENTFEED_DB" in
  /opt/agentfeed/*) echo "REFUSING: AGENTFEED_DB points into the live service ($AGENTFEED_DB)"; exit 1;;
esac
export AGENTFEED_DB
rm -f "$AGENTFEED_DB" "$AGENTFEED_DB-wal" "$AGENTFEED_DB-shm"
if [ -f /opt/agentfeed/agentfeed.db ]; then
  sqlite3 /opt/agentfeed/agentfeed.db ".backup $AGENTFEED_DB"
fi

PORT="$PORT" setsid nohup node --env-file=.env server.js > "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDF"
sleep 1
echo "booting pid=$(cat $PIDF) dir=$DIR port=$PORT db=$AGENTFEED_DB"

#!/bin/bash
# ops/add-rpc-fallback.sh — put a KEYED Solana RPC provider into this service's failover chain (R20h, 30 Oct 2026).
#
#   read -rs U; printf '%s' "$U" | ssh root@167.233.69.154 'bash /opt/agentfeed/ops/add-rpc-fallback.sh'; unset U
#
# The provider URL (with its key in it, e.g. https://solana-mainnet.g.alchemy.com/v2/<key>) is read from STDIN: never from argv (ps would show it), never printed. The script
#   1. PROBES it before touching anything: getSlot must answer, and getTokenLargestAccounts (the method the public RPC refuses) must return a ranking. A provider that fails
#      either is not written. Only HTTP statuses and JSON-RPC error TEXT are printed, never a URL;
#   2. backs up .env (.env.bak-pre-rpc-fallbacks-<stamp>), replaces any RPC_FALLBACKS line with  RPC_FALLBACKS=<provider>,https://api.mainnet-beta.solana.com
#      (keyed first, the public RPC last: lib/rpc-heavy.js keeps the public RPC out of the way for getTokenLargestAccounts), keeping the file's mode;
#   3. restarts agentfeed the way this box does it (pm2 delete + start + save, under the batch-claim lock; PM2 freezes its environment at first start, so restart is not enough);
#   4. checks /health.
# Rollback: cp -p .env.bak-pre-rpc-fallbacks-<stamp> .env and the same restart. Env for tests: AF_DIR, AF_RESTART_CMD, AF_NO_CHECK.
set -euo pipefail
cd "${AF_DIR:-/opt/agentfeed}"
IFS= read -r URL || true
[ -n "${URL:-}" ] || { echo "no URL on stdin: nothing changed"; exit 2; }
case "$URL" in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "the URL must start with https://: nothing changed"; exit 2 ;;
esac
HOST=$(printf '%s' "$URL" | sed -E 's#^https?://([^/?:]+).*#\1#')
echo "provider host: $HOST  (URL length ${#URL}; the URL itself is never printed)"

PROBE=$(URL="$URL" node --input-type=module -e '
const url = process.env.URL;
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const call = async (method, params) => {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
    return { http: r.status, j, text: t.slice(0, 120).replace(/https?:\/\/\S+/g, "<url>").replace(/[A-Za-z0-9_-]{24,}/g, "<id>") };
  } catch (e) { return { http: 0, text: String(e.message || e).replace(/https?:\/\/\S+/g, "<url>").slice(0, 100) }; }
};
const slot = await call("getSlot", []);
const largest = await call("getTokenLargestAccounts", [MINT]);
const slotOk = slot.http === 200 && slot.j && Number.isFinite(slot.j.result);
const largestOk = largest.http === 200 && largest.j && largest.j.result && Array.isArray(largest.j.result.value) && largest.j.result.value.length > 0;
console.log(`getSlot: ${slotOk ? "ok" : `FAILED http ${slot.http} ${slot.text}`}`);
console.log(`getTokenLargestAccounts: ${largestOk ? `ok (${largest.j.result.value.length} accounts)` : `FAILED http ${largest.http} ${largest.j && largest.j.error ? String(largest.j.error.message).slice(0, 100) : largest.text}`}`);
process.exit(slotOk && largestOk ? 0 : 1);
') || { echo "$PROBE"; echo "this provider does not serve what the failover needs: .env was NOT changed"; exit 1; }
echo "$PROBE"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
cp -p .env ".env.bak-pre-rpc-fallbacks-$STAMP"
cp -p .env .env.new
grep -v '^RPC_FALLBACKS=' .env > .env.new || true
printf 'RPC_FALLBACKS=%s,https://api.mainnet-beta.solana.com\n' "$URL" >> .env.new
mv .env.new .env
echo ".env updated (backup .env.bak-pre-rpc-fallbacks-$STAMP); RPC_FALLBACKS now: $HOST, api.mainnet-beta.solana.com"

if [ -n "${AF_RESTART_CMD:-}" ]; then
  bash -c "$AF_RESTART_CMD"
else
  flock -w 900 /var/lock/batch-claim.lock bash -c 'cd /opt/agentfeed && pm2 delete agentfeed >/dev/null && pm2 start server.js --name agentfeed >/dev/null && pm2 save >/dev/null'
fi
echo "restarted at $(date -u +%FT%TZ)"
if [ -z "${AF_NO_CHECK:-}" ]; then
  sleep 8
  code=$(curl -s -o /dev/null -w '%{http_code}' localhost:3006/health || true)
  echo "local /health: $code"
  [ "$code" = "200" ] || { echo "health check failed: roll back with  cp -p .env.bak-pre-rpc-fallbacks-$STAMP .env  and restart"; exit 3; }
fi
echo "done. Verify the routes with the refresh command (it pays only what is still unpaid)."

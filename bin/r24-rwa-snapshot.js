#!/usr/bin/env node
// bin/r24-rwa-snapshot.js: the daily collector of get_rwa_yields (R24, item 3). Reads each served product's on-chain price at the latest block (tools/r24/rwa) and appends one
// row per product to rwa-snapshots.db (R24_RWA_DB, default beside the audit database). Idempotent per UTC day: a second run the same day changes nothing. Rows older than 400
// days are deleted, so the file is bounded. A product whose read fails or fails the plausibility checks is skipped (no row), the others are still written, and the exit code is 2.
//   15 2 * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/r24-rwa-snapshot.lock /usr/bin/timeout 120 /usr/bin/node --env-file=.env --max-old-space-size=96 bin/r24-rwa-snapshot.js >> /opt/agentfeed/r24-rwa-snapshot.log 2>&1
// Output: one line per product (id and added | exists | FAILED <reason code>), never a URL, a key or a remote error text. R24_RWA_RPC_ETH (comma separated) puts the operator's own endpoints first.
//   --dry   read and print, write nothing
'use strict';
const path = require('path');
const R = require(path.join('..', 'tools', 'r24', 'rwa', 'rpc'));
const RD = require(path.join('..', 'tools', 'r24', 'rwa', 'reader'));
const SNAP = require(path.join('..', 'tools', 'r24', 'rwa', 'snapshots'));
const { served } = require(path.join('..', 'tools', 'r24', 'rwa', 'products'));
const { envNum } = require(path.join('..', 'tools', 'r23', 'common'));

async function run({ env = process.env, argv = [], deps = {}, out = (l) => console.log(l) } = {}) {
  const now = deps.now || Date.now;
  const dry = argv.includes('--dry');
  const file = SNAP.defaultPath(env);
  if (!file && !dry) { out(`${new Date(now()).toISOString()} FAILED no database path (set R24_RWA_DB)`); return 1; }
  const rpc = deps.rpc || R.makeRpc({ endpoints: R.endpointsFrom(env), fetchImpl: deps.fetchImpl, now, budget: envNum('R24_RWA_RPC_BUDGET', R.BUDGET, env) });
  let head;
  try { head = await R.getBlock(rpc, 'latest', now); } catch (e) { out(`${new Date(now()).toISOString()} FAILED head ${e && e.detail ? e.detail : 'rpc'}`); return 2; }
  const db = dry ? null : SNAP.openWriter(file);
  let failed = 0;
  try {
    for (const p of served()) {
      try {
        await RD.checkDecimals(rpc, p, head.number, now);
        const v = await RD.readAt(rpc, p, head.number, head.ts);
        const n = Number(v.raw) / 10 ** p.read.decimals;
        if (!(n >= p.band[0] && n <= p.band[1])) throw Object.assign(new Error('band'), { detail: 'band' });
        if (p.staleSec != null && v.updatedAt != null && head.ts - v.updatedAt > p.staleSec) throw Object.assign(new Error('stale'), { detail: 'stale' });
        const added = dry ? false : SNAP.record(db, { product: p.id, block: head.number, blockTs: head.ts, priceRaw: v.raw, decimals: p.read.decimals, updatedAt: v.updatedAt });
        out(`${new Date(now()).toISOString()} ${p.id} ${dry ? 'read' : (added ? 'added' : 'exists')} block=${head.number}`);
      } catch (e) {
        failed++;
        out(`${new Date(now()).toISOString()} ${p.id} FAILED ${e && e.detail ? e.detail : 'error'}`);
      }
    }
    if (db) { const gone = SNAP.prune(db, head.ts); if (gone) out(`${new Date(now()).toISOString()} pruned ${gone}`); }
  } finally { if (db) db.close(); }
  return failed ? 2 : 0;
}

module.exports = { run };
if (require.main === module) run({ argv: process.argv.slice(2) }).then((c) => process.exit(c), (e) => { console.log(`${new Date().toISOString()} FAILED ${String(e && e.message || e).slice(0, 120).replace(/https?:\/\/\S+/g, '[url]')}`); process.exit(1); });

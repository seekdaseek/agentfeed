// ops/r24-txprecheck-mem.mjs: resident-memory growth of GET /api/tx-precheck (R24 item 4): 3 fresh processes x 2 modes, 20 calls each (10 Solana, 10 Base) against the test fixtures' fake RPC.
//   cold: rss before require, after require of the module and everything it needs, after 20 calls
//   warm: the shared dependencies the real server already holds (viem, @solana/kit, tools/honeypot.js, tools/tokenrisk.js, lib/solrpc.js) are loaded FIRST, so the growth is the module's own
//   node ops/r24-txprecheck-mem.mjs
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] === 'child') {
  const require = createRequire(path.join(ROOT, 'package.json'));
  const mode = process.argv[3];
  const mb = (n) => Math.round((n / 1048576) * 10) / 10;
  if (mode === 'warm') { require('viem'); require('@solana/kit'); require(path.join(ROOT, 'tools/honeypot.js')); require(path.join(ROOT, 'tools/tokenrisk.js')); require(path.join(ROOT, 'lib/solrpc.js')); require('zod'); }
  if (global.gc) global.gc();
  const r0 = process.memoryUsage().rss;
  const T = require(path.join(ROOT, 'tools/r24/txprecheck'));
  const B = require(path.join(ROOT, 'test/fixtures/r24/txprecheck/build.js'));
  const S = require(path.join(ROOT, 'test/fixtures/r24/txprecheck/scenarios.js'));
  const W = require(path.join(ROOT, 'test/fixtures/r24/txprecheck/evm-world.js'));
  const r1 = process.memoryUsage().rss;
  const sol = B.stubSol(S.solWorld()); const base = W.makeEvmWorld(S.baseWorld());
  const deps = { sol: { rpc: sol.rpc, now: Date.now, solRisk: async () => { throw new Error('x'); } }, base: { base: { request: base.request }, now: Date.now, baseRisk: async () => { throw new Error('x'); } } };
  const run = T.entries[0].run; const entries = T.makeEntries(deps);
  for (let i = 0; i < 10; i++) {
    await entries[0].run({ chain: 'solana', tx: S.tx[i % 2 ? 'approve' : 'ok']() });
    await entries[0].run({ chain: 'base', to: S.ADDR.usdc, from: S.ADDR.me, data: '0x095ea7b3' });
  }
  void run;
  if (global.gc) global.gc();
  const r2 = process.memoryUsage().rss;
  console.log(JSON.stringify({ mode, rss_before_mb: mb(r0), require_mb: mb(r1 - r0), calls_mb: mb(r2 - r1), total_mb: mb(r2 - r0) }));
  process.exit(0);
}
for (const mode of ['cold', 'warm']) {
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), 'child', mode], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    if (r.status !== 0) { console.log(r.stdout, r.stderr); process.exit(1); }
    rows.push(JSON.parse(r.stdout.trim().split('\n').pop()));
  }
  console.log(`${mode}:`); for (const r of rows) console.log('  ', JSON.stringify(r));
  const avg = (k) => Math.round((rows.reduce((s, r) => s + r[k], 0) / rows.length) * 10) / 10;
  console.log(`   mean: require ${avg('require_mb')} MB, 20 calls ${avg('calls_mb')} MB, total ${avg('total_mb')} MB`);
}

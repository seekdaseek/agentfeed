// ops/af-forecast-record-test.mjs — the regression test for the worker-backed
// track-record read. Not a unit test: it needs two scratch servers and a frozen
// copy of caliper's record.db, because the thing under test is what the event
// loop does while a 4.7 s read is in progress.
//
// Setup, from /root:
//   sqlite3 /opt/caliper/record.db ".backup /root/af7/record-snap.db"
//   CALIPER_RECORD_DB=/root/af7/record-snap.db AGENTFEED_DB=/root/af7/src-db.sqlite \
//     bash /root/af-scratch-boot.sh <work-tree> 3999 /root/af7/src.log /root/af7/src.pid
//   node ops/af-forecast-record-test.mjs
//
// The snapshot matters: caliper's cron writes record.db every 15 minutes, so a
// payload compared against the live database is flaky by construction. It also
// reads /root/af7/src.log to count computations, which is how "twenty callers,
// one computation" is proved rather than asserted.
//
// Ports 3999 (patched) and 4099 (a pristine pre-change tree) are hardcoded; the
// 4099 comparison lives in the sibling checks run at deploy time.
import http from 'node:http';
import fs from 'node:fs';
const agent = new http.Agent({ keepAlive: true, maxSockets: 80 });
function get(port, path) {
  const t0 = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', agent, headers: { host: 'x402.ochinimus.app' } },
      (res) => { const c = []; res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, body: Buffer.concat(c).toString() })); });
    req.on('error', reject); req.end();
  });
}
const computeCount = () => (fs.readFileSync('/root/af7/src.log', 'utf8').match(/\[record\] computed/g) || []).length;
const p = (n, d = 1) => n.toFixed(d);
const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { min: s[0], med: s[(s.length / 2) | 0], max: s[s.length - 1] }; };
let fails = 0;
const verdict = (ok, why) => { if (!ok) fails++; console.log(`  VERDICT: ${ok ? 'PASS' : 'FAIL'}${why ? '  ' + why : ''}`); };

const PORT = 3999;
await Promise.all(Array.from({ length: 50 }, () => get(PORT, '/health'))); // warm sockets

// --- FLOOR: what do 50 concurrent challenges cost with NOTHING in flight?
console.log('FLOOR — 50 concurrent 402 challenges, idle server, nothing blocking');
const floor = stats((await Promise.all(Array.from({ length: 50 }, () => get(PORT, '/api/sol-price')))).map((r) => r.ms));
console.log(`  challenge ms: min ${p(floor.min)}  median ${p(floor.med)}  max ${p(floor.max)}`);
console.log('  this is the single-thread cost of generating 50 challenges; no record read involved');

// --- TEST 1: the same 50, during a full unfiltered record computation
console.log('\nTEST 1 — 50 concurrent 402 challenges DURING a record computation');
let done = false;
const rec = get(PORT, '/api/forecast-record?rows=5').then((r) => { done = true; return r; });
await new Promise((r) => setTimeout(r, 250));
const inFlight = !done;
const t = stats((await Promise.all(Array.from({ length: 50 }, () => get(PORT, '/api/sol-price')))).map((r) => r.ms));
const allBefore = !done;
const recRes = await rec;
console.log(`  record call: ${recRes.status} in ${p(recRes.ms)}ms (a full unfiltered tally)`);
console.log(`  it was still in flight when the 50 were fired: ${inFlight}`);
console.log(`  all 50 answered before it returned: ${allBefore}`);
console.log(`  challenge ms: min ${p(t.min)}  median ${p(t.med)}  max ${p(t.max)}`);
console.log(`  vs idle floor: max ${p(floor.max)} -> ${p(t.max)}ms  (delta ${p(t.max - floor.max)}ms)`);
verdict(inFlight && allBefore && t.max < 50, `want max < 50ms, got ${p(t.max)}ms; idle floor is ${p(floor.max)}ms`);

// --- TEST 2: cold SLOW key, 20 concurrent -> exactly one computation
console.log('\nTEST 2 — 20 concurrent record calls on a cold key with a 4.7s compute window');
const before = computeCount();
const all = await Promise.all(Array.from({ length: 20 }, () => get(PORT, '/api/forecast-record?rows=9')));
const after = computeCount();
const stamps = [...new Set(all.map((r) => JSON.parse(r.body).data.computedAt))];
const ts = stats(all.map((r) => r.ms));
console.log(`  statuses: ${[...new Set(all.map((r) => r.status))].join(',')}`);
console.log(`  worker computations logged: ${after - before}`);
console.log(`  distinct computedAt across 20 responses: ${stamps.length} (${stamps[0]})`);
console.log(`  response ms: min ${p(ts.min)}  max ${p(ts.max)}  — all 20 waited on the one worker`);
verdict(after - before === 1 && stamps.length === 1 && ts.min > 1000, `want exactly 1 computation over a slow read, got ${after - before}`);

// --- TEST 3: repeat inside the TTL
console.log('\nTEST 3 — repeat call inside the TTL');
const b3 = computeCount();
const r3 = await get(PORT, '/api/forecast-record?rows=9');
console.log(`  ${r3.status} in ${p(r3.ms, 2)}ms, extra computations: ${computeCount() - b3}`);
console.log(`  same computedAt as the batch: ${JSON.parse(r3.body).data.computedAt === stamps[0]}`);
verdict(r3.ms < 20 && computeCount() - b3 === 0, `want < 20ms, got ${p(r3.ms, 2)}ms`);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);

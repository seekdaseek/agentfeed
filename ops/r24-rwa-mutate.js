#!/usr/bin/env node
// ops/r24-rwa-mutate.js: negative controls by mutation (R24, item 3). For each check get_rwa_yields relies on, a scratch COPY of the tool is built with that one check removed or
// broken, and the matching test file is run against it: the run must FAIL. The real files are never touched (the copy lives in the scratch folder; node_modules is a symlink).
// A mutation whose search text is not found exactly once is itself a failure of this script (it would prove nothing). The unmutated copy must PASS first.
//   node ops/r24-rwa-mutate.js [--only <substring of a mutation name>]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ROOT = process.env.R24_RWA_MUT_DIR || '/Volumes/D/r24/scratch/rwa-t3/mut';
const UNIT = 'test/r24-rwa.test.js';
const SNAP = 'test/r24-rwa-snapshots.test.js';
const RPC = 'tools/r24/rwa/rpc.js';
const RDR = 'tools/r24/rwa/reader.js';
const EVAL = 'tools/r24/rwa/evaluate.js';
const SNP = 'tools/r24/rwa/snapshots.js';
const YLD = 'tools/r24/rwa/yield.js';
const IDX = 'tools/r24/rwa/index.js';
const BIN = 'bin/r24-rwa-snapshot.js';

// [name, file, find, replace, test file to run]
const MUTATIONS = [
  // ---- the RPC client
  ['rpc: the streaming size cap is removed', RPC, "if (n > maxBytes) { try { await rd.cancel(); } catch { /* closed */ } return { http: 'size' }; }", '', UNIT],
  ['rpc: the content-length check is removed', RPC, "if (Number.isFinite(len) && len > maxBytes) {", 'if (false) {', UNIT],
  ['rpc: no timeout on a request', RPC, 'signal: AbortSignal.timeout(timeoutMs), ', '', UNIT],
  ['rpc: the per-call budget is not enforced', RPC, 'if (used >= budget) throw', 'if (false) throw', UNIT],
  ['rpc: the chain id is not checked', RPC, "if (!c.j || c.j.result !== '0x1') throw", 'if (false) throw', UNIT],
  ['rpc: an answer the caller rejected (wrong shape, old head) is accepted anyway', RPC, 'if (opts.accept && !opts.accept(j.result)) throw', 'if (false) throw', UNIT],
  ['rpc: a revert is treated as an endpoint failure and the next endpoint is asked', RPC, "if (code === 3 || /execution reverted/i.test(msg)) { s.fails = 0; throw Object.assign(unavailable('a contract read reverted', 300), { detail: 'revert', revert: true }); }", '', UNIT],
  ['rpc: an endpoint that cannot serve old state is counted as failing (no skip)', RPC, "{ lastKind = 'archive'; continue; }", "{ throw Object.assign(new Error('rpc'), { endpoint: true, kind: 'archive' }); }", UNIT],
  ['rpc: a failing endpoint is never left to rest', RPC, 'if (s.until > now() && !allResting) continue;', '', UNIT],
  ['rpc: when every endpoint rests, none is asked (a single endpoint stays refused for the rest period)', RPC, 'endpoints.every((_, i) => st(i).until > now())', 'false', UNIT],
  ['rpc: a head older than the limit is accepted', RPC, 'Math.abs(now() / 1000 - o.ts) <= HEAD_MAX_AGE_S', 'true', UNIT],
  ['rpc: only https endpoints are taken from the environment (plain http to a remote host allowed)', RPC, "(u.protocol === 'http:' && loop)", "(u.protocol === 'http:')", UNIT],
  ['rpc: the block search does not settle on the last block at or before the target', RPC, 'for (let k = 0; k < 6 && b.ts > targetTs && b.number > 1; k++) b = await getBlock(rpc, b.number - 1);', '', UNIT],
  ['rpc: the block search stops at the 12-second estimate', RPC, 'for (let k = 0; k < 8 && Math.abs(b.ts - targetTs) > slot; k++) {', 'for (let k = 0; k < 0 && Math.abs(b.ts - targetTs) > slot; k++) {', UNIT],
  // ---- the reader
  ['reader: a zero or negative price is believed', RDR, 'if (answer <= 0n || answer > MAX_INT255) throw', 'if (false) throw', UNIT],
  ['reader: a zero price from a plain getter is believed', RDR, 'if (w[0] <= 0n || w[0] > MAX_INT255) throw', 'if (false) throw', UNIT],
  ['reader: an update time in the future is believed', RDR, 'updatedAt > blockTs + 60) throw', 'false) throw', UNIT],
  ['reader: the decimals of a feed are not compared with the register', RDR, 'if (!w || w[0] !== BigInt(p.read.decimals)) throw', 'if (false) throw', UNIT],
  // ---- the engine
  ['engine: the latest price is not held to the product band', EVAL, 'if (!inBand(p, latest.raw)) throw outOfBand(p);', '', UNIT],
  ['engine: an old contract read is not held to the product band', EVAL, 'if (!inBand(p, v.raw)) throw outOfBand(p); return v; })();', 'return v; })();', UNIT],
  ['engine: an oracle that is not updated for too long is served', EVAL, 'if (p.staleSec != null && latest.updatedAt != null && head.ts - latest.updatedAt > p.staleSec) {', 'if (false) {', UNIT],
  ['engine: a move of more than 1 percent in a day is not flagged', EVAL, 'if (move != null && Math.abs(move - 1) > DAY_MOVE_LIMIT) flags.push(FLAG_MOVE);', '', UNIT],
  ['engine: the day-move line is 10 percent', EVAL, 'const DAY_MOVE_LIMIT = 0.01;', 'const DAY_MOVE_LIMIT = 0.1;', UNIT],
  ['engine: a burst of identical calls does not share one evaluation', EVAL, 'if (!pr) { pr = evaluateNow({ products, deps }); C.answers.set(key, pr); pr.catch(() => C.answers.delete(key)); }', 'if (true) { pr = evaluateNow({ products, deps }); }', UNIT],
  ['engine: a refused evaluation is kept for 30 seconds', EVAL, 'pr.catch(() => C.answers.delete(key)); }\n  return pr;', '}\n  return pr;', UNIT],
  ['engine: a failed history read is cached', EVAL, 'pr.catch(() => C.history.delete(k));', '', UNIT],
  ['engine: the old reads are not cached', EVAL, 'C.history.set(k, pr);', '', UNIT],
  ['engine: the history store has no size bound', EVAL, 'history: makeStore(64, HISTORY_TTL_MS)', 'history: makeStore(1e9, HISTORY_TTL_MS)', UNIT],
  ['engine: a product the caller names is not checked against the register', EVAL, 'if (!hit) throw bad(', 'if (!hit) return list.filter((p) => p.served); throw bad(', UNIT],
  ['engine: a non-string product is accepted', EVAL, "if (typeof arg !== 'string') throw bad(", "if (false) throw bad(", UNIT],
  ['engine: a product the gate dropped is still served', EVAL, 'list.filter((p) => p.served).map((p) => p.id)', 'list.map((p) => p.id)', UNIT],
  ['engine: a partial answer is returned when one product cannot be read', EVAL, 'const firstBad = out.find((o) => !o.ok);\n  if (firstBad) throw firstBad.e;\n  return out.map((o) => o.v);', 'return out.filter((o) => o.ok).map((o) => o.v);', UNIT],
  ['engine: a snapshot is believed without the band check', EVAL, 'if (s && inBand(p, s.raw)) return', 'if (s) return', SNAP],
  ['engine: snapshots are never used', EVAL, 'const s = SNAP.nearest(snapDb, p, targets[days]);', 'const s = null;', SNAP],
  ['engine: the yield is annualized over the nominal window, not the real days', EVAL, 'Y.annualized(p.convention, latest.raw, h.raw, Y.days(head.ts, h.blockTs))', 'Y.annualized(p.convention, latest.raw, h.raw, d)', UNIT],
  ['engine: the history source is always reported as snapshots', EVAL, "history_source: sources.size === 1 ? [...sources][0] : 'contract',", "history_source: 'snapshots',", SNAP],
  // ---- the arithmetic
  ['yield: the simple convention loses its annualization', YLD, 'y = (r - 1) * (365 / days);', 'y = (r - 1);', UNIT],
  ['yield: the APY convention is the simple one', YLD, 'y = Math.pow(r, 365 / days) - 1;', 'y = (r - 1) * (365 / days);', UNIT],
  ['yield: a window of zero or fewer days is computed', YLD, '|| days <= 0) return null;', ') return null;', UNIT],
  // ---- the snapshot store and the collector
  ['snapshots: a second run the same day replaces the row', SNP, 'INSERT OR IGNORE INTO rwa_snap', 'INSERT OR REPLACE INTO rwa_snap', SNAP],
  ['snapshots: a row with other decimals is believed', SNP, 'if (r.decimals !== p.read.decimals || ', 'if (', SNAP],
  ['snapshots: a row whose price is not a positive integer is believed', SNP, "|| !/^[1-9][0-9]{0,77}$/.test(String(r.price_raw))) continue;", ') continue;', SNAP],
  ['snapshots: the time tolerance is unbounded', SNP, 'block_ts BETWEEN ? AND ?', 'block_ts BETWEEN ? - 99999999 AND ? + 99999999', SNAP],
  ['snapshots: the table is not pruned', SNP, "return db.prepare('DELETE FROM rwa_snap WHERE block_ts < ?').run(nowSec - keepDays * 86400).changes;", 'return 0;', SNAP],
  ['snapshots: a non-positive price may be recorded', SNP, "if (!row || typeof row.priceRaw !== 'bigint' || row.priceRaw <= 0n) throw", 'if (false) throw', SNAP],
  ['collector: the plausibility band is not applied before a row is written', BIN, "if (!(n >= p.band[0] && n <= p.band[1])) throw Object.assign(new Error('band'), { detail: 'band' });", '', SNAP],
  ['collector: a stale oracle is recorded', BIN, "if (p.staleSec != null && v.updatedAt != null && head.ts - v.updatedAt > p.staleSec) throw", 'if (false) throw', SNAP],
  ['collector: a failed product does not change the exit code', BIN, 'return failed ? 2 : 0;', 'return 0;', SNAP],
  ['collector: --dry writes', BIN, "const db = dry ? null : SNAP.openWriter(file);", 'const db = SNAP.openWriter(file || ":memory:");', SNAP],
  ['collector: the database is never pruned', BIN, 'if (db) { const gone = SNAP.prune(db, head.ts);', 'if (false) { const gone = SNAP.prune(db, head.ts);', SNAP],
  ['collector: the rows are written with an error text that can carry a URL', BIN, "out(`${new Date(now()).toISOString()} ${p.id} FAILED ${e && e.detail ? e.detail : 'error'}`);", "out(`${new Date(now()).toISOString()} ${p.id} FAILED ${e && e.message} ${R.endpointsFrom(env).join(' ')}`);", SNAP],
  // ---- the route entry
  ['entry: the description is one that breaks the house style', IDX, "const DESC = 'Use when an agent needs the realized", "const DESC = 'Realized", UNIT],
  ['entry: the price is wrong', IDX, 'usd: 0.02,', 'usd: 0.2,', UNIT],
];

function copyTree(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const d of ['tools/r23', 'tools/r24', 'bin', 'test/fixtures/r24', 'ops']) fs.mkdirSync(path.join(dest, d), { recursive: true });
  fs.cpSync(path.join(REPO, 'tools', 'r24', 'rwa'), path.join(dest, 'tools', 'r24', 'rwa'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'tools', 'r23', 'common.js'), path.join(dest, 'tools', 'r23', 'common.js'));
  fs.copyFileSync(path.join(REPO, BIN), path.join(dest, BIN));
  fs.cpSync(path.join(REPO, 'test', 'fixtures', 'r24', 'rwa'), path.join(dest, 'test', 'fixtures', 'r24', 'rwa'), { recursive: true });
  for (const f of [UNIT, SNAP]) fs.copyFileSync(path.join(REPO, f), path.join(dest, f));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dest, 'node_modules'));
  fs.writeFileSync(path.join(dest, 'package.json'), fs.readFileSync(path.join(REPO, 'package.json')));
}
function runTests(dest, file) {
  const r = spawnSync(process.execPath, ['--test', file], { cwd: dest, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' }, timeout: 280000 });
  const pass = /^# pass (\d+)/m.exec(r.stdout) || /ℹ pass (\d+)/.exec(r.stdout); const fail = /^# fail (\d+)/m.exec(r.stdout) || /ℹ fail (\d+)/.exec(r.stdout);
  return { status: r.status, pass: pass ? Number(pass[1]) : null, fail: fail ? Number(fail[1]) : null, tail: (r.stdout || '').split('\n').filter((l) => /not ok|✖/.test(l)).slice(0, 3).join(' | ') };
}

function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  copyTree(ROOT);
  const base = {}; let bad = 0;
  for (const f of [UNIT, SNAP]) { base[f] = runTests(ROOT, f); console.log(`unmutated ${f}: exit ${base[f].status}, pass ${base[f].pass}, fail ${base[f].fail}`); if (base[f].status !== 0) { console.log('the unmutated copy must pass first'); process.exit(1); } }
  let killed = 0; let ran = 0;
  for (const [name, file, find, replace, testFile] of MUTATIONS) {
    if (only && !name.includes(only)) continue;
    const full = path.join(ROOT, file); const src = fs.readFileSync(full, 'utf8');
    const n = src.split(find).length - 1;
    if (n !== 1) { console.log(`INVALID  ${name}: search text found ${n} times in ${file}`); bad++; continue; }
    ran++;
    fs.writeFileSync(full, src.replace(find, () => replace));
    const r = runTests(ROOT, testFile);
    fs.writeFileSync(full, src);
    if (r.status !== 0) { killed++; console.log(`killed   ${name}  [${r.fail} failing: ${r.tail.slice(0, 110)}]`); } else { bad++; console.log(`SURVIVED ${name}  (the test file ${testFile} still passes with this check removed)`); }
  }
  console.log(`\n${killed} of ${ran} mutations killed; ${bad} problems`);
  process.exit(bad ? 1 : 0);
}
main();

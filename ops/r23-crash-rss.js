#!/usr/bin/env node
// ops/r23-crash-rss.js: resident-memory measurements for R23 T1.
//   node ops/r23-crash-rss.js routes [--runs 3]
//        Fresh child processes. In each: load what the real server has already loaded (zod, better-sqlite3, lib/solrpc), take rss, require tools/r23/crash-risk.js, take rss,
//        make 20 calls (10 get_crash_risk by mint and by pool, 6 get_launch_radar with limit 100, 4 get_crash_risk_record) over a 20,000-row synthetic scores.db, take rss.
//        Also the same without the preloaded dependencies, for the module-plus-dependencies total.
//   node ops/r23-crash-rss.js scorer --ledger <db> --workdir <dir> [--minutes 10] [--node-args "..."]
//        Runs ledger-score/score.js for real (real clock, the production model) against the ledger copy, samples its rss every 5 s with ps, and prints min, median, max, the last value,
//        the tick lines it logged (pools scored, ticks, milliseconds per tick) and the rss of a bare `node` for comparison. Then stops it.
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const args = (argv) => { const a = { _: [] }; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; else a._.push(argv[i]); } return a; };
const a = args(process.argv.slice(2));
const mb = (b) => Math.round((b / 1048576) * 10) / 10;
const median = (v) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];

function child(code, env = {}) {
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env } }));
}

if (a._[0] === 'routes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-crash-rss-'));
  const file = path.join(dir, 'scores.db');
  const META = require('../tools/r23/crash-model/meta.json');
  const { ensureSchema } = require('../tools/r23/crash-model/schema');
  const d = new Database(file); ensureSchema(d);
  const now = Math.floor(Date.now() / 1000), b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const id58 = (n, k) => { let s = ''; let x = n * 7919 + k * 104729 + 17; for (let i = 0; i < 43; i++) { s += b58[x % 58]; x = Math.floor(x / 58) + (i + 3) * 31 + n; } return s; };
  const ins = d.prepare('INSERT INTO scores (pool_id, mint, pool, dex, score, model_version, scored_ts, t0_ts, t0_liquidity_usd, t0_fdv_usd) VALUES (?,?,?,?,?,?,?,?,?,?)');
  d.transaction(() => { for (let i = 1; i <= 20000; i++) ins.run(i, id58(i, 1), id58(i, 2), 'pump-fun', (i % 1000) / 1000, META.model_version, now - 60 - i * 20, now - 100 - i * 20, 10000 + i, 30000 + i); })();
  const put = d.prepare('INSERT INTO meta (k, v) VALUES (?, ?)');
  put.run('last_tick_ts', String(now)); put.run('ledger_last_cycle', String(now)); put.run('current_model', META.model_version); put.run(`frozen:${META.model_version}`, JSON.stringify({ cuts: META.decile_cuts }));
  const sample = [id58(1, 1), id58(77, 1), id58(5000, 1), id58(19000, 1)], samplePools = [id58(3, 2), id58(900, 2)];
  d.close();
  const code = (preload) => `
    ${preload ? "require('zod'); require('better-sqlite3'); require('./lib/solrpc');" : ''}
    const r0 = process.memoryUsage().rss;
    const CR = require('./tools/r23/crash-risk.js');
    const h = CR.makeHandlers({ env: { LEDGER_SCORE_DB: process.env.F } });
    const r1 = process.memoryUsage().rss;
    const mints = JSON.parse(process.env.MINTS), pools = JSON.parse(process.env.POOLS);
    let n = 0;
    for (let i = 0; i < 10; i++) { h.getCrashRisk(i % 2 ? { mint: mints[i % mints.length] } : { pool: pools[i % pools.length] }); n++; }
    for (let i = 0; i < 6; i++) { h.getLaunchRadar({ limit: '100' }); n++; }
    for (let i = 0; i < 4; i++) { h.getCrashRiskRecord(); n++; }
    h.getCrashRisk({ mint: mints[0] });
    const r2 = process.memoryUsage().rss;
    console.log(JSON.stringify({ calls: n, rss_before: r0, rss_after_require: r1, rss_after_20_calls: r2 }));`;
  const env = { F: file, MINTS: JSON.stringify(sample), POOLS: JSON.stringify(samplePools) };
  const out = { runs: [] };
  for (let i = 0; i < Number(a.runs || 3); i++) {
    const warm = child(code(true), env), cold = child(code(false), env);
    out.runs.push({
      module_with_deps_already_loaded_mb: { require: mb(warm.rss_after_require - warm.rss_before), after_20_calls: mb(warm.rss_after_20_calls - warm.rss_before) },
      module_and_its_deps_cold_mb: { require: mb(cold.rss_after_require - cold.rss_before), after_20_calls: mb(cold.rss_after_20_calls - cold.rss_before) },
    });
  }
  out.scores_rows = 20000;
  console.log(JSON.stringify(out, null, 1));
  fs.rmSync(dir, { recursive: true, force: true });
} else if (a._[0] === 'scorer') {
  for (const k of ['ledger', 'workdir']) if (!a[k]) { console.error(`missing --${k}`); process.exit(2); }
  fs.mkdirSync(a.workdir, { recursive: true });
  const minutes = Number(a.minutes || 10);
  const bare = child("setTimeout(() => console.log(JSON.stringify({ rss: process.memoryUsage().rss })), 500)");
  const nodeArgs = a['node-args'] ? String(a['node-args']).split(' ').filter(Boolean) : [];
  const p = spawn(process.execPath, [...nodeArgs, path.join(ROOT, 'ledger-score', 'score.js')], { cwd: ROOT, env: { ...process.env, LEDGER_DB: a.ledger, LEDGER_SCORE_DB: path.join(a.workdir, 'scores.db') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; let buf = '';
  p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { lines.push(JSON.parse(l)); } catch { /* not JSON */ } } });
  p.stderr.on('data', (c) => process.stderr.write(c));
  const rss = []; const t0 = Date.now();
  const iv = setInterval(() => {
    try { rss.push([Date.now() - t0, Number(execFileSync('ps', ['-o', 'rss=', '-p', String(p.pid)], { encoding: 'utf8' }).trim()) / 1024]); } catch { /* exited */ }
    if (Date.now() - t0 >= minutes * 60000) {
      clearInterval(iv); p.kill('SIGTERM');
      const v = rss.map((x) => x[1]), ticks = lines.filter((l) => l.ev === 'tick');
      const idle = rss.filter((x) => x[0] > 120000).map((x) => x[1]);
      console.log(JSON.stringify({
        minutes, node_args: nodeArgs, bare_node_rss_mb: mb(bare.rss), samples: v.length,
        rss_mb: { min: Math.round(Math.min(...v) * 10) / 10, median: Math.round(median(v) * 10) / 10, max: Math.round(Math.max(...v) * 10) / 10, last: Math.round(v[v.length - 1] * 10) / 10 },
        rss_mb_after_2_minutes: idle.length ? { min: Math.round(Math.min(...idle) * 10) / 10, max: Math.round(Math.max(...idle) * 10) / 10 } : null,
        ticks_logged: ticks.length, pools_scored: ticks.reduce((s, t) => s + t.scored, 0), skipped: ticks.reduce((s, t) => s + t.skipped, 0),
        tick_ms: ticks.length ? { median: median(ticks.map((t) => t.ms)), max: Math.max(...ticks.map((t) => t.ms)) } : null,
        first_tick_at_s: ticks.length ? null : null, events: lines.filter((l) => l.ev !== 'tick').map((l) => l.ev).slice(0, 12),
        seconds_until_backlog_drained: (() => { const full = lines.filter((l) => l.ev === 'tick'); const i = full.findIndex((l, k) => !l.full && k > 0); return i < 0 ? null : Math.round((Date.parse(full[i].t) - Date.parse(lines[0].t)) / 1000); })(),
      }, null, 1));
      setTimeout(() => process.exit(0), 500);
    }
  }, 5000);
} else {
  console.error('usage: routes | scorer --ledger <db> --workdir <dir> [--minutes 10] [--node-args "..."]'); process.exit(2);
}

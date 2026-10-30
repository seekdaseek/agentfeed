// ops/refresh-resume.mjs — the resume logic of ops/bazaar-refresh.mjs, kept apart so it can be tested (R20h, 30 Oct 2026).
//
// Why: the first --pay run on 30 Oct 2026 paid three routes ($0.063) and stopped at the fourth, a 503 "Not charged". The script already kept a per-route state file and
// skipped anything paid in the last six hours, but that protection is time-limited, keyed by path alone and lost with the file. A resume must never pay a route twice:
//   * every payment is appended to a JSONL tx log (.bazaar-refresh-paid.jsonl) with the run id it belongs to, BEFORE anything else happens to the next route;
//   * with `--run <id>` a route that has a tx under that id in the log is skipped for good, whatever its age, whether or not the state file survived, and AGAIN=1
//     cannot override it (a new id is the only way to pay it again);
//   * only one run may pay at a time (a lock file with the pid; a lock whose process is gone is taken over);
//   * a 503 (the source is down, never billed) can be deferred with `--defer-503`: the run carries on with the other routes and lists the deferred ones, instead of
//     stopping at the first one; any other failure still stops the run.
'use strict';
import fs from 'node:fs';

export const SIX_H = 6 * 3600_000;

/** The paid log: one JSON object per line, {ts, run, path, tx, usd}. A line that does not parse (a write cut short) is ignored. */
export function loadPaidLog(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && e.path && e.tx) out.push(e); } catch { /* a partial last line */ }
  }
  return out;
}

export function appendPaid(file, entry) {
  // a file that does not end in a newline holds a write that was cut short: start a new line, or this entry would be glued to the fragment and lost
  let prefix = '';
  try {
    const size = fs.statSync(file).size;
    if (size > 0) { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); fs.closeSync(fd); if (b[0] !== 10) prefix = '\n'; }
  } catch { /* no file yet */ }
  fs.appendFileSync(file, prefix + JSON.stringify(entry) + '\n');
}

/**
 * Which planned routes to pay now.
 *   plan: [{ m: { path }, ... }]   state: { path: { ts, tx } }   paidLog: entries   run: id or null   now: ms   again: boolean
 * -> { todo, skipped: [{ path, why: 'run' | 'recent', tx, ts, minutes }] }
 */
export function decide({ plan, state = {}, paidLog = [], run = null, now = Date.now(), sixH = SIX_H, again = false }) {
  const todo = [];
  const skipped = [];
  for (const p of plan) {
    const path = p.m.path;
    if (run) {
      const done = paidLog.find((e) => e.run === run && e.path === path);
      if (done) { skipped.push({ path, why: 'run', tx: done.tx, ts: done.ts, minutes: Math.round((now - done.ts) / 60000) }); continue; }
    }
    const prior = state[path];
    if (prior && now - prior.ts < sixH && !again) { skipped.push({ path, why: 'recent', tx: prior.tx, ts: prior.ts, minutes: Math.round((now - prior.ts) / 60000) }); continue; }
    todo.push(p);
  }
  return { todo, skipped };
}

/** Copy the state-file entries paid at or after `sinceMs` into the paid log under `run` (idempotent: an entry already in the log is not added again). */
export function adopt({ stateFile, logFile, run, sinceMs }) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return []; }
  const have = new Set(loadPaidLog(logFile).filter((e) => e.run === run).map((e) => `${e.path}|${e.tx}`));
  const added = [];
  for (const [path, v] of Object.entries(state)) {
    if (!v || !v.tx || v.ts < sinceMs || have.has(`${path}|${v.tx}`)) continue;
    const entry = { ts: v.ts, run, path, tx: v.tx, usd: v.usd, adopted: true };
    appendPaid(logFile, entry); added.push(entry);
  }
  return added;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** One payer at a time. Throws if a live process holds the lock; takes over a lock whose process is gone. Returns release(). */
export function acquireLock(file, { pid = process.pid, now = Date.now } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid, since: new Date(now()).toISOString() }));
      fs.closeSync(fd);
      return () => { try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur.pid === pid) fs.unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: treat as stale */ }
      if (cur.pid && alive(cur.pid) && cur.pid !== pid) throw Object.assign(new Error(`another bazaar-refresh run is paying (pid ${cur.pid} since ${cur.since}); lock ${file}`), { locked: true });
      try { fs.unlinkSync(file); } catch { /* raced: try again */ }
    }
  }
  throw new Error(`could not take the lock ${file}`);
}

/** What one route's client run means: 'paid' (200 and a settlement tx), 'deferred' (503 and deferral on), or 'stop'. */
export function classifyOutcome({ status, tx, defer503 }) {
  if (status === '200' && tx) return 'paid';
  if (status === '503' && defer503) return 'deferred';
  return 'stop';
}

export const solscan = (tx) => `https://solscan.io/tx/${tx}`;

// `node ops/refresh-resume.mjs --adopt <state.json> <paid.jsonl> <run> <sinceISO>`: seed a run with payments an earlier invocation already made (after you have checked them on-chain).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2] === '--adopt') {
  const [, , , stateFile, logFile, run, since] = process.argv;
  const sinceMs = Date.parse(since);
  if (!stateFile || !logFile || !run || !Number.isFinite(sinceMs)) { console.error('usage: node ops/refresh-resume.mjs --adopt <state.json> <paid.jsonl> <run> <sinceISO>'); process.exit(2); }
  const added = adopt({ stateFile, logFile, run, sinceMs });
  for (const e of added) console.log(`adopted ${e.path} $${e.usd} ${solscan(e.tx)}`);
  console.log(`${added.length} payment(s) adopted into run ${run}`);
}

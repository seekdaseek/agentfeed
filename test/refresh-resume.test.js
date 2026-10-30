// R20h (30 Oct 2026): ops/bazaar-refresh.mjs can be resumed without ever paying a route twice (ops/refresh-resume.mjs).
// What happened: the first --pay run paid three routes ($0.063) and stopped at the fourth, a 503 "Not charged". The old protection was a 6-hour skip by path in a state
// file. Unit level: the decision, the log, the adoption of earlier payments, the lock. End to end: the REAL script as a subprocess against stub servers and a fake
// payment client (nothing is paid, nothing leaves 127.0.0.1): stop, resume, resume after the state file is lost, a second run id, the lock.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-'));
let R;
test.before(async () => { R = await import('../ops/refresh-resume.mjs'); });

const NOW = Date.parse('2026-10-30T12:00:00Z');
const planOf = (...paths) => paths.map((p) => ({ m: { path: p, price: 0.005 } }));

test('decide: a route with a tx under this run id is skipped whatever its age, a recent state entry is skipped for six hours, AGAIN lifts only the second', () => {
  const log = [{ ts: NOW - 20 * 86400e3, run: 'r1', path: '/api/a', tx: 'TXA' }, { ts: NOW - 60_000, run: 'other', path: '/api/b', tx: 'TXB' }];
  const state = { '/api/c': { ts: NOW - 3600e3, tx: 'TXC' }, '/api/d': { ts: NOW - 7 * 3600e3, tx: 'TXD' } };
  const d = R.decide({ plan: planOf('/api/a', '/api/b', '/api/c', '/api/d', '/api/e'), state, paidLog: log, run: 'r1', now: NOW });
  assert.deepEqual(d.todo.map((p) => p.m.path), ['/api/b', '/api/d', '/api/e'], 'a (this run), c (paid an hour ago) skipped; b is another run\'s, d is older than six hours');
  assert.deepEqual(d.skipped.map((s) => [s.path, s.why]), [['/api/a', 'run'], ['/api/c', 'recent']]);
  assert.equal(d.skipped[0].minutes, 20 * 24 * 60);
  const again = R.decide({ plan: planOf('/api/a', '/api/c'), state, paidLog: log, run: 'r1', now: NOW, again: true });
  assert.deepEqual(again.todo.map((p) => p.m.path), ['/api/c'], 'AGAIN pays the recent one again but never a route already paid in the run');
  const none = R.decide({ plan: planOf('/api/a'), state: {}, paidLog: log, run: null, now: NOW });
  assert.equal(none.todo.length, 1, 'without a run id the log is not consulted (the old behaviour)');
});

test('the paid log: append-only JSONL, a half-written last line is ignored, and adoption copies recent payments once', () => {
  const dir = tmp(); const logFile = path.join(dir, 'paid.jsonl'); const stateFile = path.join(dir, 'state.json');
  assert.deepEqual(R.loadPaidLog(logFile), [], 'no file: no entries');
  R.appendPaid(logFile, { ts: 1, run: 'r', path: '/api/x', tx: 'T1', usd: 0.005 });
  fs.appendFileSync(logFile, '{"ts":2,"run":"r","path":"/api/y","tx":"T2"');   // a write cut short
  assert.deepEqual(R.loadPaidLog(logFile).map((e) => e.tx), ['T1']);
  R.appendPaid(logFile, { ts: 3, run: 'r', path: '/api/z', tx: 'T3', usd: 0.005 });
  assert.deepEqual(R.loadPaidLog(logFile).map((e) => e.tx), ['T1', 'T3'], 'an entry written after a cut-short line is not glued to it');
  fs.writeFileSync(stateFile, JSON.stringify({ '/api/old': { ts: NOW - 20 * 86400e3, tx: 'OLD', usd: 0.01 }, '/api/new1': { ts: NOW - 600e3, tx: 'N1', usd: 0.008 }, '/api/new2': { ts: NOW - 300e3, tx: 'N2', usd: 0.05 } }));
  const added = R.adopt({ stateFile, logFile, run: 'r2', sinceMs: NOW - 3600e3 });
  assert.deepEqual(added.map((e) => e.path), ['/api/new1', '/api/new2'], 'only the payments since the cut-off');
  assert.deepEqual(R.adopt({ stateFile, logFile, run: 'r2', sinceMs: NOW - 3600e3 }), [], 'adopting twice adds nothing');
  assert.equal(R.loadPaidLog(logFile).filter((e) => e.run === 'r2').length, 2);
});

test('the lock: a second payer is refused while the first lives, a dead payer\'s lock is taken over, release removes only your own', () => {
  const dir = tmp(); const lock = path.join(dir, 'l.lock');
  const release = R.acquireLock(lock, { pid: process.pid });
  assert.throws(() => R.acquireLock(lock, { pid: process.pid + 1 }), (e) => e.locked === true && /another bazaar-refresh run is paying/.test(e.message));
  release();
  assert.ok(!fs.existsSync(lock), 'released');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 - 7, since: 'x' }));   // a pid that does not exist
  const r2 = R.acquireLock(lock, { pid: process.pid });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid, 'taken over');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid + 99999, since: 'y' }));   // someone else holds it now: release must not delete it
  r2();
  assert.ok(fs.existsSync(lock), 'a release never deletes another process\'s lock');
});

test('outcomes: only a 200 with a settlement tx is paid; a 503 is deferred only when asked; everything else stops the run', () => {
  const c = R.classifyOutcome;
  assert.equal(c({ status: '200', tx: 'T', defer503: false }), 'paid');
  assert.equal(c({ status: '200', tx: null, defer503: true }), 'stop', 'a 200 with no settlement is not a payment');
  assert.equal(c({ status: '503', tx: null, defer503: true }), 'deferred');
  assert.equal(c({ status: '503', tx: null, defer503: false }), 'stop');
  for (const st of ['400', '402', '500', null]) assert.equal(c({ status: st, tx: null, defer503: true }), 'stop', String(st));
  assert.equal(R.solscan('ABC'), 'https://solscan.io/tx/ABC');
});

// ---- the real script, end to end -------------------------------------------------------------------------------------------------------------------------------
const TREASURY = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ROUTES = [['/api/time', '/api/time', 0.005], ['/api/perp', '/api/perp', 0.005], ['/api/token-risk/:mint', `/api/token-risk/${MINT}`, 0.01], ['/api/funding-rate', '/api/funding-rate', 0.005]];

function startOrigin({ records = [] } = {}) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const origin = `http://127.0.0.1:${srv.address().port}`;
    if (u.pathname === '/.well-known/x402.json') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ resources: ROUTES.map(([pattern, concrete, usd]) => ({ resource: origin + concrete, ...(pattern.includes(':') ? { resource_template: origin + pattern.replace(/:(\w+)/, '{$1}') } : {}), price_usd: usd })) }));
    }
    if (u.pathname.startsWith('/cdp/discovery/merchant')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ resources: records.map((r) => ({ ...r, resource: origin + r.path })), pagination: { total: records.length } })); }
    const hit = ROUTES.find(([, concrete]) => concrete === u.pathname);
    if (hit) {
      const pr = { x402Version: 2, resource: { url: origin + hit[1], description: 'live ' + hit[1] }, accepts: [{ scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: String(Math.round(hit[2] * 1e6)), payTo: TREASURY }] };
      res.statusCode = 402; res.setHeader('payment-required', Buffer.from(JSON.stringify(pr)).toString('base64')); return res.end('{}');
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

/** a work dir with a fake test-client.mjs: it "pays" a URL by printing what the real client prints, and logs every call; behaviour.json says which URLs answer 503 */
function workDir() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'behaviour.json'), '{}');
  fs.writeFileSync(path.join(dir, 'test-client.mjs'), `
import fs from 'node:fs';
const url = process.argv[2];
fs.appendFileSync('calls.log', url + '\\n');
const b = JSON.parse(fs.readFileSync('behaviour.json', 'utf8'));
const down = Object.keys(b).find((k) => url.includes(k) && b[k] === '503');
if (down) { console.log('status: 503'); console.log('{"error":"solana rpc http 429. Not charged."}'); process.exit(0); }
const n = fs.readFileSync('calls.log', 'utf8').split('\\n').filter(Boolean).length;
console.log('status: 200');
console.log(JSON.stringify({ transaction: 'SIG' + n + '_' + new URL(url).pathname.replace(/\\W+/g, '_') }, null, 2).replace('"transaction":', '"transaction":'));
`);
  fs.writeFileSync(path.join(dir, 'payer.json'), '[]');
  return dir;
}
const calls = (dir) => { try { return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((u) => new URL(u).pathname); } catch { return []; } };
function runScript(dir, origin, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'ops', 'bazaar-refresh.mjs'), ...args], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ORIGIN: origin, CDP_BASE: origin + '/cdp', PAYER: './payer.json', RETRY_WAIT_MS: '10', ...env } });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

test('the real script: a run that meets a 503 pays the others, defers that one and exits 5; the same command later pays ONLY it, even with the state file gone', async () => {
  const { srv, url } = await startOrigin();
  const dir = workDir();
  try {
    const flags = ['--pay', '--run', 'r1', '--defer-503'];
    fs.writeFileSync(path.join(dir, 'behaviour.json'), JSON.stringify({ '/api/token-risk/': '503' }));
    const r1 = await runScript(dir, url, flags);
    assert.equal(r1.code, 5, r1.out.slice(-800));
    assert.match(r1.out, /DEFERRED 1 route\(s\)/);
    assert.match(r1.out, /https:\/\/solscan\.io\/tx\/SIG/, 'every payment prints its Solscan link');
    assert.equal(R.loadPaidLog(path.join(dir, '.bazaar-refresh-paid.jsonl')).filter((e) => e.run === 'r1').length, 3, 'three payments are in the tx log under r1');
    const first = calls(dir);
    assert.equal(first.filter((p) => p.startsWith('/api/token-risk')).length, 2, 'the 503 route was tried twice (the free retry) and billed nothing');
    assert.equal(first.length, 5);

    // the source is back; the state file is LOST; the same command again
    fs.writeFileSync(path.join(dir, 'behaviour.json'), '{}');
    fs.unlinkSync(path.join(dir, '.bazaar-refresh-state.json'));
    const r2 = await runScript(dir, url, flags);
    assert.equal(r2.code, 0, r2.out.slice(-800));
    assert.match(r2.out, /run r1: 3 route\(s\) already paid in this run, 1 to go/);
    assert.deepEqual(calls(dir).slice(first.length), ['/api/token-risk/' + MINT], 'exactly one more payment, the deferred route; none of the three is paid again');

    // everything is paid: another resume, with AGAIN=1 for good measure, pays nothing
    const r3 = await runScript(dir, url, flags, { AGAIN: '1' });
    assert.equal(r3.code, 0);
    assert.match(r3.out, /nothing to pay/);
    assert.equal(calls(dir).length, first.length + 1, 'no new payment: AGAIN does not lift the run\'s tx log');

    // a NEW run id is a new decision: it pays everything again
    fs.unlinkSync(path.join(dir, '.bazaar-refresh-state.json'));
    const r4 = await runScript(dir, url, ['--pay', '--run', 'r2']);
    assert.equal(r4.code, 0, r4.out.slice(-600));
    assert.equal(calls(dir).length, first.length + 1 + 4);
  } finally { srv.close(); }
});

test('the real script: without --defer-503 a 503 still stops the run at once (and the three payments before it are in the log)', async () => {
  const { srv, url } = await startOrigin();
  const dir = workDir();
  try {
    fs.writeFileSync(path.join(dir, 'behaviour.json'), JSON.stringify({ '/api/token-risk/': '503' }));
    const r = await runScript(dir, url, ['--pay', '--run', 'r1']);
    assert.equal(r.code, 1);
    assert.match(r.out, /STOPPED at \/api\/token-risk\/:mint/);
    assert.deepEqual(R.loadPaidLog(path.join(dir, '.bazaar-refresh-paid.jsonl')).map((e) => e.path), ['/api/time', '/api/perp'], 'the two payments before the stop are in the log, none after it');
  } finally { srv.close(); }
});

test('the real script: a live lock refuses a second payer before anything is signed; a dead payer\'s lock is taken over', async () => {
  const { srv, url } = await startOrigin();
  const dir = workDir();
  try {
    fs.writeFileSync(path.join(dir, '.bazaar-refresh-state.json.lock'), JSON.stringify({ pid: process.pid, since: 'now' }));   // this test process is alive
    const locked = await runScript(dir, url, ['--pay', '--run', 'r1']);
    assert.equal(locked.code, 6, locked.out.slice(-400));
    assert.match(locked.out, /another bazaar-refresh run is paying/);
    assert.deepEqual(calls(dir), [], 'nothing was paid');
    fs.writeFileSync(path.join(dir, '.bazaar-refresh-state.json.lock'), JSON.stringify({ pid: 2 ** 22 - 9, since: 'long ago' }));
    const ok = await runScript(dir, url, ['--pay', '--run', 'r1']);
    assert.equal(ok.code, 0, ok.out.slice(-400));
    assert.equal(calls(dir).length, 4);
    assert.ok(!fs.existsSync(path.join(dir, '.bazaar-refresh-state.json.lock')), 'the lock is released at exit');
  } finally { srv.close(); }
});

test('the real script: a record keyed by the route template is judged by its description like any other: fresh = nothing to pay, stale = planned, no record = ABSENT (R20i)', async () => {
  for (const [label, description, expectPlanned] of [['fresh', `live /api/token-risk/${MINT}`, false], ['stale', 'an older description', true]]) {
    const { srv, url } = await startOrigin({ records: [{ path: '/api/token-risk/:mint', description }] });
    const dir = workDir();
    try {
      const r = await runScript(dir, url, []);   // dry run
      assert.equal(r.code, 0, r.out.slice(-600));
      assert.match(r.out, /1 index records are keyed by the route template/, label);
      const planned = /would pay\s+(STALE|ABSENT)\s+\$\s*0\.010\s+\S*\/api\/token-risk\//.test(r.out);
      assert.equal(planned, expectPlanned, `${label}: token-risk planned = ${planned}\n${r.out.slice(-700)}`);
      if (expectPlanned) assert.match(r.out, /would pay\s+STALE\s+\$\s*0\.010/, 'a stale template record is a STALE entry, not an ABSENT one');
      assert.match(r.out, /would pay\s+ABSENT\s+\$\s*0\.005\s+\S*\/api\/time/, `${label}: a route with no record at all is still ABSENT`);
      assert.deepEqual(calls(dir), [], 'a dry run pays nothing');
    } finally { srv.close(); }
  }
});

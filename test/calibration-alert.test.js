// ops/af-digest.js calibrationAlert (pensio round 2): from day 30 of the move-alert calibration table, one Telegram line a UTC day, through the existing send path.
// No Telegram, no network: send is a stub; the token is never in the text.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.OVERHANG_DB_PATH = process.env.OVERHANG_DB_PATH || path.join(os.tmpdir(), 'none.db');
const { calibrationAlert } = require('../ops/af-digest');

const NOW = Date.UTC(2026, 11, 5, 9, 0, 0);
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-alert-'));
const table = (days, name = 't.json') => { const f = path.join(d, name); fs.writeFileSync(f, JSON.stringify({ fetched_at: new Date(NOW - days * 86400_000 - 60_000).toISOString(), coins: {} })); return f; };
const harness = () => { const sent = []; return { sent, io: { send: async (t) => { sent.push(t); return true; }, log: () => {} } }; };

test('no line below 30 days; one line at day 30 that names the age, the 45-day refusal and the log; the token appears nowhere', async () => {
  const h = harness();
  const st = {};
  assert.equal(await calibrationAlert(st, NOW, { ...h.io, files: [table(29)] }), 0);
  assert.deepEqual(h.sent, []);
  assert.equal(await calibrationAlert(st, NOW, { ...h.io, files: [table(30)] }), 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^AgentFeed: the move-alert calibration table is 30 days old; the route refuses it after 45 \(15 days left\)\. The weekly refresh is not replacing it: read \/opt\/agentfeed\/brief-calibrate\.log/);
  assert.doesNotMatch(h.sent[0], /bot\d|api\.telegram|TG_BOT_TOKEN|token/i);
});
test('one line a UTC day: the same day sends nothing more, the next day sends again, and a failed send leaves the day unmarked so the next run tries again', async () => {
  const h = harness();
  const st = {};
  const files = [table(33)];
  assert.equal(await calibrationAlert(st, NOW, { ...h.io, files }), 1);
  assert.equal(await calibrationAlert(st, NOW + 5 * 60_000, { ...h.io, files }), 0, 'the next 5-minute run, same day');
  assert.equal(await calibrationAlert(st, NOW + 23 * 3600_000, { ...h.io, files }), 1, 'the next UTC day');
  const failing = { send: async () => false, log: () => {} };
  const st2 = {};
  assert.equal(await calibrationAlert(st2, NOW, { ...failing, files }), 0);
  assert.equal(st2.calibration && st2.calibration.day, undefined, 'a failed send marks nothing');
  assert.equal(await calibrationAlert(st2, NOW + 60_000, { ...h.io, files }), 1);
  assert.equal(h.sent.length, 3);
});
test('day 45 and beyond says the route is refusing now; no readable table at all is also one line a day; the newer of two files counts', async () => {
  const h = harness();
  assert.equal(await calibrationAlert({}, NOW, { ...h.io, files: [table(46)] }), 1);
  assert.match(h.sent[0], /is 46 days old; the route refuses it after 45 \(now: \/api\/move-alert answers 503, not billed\)/);
  const none = harness();
  assert.equal(await calibrationAlert({}, NOW, { ...none.io, files: [path.join(d, 'absent.json')] }), 1);
  assert.match(none.sent[0], /^AgentFeed: no readable move-alert calibration table, so \/api\/move-alert answers 503/);
  const two = harness();
  assert.equal(await calibrationAlert({}, NOW, { ...two.io, files: [table(40, 'old.json'), table(2, 'new.json')] }), 0, 'a fresh runtime table beside an old shipped one is fine');
  assert.deepEqual(two.sent, []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('wired into --alert: a dry run of the real CLI prints the age line for a 33-day table and nothing about calibration for a 5-day table', () => {
  const { spawnSync } = require('child_process');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-cli-'));
  const dbf = path.join(dir, 'af.db');
  const db = new Database(dbf);
  db.exec('CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL, status TEXT NOT NULL, latency_ms INTEGER, ip TEXT, error_msg TEXT, req_host TEXT, req_path TEXT, user_agent TEXT, method TEXT);');
  db.close();
  const old = Date.now() - 33 * 86400_000, young = Date.now() - 5 * 86400_000;
  const mk = (ms, name) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify({ fetched_at: new Date(ms).toISOString(), coins: {} })); return f; };
  const run = (cal) => spawnSync(process.execPath, [path.join(__dirname, '..', 'ops', 'af-digest.js'), '--alert', '--dry'], { encoding: 'utf8',
    env: { PATH: process.env.PATH, AGENTFEED_DB: dbf, AF_DIGEST_STATE: path.join(dir, 'state.json'), BRIEF_CALIBRATION: cal, OVERHANG_DB_PATH: process.env.OVERHANG_DB_PATH } });
  const a = run(mk(old, 'old.json'));
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /would send ---\nAgentFeed: the move-alert calibration table is 33 days old; the route refuses it after 45 \(12 days left\)/);
  const b = run(mk(young, 'young.json'));
  assert.doesNotMatch(b.stdout, /calibration/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

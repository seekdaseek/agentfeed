// ops/af-digest.js pensioPassAlert (2 Nov 2026): one Telegram line, then quiet for 12 hours, when the pensio-tg comp pass (the key in /opt/pensio-tg/agentfeed.key) is missing,
// revoked, expired or has under 3 days left. No Telegram, no network: send is a stub. The passes are made by the real key store (lib/keys.js grantPass), so the lookup by sha256
// is tested against the real hashing, not a copy of it. ops/pensio-pass-alert-mutate.js breaks the alert one rule at a time and requires this file to fail.
// The ROWS table is the negative control: one healthy baseline (no alert), then one mutation of it per row, each of which must alert with its own wording, or - for the rows that are
// still healthy - must not.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
process.env.OVERHANG_DB_PATH = process.env.OVERHANG_DB_PATH || path.join(os.tmpdir(), 'none.db');
const Database = require('better-sqlite3');
const { pensioPassAlert, PENSIO_KEY_FILE } = require('../ops/af-digest');
const { makeKeyStore, SIGNALS_PASS, SCHEMA, newKey } = require('../lib/keys');

const DAY = 86400e3;
const NOW = Date.UTC(2026, 10, 26, 3, 55, 0);            // 26 Nov 2026 03:55 UTC
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pensio-pass-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
let n = 0;

/** an in-memory api_keys with the real pass in it, `left` ms from expiry at NOW, and the key file the bot would read */
function world({ left = 27 * DAY, file } = {}) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const store = makeKeyStore(db, { now: () => NOW - 3 * DAY });
  const key = store.grantPass({ days: 30, allow: SIGNALS_PASS.allow, label: 'pensio-tg' });
  const prefix = key.slice(4, 12);
  const w = {
    db, key, prefix, file: path.join(dir, `key-${++n}`),
    left: (ms) => db.prepare('UPDATE api_keys SET expires_at = ?').run(NOW + ms),
    status: (s) => db.prepare('UPDATE api_keys SET status = ?').run(s),
    noExpiry: () => db.prepare('UPDATE api_keys SET expires_at = NULL').run(),
    write: (text) => fs.writeFileSync(w.file, text),
  };
  w.left(left);
  w.write(file === undefined ? key + '\n' : file);
  return w;
}
const sink = () => { const sent = [], logs = []; return { sent, logs, io: { send: async (t) => { sent.push(t); return true; }, log: (l) => logs.push(l) } }; };
const run = (w, h, state = {}, now = NOW, extra = {}) => pensioPassAlert(w.db, state, now, { keyFile: w.file, ...h.io, ...extra });

// [name, mutate(w), expected wording or null for "healthy: no alert"]
const ROWS = [
  ['baseline: 27 days left', () => {}, null],
  ['exactly 3 days left is not under 3', (w) => w.left(3 * DAY), null],
  ['3 days less 1 ms is under 3', (w) => w.left(3 * DAY - 1), (w) => new RegExp(`\\(${w.prefix}\\) has 2\\.9 days left \\(expires 2026-11-29 03:54:59Z UTC\\)`)],
  ['1 day left', (w) => w.left(DAY), (w) => new RegExp(`\\(${w.prefix}\\) has 1\\.0 days left`)],
  ['1 hour left', (w) => w.left(3600e3), /has 0\.0 days left/],
  ['expires this very millisecond', (w) => w.left(0), /expired 2026-11-26 03:55:00Z UTC/],
  ['expired 2 days ago', (w) => w.left(-2 * DAY), /expired 2026-11-24 03:55:00Z UTC/],
  ['revoked', (w) => w.status('revoked'), (w) => new RegExp(`\\(${w.prefix}\\) is revoked`)],
  ['pending', (w) => w.status('pending'), /is pending/],
  ['an active key with no expiry never expires', (w) => w.noExpiry(), null],
  ['key file missing', (w) => fs.rmSync(w.file), /is missing: .+ does not exist/],
  ['key file empty', (w) => w.write(''), /is unusable: .+ does not hold an afk_ key/],
  ['key file holds text', (w) => w.write('not a key\n'), /is unusable/],
  ['key file holds a truncated key', (w) => w.write(w.key.slice(0, 14) + '\n'), /is unusable/],
  ['key file holds a key the server never issued', (w) => w.write(newKey() + '\n'), /is unknown to the server/],
  ['key file is a directory', (w) => { fs.rmSync(w.file); fs.mkdirSync(w.file); }, /cannot be read: .+ \(EISDIR\)/],
  ['CRLF line ending is still the same key', (w) => w.write(w.key + '\r\n'), null],
  ['no line ending at all is still the same key', (w) => w.write(w.key), null],
  ['a second line in the file is ignored', (w) => w.write(w.key + '\nsomething else\n'), null],
];

for (const [name, mutate, want] of ROWS) {
  test(`row: ${name}`, async () => {
    const w = world(); mutate(w);
    const h = sink();
    const sent = await run(w, h);
    if (want == null) { assert.equal(sent, 0); assert.deepEqual(h.sent, []); return; }
    assert.equal(sent, 1);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0], /^AgentFeed: the pensio-tg comp pass /);
    assert.match(h.sent[0], typeof want === 'function' ? want(w) : want);
  });
}

test('the default key file is the one the bot reads (/opt/pensio-tg/agentfeed.key); AF_PENSIO_KEY_FILE overrides it', () => {
  const was = process.env.AF_PENSIO_KEY_FILE;
  try {
    delete process.env.AF_PENSIO_KEY_FILE;
    assert.equal(PENSIO_KEY_FILE(), '/opt/pensio-tg/agentfeed.key');
    process.env.AF_PENSIO_KEY_FILE = '/tmp/elsewhere';
    assert.equal(PENSIO_KEY_FILE(), '/tmp/elsewhere');
  } finally { if (was === undefined) delete process.env.AF_PENSIO_KEY_FILE; else process.env.AF_PENSIO_KEY_FILE = was; }
});

test('the line is one line, names the renewal and its log, and holds neither the key nor a token', async () => {
  const w = world({ left: DAY }); const h = sink();
  await run(w, h);
  const t = h.sent[0];
  assert.equal(t.includes('\n'), false);
  assert.match(t, /renew-pass\.sh/); assert.match(t, /renew\.log/); assert.match(t, /next reminder in 12 hours/);
  assert.equal(t.includes(w.key), false);
  assert.equal(t.includes(w.key.slice(4)), false);
  assert.doesNotMatch(t, /bot\d|api\.telegram|TG_BOT_TOKEN|token/i);
});

test('quiet for 12 hours: nothing at +5 min or +11 h 59 min, one more at +12 h', async () => {
  const w = world({ left: 2 * DAY }); const h = sink(); const st = {};
  assert.equal(await run(w, h, st, NOW), 1);
  assert.equal(await run(w, h, st, NOW + 5 * 60e3), 0);
  assert.equal(await run(w, h, st, NOW + 12 * 3600e3 - 60e3), 0);
  assert.equal(h.sent.length, 1);
  assert.equal(await run(w, h, st, NOW + 12 * 3600e3), 1);
  assert.equal(h.sent.length, 2);
  assert.equal(await run(w, h, st, NOW + 12 * 3600e3 + 5 * 60e3), 0);
});

test('a failed send leaves the state alone, so the next run (5 min later) tries again', async () => {
  const w = world({ left: DAY }); const st = {};
  assert.equal(await run(w, { io: { send: async () => false, log: () => {} } }, st), 0);
  assert.equal(st.pensioPass && st.pensioPass.alertedAt, undefined);
  const h = sink();
  assert.equal(await run(w, h, st, NOW + 5 * 60e3), 1);
  assert.equal(h.sent.length, 1);
  assert.equal(st.pensioPass.alertedAt, NOW + 5 * 60e3);
});

test('a healthy pass clears the state, so the next problem alerts at once instead of waiting out the 12 hours', async () => {
  const w = world({ left: DAY }); const h = sink(); const st = {};
  assert.equal(await run(w, h, st, NOW), 1);
  w.left(27 * DAY);                                                  // renewed
  assert.equal(await run(w, h, st, NOW + 60e3), 0);
  assert.equal('pensioPass' in st, false);
  w.status('revoked');                                               // a new problem one minute later
  assert.equal(await run(w, h, st, NOW + 120e3), 1);
  assert.equal(h.sent.length, 2);
});

test('an api_keys table that cannot be read is logged and is not a missing pass: nothing sent, state untouched', async () => {
  const w = world();
  const bare = new Database(':memory:');                             // no api_keys table
  const h = sink(); const st = {};
  assert.equal(await pensioPassAlert(bare, st, NOW, { keyFile: w.file, ...h.io }), 0);
  assert.deepEqual(h.sent, []); assert.deepEqual(st, {});
  assert.match(h.logs.join('\n'), /api_keys unreadable .*nothing checked/);
  // the file is checked first: a missing file alerts even when the table is absent
  fs.rmSync(w.file);
  assert.equal(await pensioPassAlert(bare, st, NOW, { keyFile: w.file, ...h.io }), 1);
  assert.match(h.sent[0], /is missing/);
});

test('warnDays moves the line (the dry test on the box): a 27-day pass alerts under 30 days and not under 20', async () => {
  const w = world(); const a = sink(), b = sink();
  assert.equal(await run(w, a, {}, NOW, { warnDays: 30 }), 1);
  assert.match(a.sent[0], /has 27\.0 days left/);
  assert.equal(await run(w, b, {}, NOW, { warnDays: 20 }), 0);
});

test('wired into --alert: a dry run of the real CLI prints the line for a missing file and for a pass under the line, and nothing for a healthy one; it never prints the key and writes no state', () => {
  const dbf = path.join(dir, 'af.db');
  const db = new Database(dbf);
  db.exec('CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL, status TEXT NOT NULL, latency_ms INTEGER, ip TEXT, error_msg TEXT, req_host TEXT, req_path TEXT, user_agent TEXT, method TEXT);');
  db.exec(SCHEMA);
  const key = makeKeyStore(db, {}).grantPass({ days: 30, allow: SIGNALS_PASS.allow, label: 'pensio-tg' });
  db.close();
  const keyFile = path.join(dir, 'cli-key'); fs.writeFileSync(keyFile, key + '\n');
  const state = path.join(dir, 'cli-state.json');
  const cli = (env) => spawnSync(process.execPath, [path.join(__dirname, '..', 'ops', 'af-digest.js'), '--alert', '--dry'], { encoding: 'utf8',
    env: { PATH: process.env.PATH, AGENTFEED_DB: dbf, AF_DIGEST_STATE: state, OVERHANG_DB_PATH: process.env.OVERHANG_DB_PATH, AF_MANIFEST_URL: 'http://127.0.0.1:9/x', ...env } });
  const healthy = cli({ AF_PENSIO_KEY_FILE: keyFile });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.doesNotMatch(healthy.stdout, /pensio-tg/);
  const missing = cli({ AF_PENSIO_KEY_FILE: path.join(dir, 'no-such-key') });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /would send ---\nAgentFeed: the pensio-tg comp pass is missing: .*no-such-key does not exist\./);
  const low = cli({ AF_PENSIO_KEY_FILE: keyFile, AF_PENSIO_WARN_DAYS: '60' });
  assert.equal(low.status, 0, low.stderr);
  assert.match(low.stdout, /AgentFeed: the pensio-tg comp pass \(\w{8}\) has 29\.9 days left/);
  for (const r of [healthy, missing, low]) { assert.equal(r.stdout.includes(key), false); assert.equal(r.stderr.includes(key), false); }
  assert.equal(fs.existsSync(state), false, '--dry writes no state');
});

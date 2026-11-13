// R25 (13 Nov 2026): the free /api/status and /status (lib/status.js). Gates G1.2 (every registry entry flips ok on its own), G1.3 (forbidden-field grep with a positive
// control), G1.4 (free, no-store, docs bucket, 30 s cache) and the registry guard live here; the live-box SQL comparison (G1.1) is ops-side.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const { makeStatus, VENUES, COLLECTORS } = require('../lib/status');
const { makeRateLimiter } = require('../lib/ratelimit');

const T0 = Date.parse('2026-11-13T12:00:00Z');
const ROOT = path.join(__dirname, '..');

// ---- a scratch world: every source a real file or a real SQLite database, written with the clock the test controls -----------------------------------------------------
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
  const p = (n) => path.join(dir, n);
  const env = { LIQ_DB: p('liq.db'), FUNDING_RADAR_SNAPSHOT: p('funding-radar.json'), HL_OI_DB: p('hl-oi.db'), MACRO_SNAPSHOT: p('macro.json'), BASE_LAUNCHES_SNAPSHOT: p('base-launches.json'),
    HL_WHALES_SNAPSHOT: p('hl-whales.json'), PEG_ONCHAIN_DB: p('peg-onchain.db'), JITO_TIPS_FILE: p('jito-tips.json'), SANCTIONS_FILE: p('sanctions.json'), DISPOSABLE_FILE: p('disposable.txt'),
    PEGWATCH_DB: p('pegwatch.db'), CALIPER_RECORD_DB: p('record.db'), R24_RWA_DB: p('rwa.db') };
  const dbs = { 'hl-oi': ['HL_OI_DB', 'hl_oi', 'ts', 1000], 'peg-collect': ['PEG_ONCHAIN_DB', 'ticks', 'ts', 1000], pegwatch: ['PEGWATCH_DB', 'ticks', 'ts', 1000],
    'caliper-forecast': ['CALIPER_RECORD_DB', 'forecasts', 'window_start', 1], 'rwa-snapshots': ['R24_RWA_DB', 'rwa_snap', 'block_ts', 1000] };
  const files = { 'funding-radar': 'FUNDING_RADAR_SNAPSHOT', macro: 'MACRO_SNAPSHOT', 'base-launches': 'BASE_LAUNCHES_SNAPSHOT', 'hl-whales': 'HL_WHALES_SNAPSHOT', 'jito-tips': 'JITO_TIPS_FILE',
    sanctions: 'SANCTIONS_FILE', disposable: 'DISPOSABLE_FILE' };
  const liq = new Database(env.LIQ_DB);
  liq.exec('CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT, side TEXT, size REAL, price REAL, usd REAL, exchange TEXT NOT NULL DEFAULT \'bybit\')');
  const opened = {};
  for (const [name, [e, table, col]] of Object.entries(dbs)) { opened[name] = new Database(env[e]); opened[name].exec(`CREATE TABLE ${table} (${col} INTEGER NOT NULL)`); }
  const w = {
    dir, env,
    /** one entry (venue or collector) completes a write at time t (ms) */
    write(name, t) {
      if (VENUES.some((v) => v.venue === name)) { liq.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd, exchange) VALUES (?, \'X\', \'Buy\', 1, 1, 1, ?)').run(t, name); return; }
      if (dbs[name]) { const [, table, col, unit] = dbs[name]; opened[name].prepare(`INSERT INTO ${table} (${col}) VALUES (?)`).run(Math.round(t / unit)); return; }
      const f = env[files[name]]; fs.writeFileSync(f, '{}'); fs.utimesSync(f, t / 1000, t / 1000);
    },
    writeAll(t, except = []) { for (const n of w.names) if (!except.includes(n)) w.write(n, t); },
    names: [...VENUES.map((v) => v.venue), ...COLLECTORS.map((c) => c.name)],
    close() { liq.close(); for (const d of Object.values(opened)) d.close(); },
  };
  return w;
}
const limitOf = (name) => { const v = VENUES.find((x) => x.venue === name); if (v) return v.maxAgeS; const c = COLLECTORS.find((x) => x.name === name); return c.maxAgeS === null ? require('../lib/jito-age').MAX_AGE_S() : c.maxAgeS; };
const entry = (body, name) => body.venues.find((x) => x.venue === name) || body.collectors.find((x) => x.name === name);
function service(w, clock) { return makeStatus({ env: w.env, now: () => clock.t, cacheMs: 0, uptimeS: () => 5, version: '9.9.9' }); }

// ---- G1.3 forbidden fields ----------------------------------------------------------------------------------------------------------------------------------------------
const FORBIDDEN = [
  ['base58 address', /[1-9A-HJ-NP-Za-km-z]{32,44}/], ['EVM address', /0x[0-9a-fA-F]{40}/], ['IPv4', /\b\d{1,3}(\.\d{1,3}){3}\b/], ['IPv6', /[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){3,7}/],
  ['key', /afk_[A-Za-z0-9]/], ['word', /wallet|payer|revenue|payto|treasury|secret|password|bearer|private|apikey|api_key|api-key|signature/i],
  ['path', /\/(opt|root|home|Users|Volumes|var|etc|tmp)\//], ['file name', /\.(db|sqlite|json|txt|log)\b/], ['backslash', /\\/], ['e-mail', /\S+@\S+/],
];
const stripIso = (s) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '');
const hits = (body) => { const s = stripIso(JSON.stringify(body)); return FORBIDDEN.filter(([, re]) => re.test(s)).map(([n]) => n); };

test('G1.3 positive control: a seeded response containing one of each forbidden thing trips every pattern', () => {
  const seeded = { a: 'So11111111111111111111111111111111111111112', b: '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6', c: '167.233.69.154', d: '2a01:4f8:c015:eb5e::1:2:3:4', e: 'afk_abc',
    f: 'wallet', g: '/opt/agentfeed/x', h: 'liq.db', i: 'a\\b', j: 'me@example.com' };
  assert.deepEqual(hits(seeded).sort(), FORBIDDEN.map(([n]) => n).sort());
  assert.deepEqual(hits({ as_of: '2026-11-13T12:00:00.000Z', problems: [] }), [], 'an ISO timestamp is not an IPv6 address');
});

// ---- registry guard --------------------------------------------------------------------------------------------------------------------------------------------------------
test('registry guard: every environment name this module reads is the owning tool\'s own', () => {
  const owner = { FUNDING_RADAR_SNAPSHOT: 'tools/fundingradar.js', HL_OI_DB: 'lib/hl-oi.js', MACRO_SNAPSHOT: 'tools/macro.js', BASE_LAUNCHES_SNAPSHOT: 'tools/baselaunches.js', HL_WHALES_SNAPSHOT: 'tools/hlwhales.js',
    PEG_ONCHAIN_DB: 'tools/pegonchain.js', JITO_TIPS_FILE: 'tools/solana2.js', SANCTIONS_FILE: 'tools/sanctions.js', DISPOSABLE_FILE: 'tools/emailverify.js', PEGWATCH_DB: 'tools/peg.js',
    CALIPER_RECORD_DB: 'tools/cascade-forecast.js', R24_RWA_DB: 'bin/r24-rwa-snapshot.js', LIQ_DB: 'tools/liqdb.js' };
  for (const [name, f] of Object.entries(owner)) assert.ok(fs.readFileSync(path.join(ROOT, f), 'utf8').includes(name), `${name} appears in ${f}`);
  const mine = fs.readFileSync(path.join(ROOT, 'lib/status.js'), 'utf8');
  for (const name of Object.keys(owner)) assert.ok(mine.includes(name), `${name} is read by lib/status.js`);
  assert.equal(VENUES.length + COLLECTORS.length, 15);
  assert.equal(COLLECTORS.find((c) => c.name === 'jito-tips').maxAgeS, null, 'jito-tips takes its limit from lib/jito-age.js at request time');
});

// ---- G1.2 every entry flips on its own ------------------------------------------------------------------------------------------------------------------------------------
test('G1.2 healthy: all 15 entries fresh gives ok true, an empty problems list, and no forbidden field', () => {
  const w = world(); const clock = { t: T0 };
  try {
    w.writeAll(T0); const b = service(w, clock).snapshot();
    assert.equal(b.ok, true); assert.deepEqual(b.problems, []); assert.equal(b.venues.length, 3); assert.equal(b.collectors.length, 12);
    assert.deepEqual(hits(b), []);
    assert.equal(b.service.version, '9.9.9'); assert.equal(b.service.uptime_s, 5);
    for (const n of w.names) assert.equal(entry(b, n).ok, true, n);
    assert.equal(entry(b, 'binance').events_last_hour, 1);
  } finally { w.close(); }
});

for (const name of [...VENUES.map((v) => v.venue), ...COLLECTORS.map((c) => c.name)]) {
  test(`G1.2 ${name}: stopping it alone flips ok to false and names it; the others stay ok; the limit itself is still ok`, () => {
    const w = world(); const clock = { t: T0 };
    try {
      const L = limitOf(name);
      w.writeAll(T0);
      const svc = service(w, clock);
      // at exactly the limit: ok (the others keep writing at that moment, this one does not)
      clock.t = T0 + L * 1000; w.writeAll(clock.t, [name]);
      let b = svc.snapshot();
      assert.equal(entry(b, name).age_s, L); assert.equal(entry(b, name).ok, true, 'age == limit is ok'); assert.equal(b.ok, true);
      // one second over: not ok, named, alone
      clock.t = T0 + (L + 1) * 1000; w.writeAll(clock.t, [name]);
      b = svc.snapshot();
      assert.equal(b.ok, false); assert.equal(entry(b, name).ok, false); assert.equal(entry(b, name).age_s, L + 1);
      assert.equal(b.problems.length, 1); assert.match(b.problems[0], new RegExp(`^(venue|collector) ${name}: `));
      for (const n of w.names) if (n !== name) assert.equal(entry(b, n).ok, true, `${n} stays ok`);
      assert.deepEqual(hits(b), [], 'no forbidden field in a stopped response');
    } finally { w.close(); }
  });
}

test('G1.2 an unreadable or missing source is that entry\'s own "unreadable" (ok false), never a throw, and leaks no path or error text', () => {
  const w = world(); const clock = { t: T0 };
  try {
    w.writeAll(T0);
    const env = { ...w.env, FUNDING_RADAR_SNAPSHOT: path.join(w.dir, 'missing.json'), HL_OI_DB: path.join(w.dir, 'missing.db'), LIQ_DB: path.join(w.dir, 'missing-liq.db') };
    const b = makeStatus({ env, now: () => clock.t, cacheMs: 0 }).snapshot();
    assert.equal(b.ok, false);
    for (const n of ['funding-radar', 'hl-oi', 'binance', 'bybit', 'okx']) { const e = entry(b, n); assert.equal(e.ok, false, n); assert.equal(e.error, 'unreadable'); assert.equal(e.age_s, null); }
    assert.ok(b.problems.includes('collector hl-oi: unreadable') && b.problems.includes('venue okx: unreadable'));
    assert.deepEqual(hits(b), []);
    assert.equal(entry(b, 'macro').ok, true, 'a readable source is unaffected');
  } finally { w.close(); }
});

test('G1.2 a venue with no rows at all is "no events", not ok', () => {
  const w = world(); const clock = { t: T0 };
  try { w.writeAll(T0, ['okx']); const b = service(w, clock).snapshot(); assert.equal(b.ok, false); assert.equal(entry(b, 'okx').ok, false); assert.equal(entry(b, 'okx').last_event_at, null); assert.ok(b.problems.includes('venue okx: no events')); } finally { w.close(); }
});

test('G1.2 events_last_hour counts only the last hour of that venue', () => {
  const w = world(); const clock = { t: T0 };
  try {
    w.write('binance', T0 - 3_600_001); w.write('binance', T0 - 3_599_999); w.write('binance', T0 - 10); w.write('bybit', T0 - 10); w.writeAll(T0 - 5, ['binance', 'bybit']);
    const b = service(w, clock).snapshot();
    assert.equal(entry(b, 'binance').events_last_hour, 2); assert.equal(entry(b, 'bybit').events_last_hour, 1);
  } finally { w.close(); }
});

// ---- G1.4 cache, free, bucket -----------------------------------------------------------------------------------------------------------------------------------------------
test('G1.4 two requests within 30 s read the sources once (ages still move with the clock); a request after 30 s reads again', () => {
  const w = world(); const clock = { t: T0 }; let reads = 0;
  try {
    w.writeAll(T0);
    const counting = [{ name: 'counted', cadence: 'test', maxAgeS: 900, read: () => { reads++; return clock.t - 1000; } }];
    const svc = makeStatus({ env: w.env, now: () => clock.t, collectors: counting, venues: [{ venue: 'binance', maxAgeS: 600 }] });
    const a = svc.snapshot(); assert.equal(reads, 1);
    w.write('binance', T0 + 5000);                      // a newer row appears while the cache is warm
    clock.t = T0 + 20_000; const b = svc.snapshot();
    assert.equal(reads, 1, 'still the cached sample');
    assert.equal(b.venues[0].last_event_at, a.venues[0].last_event_at, 'the cached row, not the newer one');
    assert.equal(b.venues[0].age_s, a.venues[0].age_s + 20, 'but the age moves with this response\'s clock');
    clock.t = T0 + 31_000; const c = svc.snapshot();
    assert.equal(reads, 2, 'a fresh read after 30 s'); assert.notEqual(c.venues[0].last_event_at, a.venues[0].last_event_at);
  } finally { w.close(); }
});

async function appWith(limits) {
  const w = world(); w.writeAll(Date.now());
  const rl = makeRateLimiter({ logCall: () => {}, isPricedPath: () => false, presentsPayment: () => false, limits });
  const app = express(); app.use(rl.middleware);
  const st = makeStatus({ env: w.env });
  app.get(['/api/status', '/status'], st.handler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { port: server.address().port, w, rl, close: () => { server.close(); w.close(); } };
}
const req = (port, method, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'cf-connecting-ip': '198.51.100.7', ...headers } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  r.on('error', reject); r.end();
});

test('G1.4 /api/status and /status: 200 without payment, identical bodies, no-store, HEAD 200 without a body, and both count in the docs bucket (the 121st GET in a minute is 429)', async () => {
  const a = await appWith();
  try {
    assert.equal(a.rl.classify({ method: 'GET', path: '/api/status', headers: {} }), 'docs'); assert.equal(a.rl.classify({ method: 'GET', path: '/status', headers: {} }), 'docs');
    const r1 = await req(a.port, 'GET', '/api/status', { 'cf-connecting-ip': '198.51.100.99' }); const r2 = await req(a.port, 'GET', '/status', { 'cf-connecting-ip': '198.51.100.99' });
    assert.equal(r1.status, 200); assert.equal(r2.status, 200); assert.equal(r1.headers['cache-control'], 'no-store');
    const j1 = JSON.parse(r1.body), j2 = JSON.parse(r2.body);   // the same document: as_of and the ages are this response's own clock, everything else is the one cached sample
    assert.deepEqual(Object.keys(j1), Object.keys(j2)); assert.deepEqual(j1.venues.map((v) => v.last_event_at), j2.venues.map((v) => v.last_event_at)); assert.deepEqual(j1.collectors.map((c) => c.last_write_at), j2.collectors.map((c) => c.last_write_at)); assert.deepEqual(j1.problems, j2.problems);
    assert.ok(!r1.headers['payment-required'] && !r1.headers['x-payment-response']);
    const h = await req(a.port, 'HEAD', '/api/status', { 'cf-connecting-ip': '198.51.100.99' }); assert.equal(h.status, 200); assert.equal(h.body, '');
    let last; for (let i = 0; i < 118; i++) last = await req(a.port, 'GET', '/api/status');   // 118 + the 2 above are not on this address: this address starts at 0
    assert.equal(last.status, 200);
    const n119 = await req(a.port, 'GET', '/status'); const n120 = await req(a.port, 'GET', '/api/status'); const n121 = await req(a.port, 'GET', '/api/status');
    assert.deepEqual([n119.status, n120.status, n121.status], [200, 200, 429]); assert.ok(n121.headers['retry-after']);
  } finally { a.close(); }
});

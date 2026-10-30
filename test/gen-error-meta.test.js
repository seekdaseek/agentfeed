// gen-error-meta.js writes error-responses.json from what the code does. It broke silently once (the rate limiter moved to
// lib/ratelimit.js and the generator's anchors still read server.js, so nobody could regenerate and the file lost 31 of 91 routes).
// These tests keep it runnable, keep its numbers equal to the limiter's, and keep it from publishing a scratch's own fault.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const GEN = path.join(ROOT, 'gen-error-meta.js');
const run = (args, env) => new Promise((resolve) => execFile(process.execPath, [GEN, ...args], { cwd: ROOT, env: { ...process.env, ...env }, timeout: 60000 },
  (err, stdout, stderr) => resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr })));
const stub = (answer) => new Promise((r) => {
  const srv = http.createServer((req, res) => { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer)); });
  srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
});

test('every anchor still matches the source, and the limits it reads are the limiter\'s own', async () => {
  const r = await run(['--anchors']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /all anchors matched/);
  const { LIMITS, WINDOW_MS } = require('../lib/ratelimit.js');
  const want = { get: LIMITS.metered, other: LIMITS.other, windowSeconds: WINDOW_MS / 1000 };
  assert.deepEqual(JSON.parse(r.stdout.slice(r.stdout.indexOf('limits ') + 7)), want);
});

test('the committed error-responses.json agrees with the code: the limiter\'s numbers, and an entry for every priced route', () => {
  const { LIMITS, WINDOW_MS } = require('../lib/ratelimit.js');
  const { PRICES } = require('../payments.js');
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'error-responses.json'), 'utf8'));
  assert.deepEqual(j.limits, { get: LIMITS.metered, other: LIMITS.other, windowSeconds: WINDOW_MS / 1000 });
  const missing = Object.keys(PRICES).filter((p) => !(p in j.routes));
  assert.deepEqual(missing, [], `error-responses.json lacks ${missing.length} priced route(s); regenerate: see the header of gen-error-meta.js`);
  assert.deepEqual(Object.keys(j.routes).filter((p) => !(p in PRICES)), [], 'error-responses.json documents a route that is no longer priced');
});

test('against a server that answers every probe with a plain caller error, it writes one entry per priced route', async () => {
  const { PRICES } = require('../payments.js');
  const s = await stub({ tool: 'x', error: 'missing required parameter: x' });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gem-')), 'out.json');
  try {
    const r = await run([], { BASE: s.url, ERROR_META_OUT: out });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(j.routes).sort(), Object.keys(PRICES).sort());
  } finally { s.srv.close(); }
});

test('a probe that hits the scratch\'s own fault (a missing table) aborts and writes nothing', async () => {
  const s = await stub({ tool: 'get_recent_liquidations', error: 'no such table: liquidations' });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gem-')), 'out.json');
  try {
    const r = await run([], { BASE: s.url, ERROR_META_OUT: out });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /ABORT: \d+ probe\(s\) hit the scratch's own fault/);
    assert.match(r.stderr, /no such table: liquidations/);
    assert.equal(fs.existsSync(out), false, 'a faulty run must not leave a file behind');
  } finally { s.srv.close(); }
});

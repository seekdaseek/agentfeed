// R22: a signals day pass minted by ops/key-admin.mjs (a comp grant, sold 0) is accepted by the REAL server.js (stub facilitator, outbound refused): the same four things the box check proves live.
//   1. a covered brief answers 200 and draws nothing; 2. the second signal-board call inside 60 s is a 429 with retry_after and Retry-After; 3. an uncovered priced route is a 403 naming the covered routes;
//   4. the key row stays balance 0, spent 0, sold 0. The CLI writes the server's own database while the server is running.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./helpers/real-server');
const { writeFiles } = require('./helpers/brief-files');
const { SIGNALS_DAY_PASS, hashKey } = require('../lib/keys');

let s; const dirs = [];
let ipN = 0;
const get = (p, h = {}) => { ipN++; return H.raw(s.port, 'GET', p, { 'cf-connecting-ip': `198.18.${(ipN >> 8) & 255}.${ipN & 255}`, ...h }); };
before(async () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-fx-')); dirs.push(d); s = await H.boot(writeFiles(d, {})); });
after(() => { if (s) s.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('a comp signals day pass from key-admin: covered brief 200 with nothing drawn, second signal-board call 429 with retry_after, an uncovered priced route 403 naming the covered routes', async () => {
  const keyFile = path.join(dirs[0], 'comp.key');
  const cli = path.join(__dirname, '..', 'ops', 'key-admin.mjs');
  const said = execFileSync(process.execPath, [cli, 'grant-pass', '1', '--signals', '--day', '--label', 'r22-e2e', '--out', keyFile], { env: { ...process.env, AGENTFEED_DB: s.env.AGENTFEED_DB }, encoding: 'utf8' });
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  assert.ok(!said.includes(key));
  const hdr = { 'x-agentfeed-key': key };
  s.fac.log.length = 0;
  const brief = await get('/api/morning-brief', hdr);
  assert.equal(brief.status, 200, brief.body.slice(0, 200));
  const first = await get('/api/signal-board', hdr);
  assert.equal(first.status, 200, first.body.slice(0, 200));
  const second = await get('/api/signal-board', hdr);
  assert.equal(second.status, 429, 'the second call inside the minute is refused');
  assert.ok(Number(second.headers['retry-after']) > 0 && JSON.parse(second.body).retry_after > 0, 'with Retry-After and retry_after');
  const uncovered = await get('/api/funding-rate', hdr);
  assert.equal(uncovered.status, 403);
  assert.deepEqual(JSON.parse(uncovered.body).routes, SIGNALS_DAY_PASS.allow, 'it names the covered routes');
  assert.deepEqual(s.fac.log, [], 'nothing went to the facilitator');
  await new Promise((r) => setTimeout(r, 800));
  const d = s.db();
  try {
    const row = d.prepare('SELECT balance_micro, spent_micro, sold_micro FROM api_keys WHERE key_hash = ?').get(hashKey(key));
    assert.deepEqual(row, { balance_micro: 0, spent_micro: 0, sold_micro: 0 }, 'nothing drawn, nothing sold');
  } finally { d.close(); }
});

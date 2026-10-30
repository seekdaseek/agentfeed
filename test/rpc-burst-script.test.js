// R20h: ops/rpc-burst.mjs is the tool the owner runs on the box after adding a keyed provider. Smoke test against stubs: what it prints is what it must mean.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { startRpcStub } = require('./helpers/rpc-stub');

const SCRIPT = path.resolve(__dirname, '..', 'ops', 'rpc-burst.mjs');
function burst(env, n = 20) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, String(n)], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
}

test('with a keyed provider: every call answers, one ranking call upstream, the public RPC is not asked, exit 0; hosts only are printed', async () => {
  const primary = await startRpcStub({ mode: 'capped' });
  const keyed = await startRpcStub({ mode: 'ok' });
  const pub = await startRpcStub({ mode: 'public', refuse: ['getTokenLargestAccounts'] });
  try {
    const r = await burst({ SOLANA_RPC_URL: primary.url, RPC_FALLBACKS: `${keyed.url}/v2/SECRETKEY0123456789abcdef,${pub.url}`, RPC_HEAVY_SKIP: pub.host });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /20 concurrent calls in \d+ ms: answers 20, failures 0/);
    assert.match(r.out, /a keyed provider besides Helius is configured: yes/);
    assert.match(r.out, /"getTokenLargestAccounts":2/, 'two attempts counted for 20 calls: the capped primary once, the keyed provider once');
    assert.match(r.out, /"shared":19/, 'the other 19 callers shared the one in flight');
    assert.match(r.out, /public RPC asked : 0/);
    assert.ok(!r.out.includes('SECRETKEY'), 'no key in the output');
    assert.equal(keyed.count('getTokenLargestAccounts'), 1);
  } finally { primary.close(); keyed.close(); pub.close(); }
});

test('with no keyed provider: all calls fail as a 503 "Not charged", the public RPC is still not asked, and it says no keyed provider is configured', async () => {
  const primary = await startRpcStub({ mode: 'capped' });
  const pub = await startRpcStub({ mode: 'public', refuse: ['getTokenLargestAccounts'] });
  try {
    const r = await burst({ SOLANA_RPC_URL: primary.url, RPC_FALLBACKS: pub.url, RPC_HEAVY_SKIP: pub.host });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /answers 0, failures 20/);
    assert.match(r.out, /20 x 503 solana rpc http 429\. Not charged\./);
    assert.match(r.out, /public RPC asked : 0/);
    assert.equal(pub.count('getTokenLargestAccounts'), 0);
  } finally { primary.close(); pub.close(); }
});

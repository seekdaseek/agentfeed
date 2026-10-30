// R20h (30 Oct 2026): the burst test for "token-risk answers 503 'solana rpc http 429. Not charged.'".
//
// The REAL server.js (test/helpers/real-server.js) with its Solana endpoints pointed, through the same environment variables production uses (SOLANA_RPC_URL,
// RPC_FALLBACKS, RPC_HEAVY_SKIP), at three loopback stubs that behave like the providers measured on 30 Oct 2026 (test/helpers/rpc-stub.js): a primary that is out of
// credits (HTTP 429 "max usage reached"), the public RPC (serves everything except getTokenLargestAccounts, which it refuses with a per-method 429), and a keyed
// provider. Requests go through the prepaid-key rail, so the whole route runs: the paywall layer, the handler, the RPC layer.
//   A  keyed provider configured (the fix, once a key is added): a burst of 60 token-risk and token-holders requests for one mint is all 200, the keyed provider is
//      asked for the ranking ONCE, the public RPC never.
//   B  no keyed provider (the state of the box on 30 Oct): every one is a 503 "Not charged" with Retry-After, the key is not billed, the public RPC is never asked
//      for what it always refuses and is not put to rest (a light route keeps answering through it).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const H = require('./helpers/real-server');
const { startRpcStub } = require('./helpers/rpc-stub');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.23.${(ipN >> 8) & 255}.${ipN & 255}` }; };

async function addKey(s) {
  const { newKey, hashKey } = require('../lib/keys');
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try {
    d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 900000000, 900000000, 0, 0, ?, 1000000, 'rpc burst test')`)
      .run(hash, key.slice(4, 12), Math.floor(Date.now() / 1000));
  } finally { d.close(); }
  return { key, balance: () => { const c = s.db(); try { return c.prepare('SELECT balance_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { c.close(); } } };
}
const settle = async (read) => { let a = read(); for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 150)); const b = read(); if (JSON.stringify(a) === JSON.stringify(b)) return b; a = b; } return a; };
const get = (s, p, key) => H.raw(s.port, 'GET', p, { ...ip(), 'x-agentfeed-key': key });

let primary, keyed, pub, A, B;
before(async () => {
  primary = await startRpcStub({ mode: 'capped' });
  keyed = await startRpcStub({ mode: 'ok' });
  pub = await startRpcStub({ mode: 'public', refuse: ['getTokenLargestAccounts'] });
});
after(() => { for (const x of [primary, keyed, pub]) if (x) x.close(); for (const x of [A, B]) if (x) x.close(); });

test('A: with a keyed provider a burst of 60 requests for one mint is 60 answers, ONE ranking call upstream, and the public RPC is never asked for it', async () => {
  A = await H.boot({ SOLANA_RPC_URL: primary.url, RPC_FALLBACKS: `${keyed.url},${pub.url}`, RPC_HEAVY_SKIP: pub.host });
  const { key, balance } = await addKey(A);
  const b0 = await settle(balance);
  const paths = [...Array.from({ length: 40 }, () => `/api/token-risk/${MINT}`), ...Array.from({ length: 20 }, () => `/api/token-holders/${MINT}`)];
  const rs = await Promise.all(paths.map((p) => get(A, p, key)));
  const bad = rs.filter((r) => r.status !== 200);
  assert.equal(bad.length, 0, `${bad.length} of 60 were not 200: ${bad[0] && bad[0].status} ${bad[0] && bad[0].body.slice(0, 160)}`);
  const risk = JSON.parse(rs[0].body).data;
  assert.equal(risk.concentration.top1_pct, 30, 'the ranking is the keyed provider\'s: the top account holds 30% of the supply');
  assert.equal(keyed.count('getTokenLargestAccounts'), 1, `the keyed provider was asked for the ranking ${keyed.count('getTokenLargestAccounts')} time(s) for 60 requests`);
  assert.equal(pub.count('getTokenLargestAccounts'), 0, 'the public RPC was never asked for it');
  assert.ok(primary.count('getTokenLargestAccounts') <= 1, `the capped primary was tried at most once (${primary.count('getTokenLargestAccounts')})`);
  const b1 = await settle(balance);
  assert.equal(b1.calls - b0.calls, 60, 'and 60 calls were billed');
});

test('B: with no keyed provider every request is a 503 "Not charged" with Retry-After, nothing is billed, the public RPC is not asked and keeps serving the light routes', async () => {
  B = await H.boot({ SOLANA_RPC_URL: primary.url, RPC_FALLBACKS: pub.url, RPC_HEAVY_SKIP: pub.host });
  const { key, balance } = await addKey(B);
  const b0 = await settle(balance);
  const before = pub.count('getTokenLargestAccounts');
  const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => get(B, `/api/${i % 2 ? 'token-risk' : 'token-holders'}/${MINT}`, key)));
  for (const r of rs) {
    assert.equal(r.status, 503, `${r.status} ${r.body.slice(0, 120)}`);
    assert.match(JSON.parse(r.body).error, /Not charged/);
    assert.ok(Number(r.headers['retry-after']) >= 1, 'a Retry-After says when to come back');
  }
  assert.equal(pub.count('getTokenLargestAccounts') - before, 0, 'the public RPC was not asked for what it always refuses');
  assert.deepEqual(await settle(balance), b0, 'the key was not billed: every reservation was refunded');
  // not put to rest: a light route still goes through it (the primary is capped, so the public RPC is the only endpoint that can answer)
  const light = await get(B, `/api/token-metadata/${MINT}`, key);
  assert.equal(light.status, 200, `a light route still answers through the public RPC: ${light.status} ${light.body.slice(0, 160)}`);
  assert.ok(pub.count('getAccountInfo') >= 1, 'it was the public RPC that answered');
  assert.ok(!new RegExp(`rpc_failover[^\\n]*"from":"${pub.host.replace(/\./g, '\\.')}`).test(B.out()), 'no failover line names the public RPC: nothing put it to rest');
});

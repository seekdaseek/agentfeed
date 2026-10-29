// R20f (29 Oct 2026): every network a 402 offers must be a CAIP-2 chain id, because CDP's Bazaar validate parses each accept and a single
// id outside the grammar makes the REQUIRED check "parse" fail, and the simulation answer "rejected: invalid discovery configuration" for the
// whole route (measured 29 Oct 2026 on all 91 priced routes: 13 accepts, one of them algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=,
// 44 characters with a trailing "=", where CAIP-2 allows 1 to 32 of [-_a-zA-Z0-9]). With the Algorand rail off (X402_ALGO=off, the box .env
// since 29 Oct 2026) /api/time validates: valid true, simulation accepted, 25 of 25 checks pass; 90 of the 91 routes do (the 91st, /api/paper/:doi, fails only
// bazaar.routeTemplate.matches_resource: see lib/route-urls.js).
//   - unit: the grammar, the networks of every other rail, and the Algorand id as the documented exception;
//   - real server: every priced route's default accepts are CAIP-2 (the harness boots with X402_ALGO=off like the box).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const H = require('./helpers/real-server');
const rails = require('../lib/rails');
const { PRICES } = require('../payments');
const routeUrls = require('../lib/route-urls').makeRouteUrls({ ORIGIN: require('../tools/discovery').ORIGIN, meta: require('../bazaar-examples.json').routes });

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

test('control: the grammar accepts the ids the other rails use and rejects the Algorand id as the facilitator publishes it', () => {
  for (const ok of ['eip155:8453', 'eip155:42161', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']) assert.match(ok, CAIP2, ok);
  for (const bad of ['algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=', 'solana', 'eip155:', ':8453', 'eip155:8453 ']) assert.doesNotMatch(bad, CAIP2, bad);
});

test('every EVM rail the server can offer, default or on request, has a CAIP-2 id; the Algorand id is the one that does not (so X402_ALGO stays off)', () => {
  for (const r of rails.ALL_EVM_RAILS) assert.match(r.network, CAIP2, `${r.name}: ${r.network}`);
  for (const r of require('../lib/ext-rails').EXT_RAILS) assert.match(r.network, CAIP2, `${r.name}: ${r.network}`);
  assert.doesNotMatch(rails.ALGORAND_MAINNET, CAIP2, 'if this fails the Algorand id became CAIP-2: the X402_ALGO=off line and the README note can go');
  assert.equal(rails.algoRail({ X402_ALGO: 'off' }), null, 'the switch the box relies on still turns the rail off');
  assert.ok(rails.algoRail({}), 'and without it the rail is on, which is why the box .env carries the line');
});

let s;
before(async () => { s = await H.boot(); });
after(() => { if (s) s.close(); });

test('real server: the v2 accepts of every priced GET route are all CAIP-2 ids', async () => {
  const routes = Object.keys(PRICES).filter((k) => /^GET /.test(k));
  assert.ok(routes.length >= 85, `control: the route table (${routes.length})`);
  let ipN = 0;
  let checked = 0;
  for (const pattern of routes) {
    const p = routeUrls.concretePath(pattern);
    const r = await H.raw(s.port, 'GET', p, { 'cf-connecting-ip': `198.19.${(++ipN >> 8) & 255}.${ipN & 255}` });
    if (r.status !== 402) continue;   // routes the harness serves without a challenge are not what this test is about
    const v2 = H.unb64(r.headers['payment-required']);
    for (const a of v2.accepts) assert.match(a.network, CAIP2, `${pattern}: accept network ${a.network}`);
    checked++;
  }
  assert.ok(checked >= 80, `control: the test looked at the challenges of ${checked} routes`);
});

// test/tool.test.js — the route wrapper's `paid` flag and audit row.
//
// Mounts the REAL wrapper from lib/tool.js (the same module server.js mounts,
// not a copy) on a throwaway express app with a stub PRICES, and drives it over
// a real HTTP socket so req.route is populated exactly as it is in production.
//
// Run:  node --test test/tool.test.js        (from the service root)

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { makeTool } = require('../lib/tool');

// One priced route and one unpriced route, in both shapes the service uses:
// a literal path and a path-parameter pattern.
const PRICES = {
  'GET /api/priced': { usd: 0.01, tool: 'get_priced', desc: 'priced' },
  'GET /api/priced-param/:id': { usd: 0.02, tool: 'get_priced_param', desc: 'priced param' },
};

function boot({ paymentsOn = true } = {}) {
  const audit = [];
  const { tool, isPaidRoute } = makeTool({
    paymentsOn,
    PRICES,
    // No settlement header in a unit test; the audit row's own branch is what
    // this asserts, not the decoder.
    decodeSettlement: () => null,
    logCall: (row) => audit.push(row),
  });

  const app = express();
  app.use((req, _res, next) => { req.callerIp = '203.0.113.7'; next(); });
  app.get('/api/priced', tool('get_priced', 0.01, () => ({ ok: true })));
  app.get('/api/priced-param/:id', tool('get_priced_param', 0.02, (req) => ({ id: req.params.id })));
  // Registered with a non-zero price argument but ABSENT from PRICES — exactly
  // how get_fear_greed is registered in server.js. If the flag ever keys on the
  // price argument instead of PRICES, this route is what catches it.
  app.get('/api/free', tool('get_free', 0.001, () => ({ ok: true })));
  app.get('/api/boom', tool('get_boom', 0.01, () => { throw new Error('upstream exploded'); }));
  app.get('/api/bad', tool('get_bad', 0.01, () => {
    const e = new Error('symbol required');
    e.kind = 'bad_request';
    throw e;
  }));

  return { app, audit, isPaidRoute };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

// A finish handler runs after the response is flushed, so give the event loop a
// turn before reading the audit array.
const settle = () => new Promise((r) => setTimeout(r, 25));

test('a priced route reports paid:true', async () => {
  const { app } = boot();
  const { server, port } = await listen(app);
  try {
    const r = await get(port, '/api/priced');
    assert.equal(r.status, 200);
    assert.equal(r.body.paid, true);
    assert.equal(r.body.tool, 'get_priced');
  } finally { server.close(); }
});

test('a priced path-parameter route matches on the PATTERN, not the URL', async () => {
  const { app } = boot();
  const { server, port } = await listen(app);
  try {
    const r = await get(port, '/api/priced-param/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    assert.equal(r.status, 200);
    // PRICES holds 'GET /api/priced-param/:id'; the request URL carries a real
    // value. This is the assertion that req.route.path is the registered
    // pattern — if it were req.path, this would be false.
    assert.equal(r.body.paid, true);
  } finally { server.close(); }
});

test('an unpriced route reports paid:false even though it was registered with a price argument', async () => {
  const { app } = boot();
  const { server, port } = await listen(app);
  try {
    const r = await get(port, '/api/free');
    assert.equal(r.status, 200);
    assert.equal(r.body.paid, false, 'the flag must key on PRICES, never on the priceUsd argument');
  } finally { server.close(); }
});

test('X402_MODE=off makes every route report paid:false', async () => {
  const { app } = boot({ paymentsOn: false });
  const { server, port } = await listen(app);
  try {
    assert.equal((await get(port, '/api/priced')).body.paid, false);
    assert.equal((await get(port, '/api/free')).body.paid, false);
  } finally { server.close(); }
});

test('the audit row still fires with the same fields on a 200', async () => {
  const { app, audit } = boot();
  const { server, port } = await listen(app);
  try {
    await get(port, '/api/priced');
    await settle();
    assert.equal(audit.length, 1);
    const row = audit[0];
    assert.deepEqual(Object.keys(row).sort(), [
      'amount_usdc', 'ip', 'latency_ms', 'payer_wallet', 'status', 'tool', 'tx_sig',
    ]);
    assert.equal(row.tool, 'get_priced');
    // No settlement header in this harness, so the row is 'free'. That is the
    // point: the audit row reads the REAL settlement and is deliberately not
    // the same question as the `paid` field in the body.
    assert.equal(row.status, 'free');
    assert.equal(row.payer_wallet, null);
    assert.equal(row.tx_sig, null);
    assert.equal(row.amount_usdc, null);
    assert.equal(row.ip, '203.0.113.7');
    assert.equal(typeof row.latency_ms, 'number');
  } finally { server.close(); }
});

test('the paid body flag and the audit status are independent', async () => {
  const { app, audit } = boot();
  const { server, port } = await listen(app);
  try {
    const r = await get(port, '/api/priced');
    await settle();
    assert.equal(r.body.paid, true);
    assert.equal(audit[0].status, 'free');
  } finally { server.close(); }
});

test('a thrown error still logs status=error and answers 400, with no paid field', async () => {
  const { app, audit } = boot();
  const { server, port } = await listen(app);
  try {
    const r = await get(port, '/api/boom');
    await settle();
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'upstream exploded');
    assert.ok(!('paid' in r.body));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].status, 'error');
    assert.deepEqual(Object.keys(audit[0]).sort(), [
      'error_msg', 'ip', 'latency_ms', 'method', 'req_path', 'status', 'tool', 'user_agent',
    ]);
  } finally { server.close(); }
});

test('an input-validation throw still logs status=bad_request', async () => {
  const { app, audit } = boot();
  const { server, port } = await listen(app);
  try {
    assert.equal((await get(port, '/api/bad')).status, 400);
    await settle();
    assert.equal(audit[0].status, 'bad_request');
  } finally { server.close(); }
});

test('isPaidRoute is false when there is no route (middleware context)', () => {
  const { isPaidRoute } = boot();
  assert.equal(isPaidRoute({}), false);
  assert.equal(isPaidRoute({ route: {} }), false);
  assert.equal(isPaidRoute({ route: { path: '/api/priced' } }), true);
  assert.equal(isPaidRoute({ route: { path: '/api/nope' } }), false);
});

test('isPaidRoute cannot be fooled by an inherited Object property', () => {
  const { isPaidRoute } = boot();
  // 'GET /api/x'.constructor etc. would be truthy under a bare `in` check.
  assert.equal(isPaidRoute({ route: { path: 'constructor' } }), false);
  assert.equal(isPaidRoute({ route: { path: 'toString' } }), false);
});

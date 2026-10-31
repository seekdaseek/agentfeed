// test/r11-region.test.js — the region gate for the eight language-model routes (the seventh and eighth: transcribe, and R23 claim-check) (R11 B review fix 1).
// Driven over a real HTTP socket on a throwaway express app that mounts the gate where server.js will: above the payment layer
// (a stub that stands for the 402 and counts how often it is reached) and, for MCP, in front of a route that parses its own body.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const G = require('../tools/llm/region-gate');

test('the table: 230 places read from the page, ISO codes only, Moldova in, the sanctioned and unlisted out, no legacy codes', () => {
  const codes = Object.keys(G.COUNTRIES);
  assert.equal(codes.length, 230, 'the page listed 230 names');
  assert.ok(codes.every((c) => /^[A-Z]{2}$/.test(c)));
  for (const c of ['MD', 'US', 'DE', 'FR', 'GB', 'RO', 'UA', 'JP', 'TW', 'XK', 'IN', 'BR', 'AU', 'CA', 'AX', 'CI', 'CZ', 'CD', 'CG', 'TL']) assert.ok(c in G.COUNTRIES, `${c} should be on the list`);
  for (const c of ['CN', 'RU', 'IR', 'KP', 'CU', 'SY', 'BY', 'AF', 'MM', 'HK', 'MO', 'T1', 'XX', 'ZZ']) assert.ok(!(c in G.COUNTRIES), `${c} should not be on the list`);
  for (const legacy of ['UK', 'FX', 'DY', 'HV', 'TP', 'YU', 'CS', 'ZR', 'SU', 'EU', 'UN']) assert.ok(!(legacy in G.COUNTRIES), `${legacy} is not a current ISO code`);
  assert.equal(G.COUNTRIES.MD, 'Moldova');
  assert.equal(G.COUNTRIES.CZ, 'Czech Republic', 'names are the page\'s own words');
  assert.equal(G.PHASE_B_PATHS.size, 8); assert.equal(G.PHASE_B_TOOLS.size, 8);
});
test('check(): absent is allowed; present and off the list is blocked, T1, XX and empty included; case does not matter', () => {
  assert.deepEqual(G.check(undefined), { blocked: false, country: null });
  assert.deepEqual(G.check('MD'), { blocked: false, country: 'MD' }); assert.deepEqual(G.check(' md '), { blocked: false, country: 'MD' });
  for (const c of ['RU', 'CN', 'T1', 'XX', 't1', 'xx', '', '  ', 'ZZ', 'USA', 'U', '__proto__', 'constructor']) assert.equal(G.check(c).blocked, true, JSON.stringify(c));
});

function boot() {
  const reached = { payment: 0, mcpBodies: [] };
  const app = express();
  app.use(G.regionGate);
  app.use((req, _res, next) => { reached.payment++; next(); }); // the payment layer stands here: reaching it is where a 402 would be sent
  const ok = (name) => (_req, res) => res.json({ route: name });
  for (const r of ['ocr', 'summarize', 'extract', 'translate', 'classify', 'injection-check', 'transcribe', 'prices', 'sol-token-check']) app.get(`/api/${r}`, ok(r));
  app.post('/mcp', express.json(), (req, res) => { reached.mcpBodies.push(req.body); res.json({ ok: true }); });
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}`, reached })); });
}
const get = (base, p, country) => fetch(`${base}${p}`, { headers: country === undefined ? {} : { 'cf-ipcountry': country } });
const rpc = (base, body, country, raw) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(country === undefined ? {} : { 'cf-ipcountry': country }) }, body: raw || JSON.stringify(body) });

test('REST: all eight routes answer 451 {error, country} to a blocked country before the payment layer; allowed and header-less callers pass; other routes are untouched', async () => {
  const { srv, base, reached } = await boot();
  try {
    for (const r of ['ocr', 'summarize', 'extract', 'translate', 'classify', 'injection-check', 'transcribe']) {
      for (const country of ['RU', 'T1', 'XX']) {
        const before = reached.payment;
        const res = await get(base, `/api/${r}?x=1`, country);
        assert.equal(res.status, 451, `${r} ${country}`); const body = await res.json();
        assert.deepEqual(Object.keys(body).sort(), ['country', 'error']); assert.equal(body.country, country); assert.match(body.error, /not available in your region/);
        assert.equal(reached.payment, before, `${r} ${country}: the payment layer (and so any 402 or settlement) was never reached`);
      }
      assert.equal((await get(base, `/api/${r}`, 'MD')).status, 200, `${r} MD`);
      assert.equal((await get(base, `/api/${r}`, 'us')).status, 200, `${r} us (lower case)`);
      assert.equal((await get(base, `/api/${r}`, undefined)).status, 200, `${r} no header`);
    }
    // other routes are not the gate's business
    for (const country of ['RU', 'T1', 'XX']) assert.equal((await get(base, '/api/prices', country)).status, 200);
    assert.equal((await get(base, '/api/sol-token-check', 'CN')).status, 200);
  } finally { srv.close(); }
});
test('the alias path with a network suffix is the same route', () => {
  const run = (path, country) => { let out = 'next'; G.regionGate({ path, method: 'GET', headers: { 'cf-ipcountry': country } }, { status(c) { out = c; return { json() {} }; } }, () => {}); return out; };
  assert.equal(run('/api/ocr|eip155:8453', 'RU'), 451); assert.equal(run('/api/transcribe|solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'XX'), 451); assert.equal(run('/api/ocr/', 'RU'), 451);
  assert.equal(run('/api/ocr|eip155:8453', 'MD'), 'next'); assert.equal(run('/api/prices|eip155:8453', 'RU'), 'next');
});
test('MCP: a blocked country cannot call the eight tools (single or batch), other tools and tools/list pass, and the body is still readable by the route', async () => {
  const { srv, base, reached } = await boot();
  try {
    const call = (name) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
    for (const t of ['get_ocr', 'get_summarize', 'get_extract', 'get_translate', 'get_classify', 'get_injection_check', 'get_transcribe']) {
      const res = await rpc(base, call(t), 'RU'); assert.equal(res.status, 451, t); assert.equal((await res.json()).country, 'RU');
    }
    assert.equal(reached.payment, 0); assert.equal(reached.mcpBodies.length, 0, 'the route never saw a blocked call');
    assert.equal((await rpc(base, [call('get_sol_token_check'), call('get_ocr')], 'T1')).status, 451, 'one Phase B call in a batch blocks the batch');
    const pass = await rpc(base, call('get_sol_token_check'), 'RU'); assert.equal(pass.status, 200);
    assert.deepEqual(reached.mcpBodies[0], call('get_sol_token_check'), 'the gate parsed the body and the route still received it intact');
    assert.equal((await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'XX')).status, 200);
    assert.equal((await rpc(base, call('get_ocr'), 'MD')).status, 200, 'an allowed country calls Phase B tools freely');
    assert.equal((await rpc(base, call('get_ocr'), undefined)).status, 200, 'no header, no judgment');
    const bad = await rpc(base, null, 'RU', '{not json'); assert.notEqual(bad.status, 451, 'unparseable bodies are left to the MCP route to refuse');
  } finally { srv.close(); }
});

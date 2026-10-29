// R20g (29 Oct 2026): with the Algorand rail OFF (X402_ALGO=off, the box .env since 29 Oct 2026) no surface of the main AgentFeed may still list it or count it.
// What this pins, all measured on 29 Oct after the switch: /keys (a static page) still named Algorand, server.json said "21 chains" (9 in every 402 + 11 on request
// + Tempo, Algorand among the 9), docs/nofx*.md listed it. The dynamic documents (landing, llms.txt, SKILL.md, agent card, x402.json, pricing, openapi) derive
// their rail list from lib/rails.js and were already right; they are in the list so a future static sentence in them cannot drift.
// The Algorand-only sibling service (algo.ochinimus.app) is a different product and is not covered here.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/real-server');
const rails = require('../lib/rails');
const { EXT_RAILS } = require('../lib/ext-rails');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let s;
let ipN = 0;
before(async () => { s = await H.boot(); });   // the harness runs X402_ALGO=off, like the box
after(() => { if (s) s.close(); });
const get = (p) => H.raw(s.port, 'GET', p, { 'cf-connecting-ip': `198.22.${(++ipN >> 8) & 255}.${ipN & 255}` });

test('control: the harness has the Algorand rail off and the 402 carries no Algorand accept', async () => {
  assert.equal(rails.algoRail({ X402_ALGO: 'off' }), null);
  const r = await get('/api/time');
  assert.equal(r.status, 402);
  assert.ok(!H.unb64(r.headers['payment-required']).accepts.some((a) => /^algorand:/.test(a.network)));
});

test('no document the service publishes names Algorand while the rail is off', async () => {
  const docs = ['/', '/llms.txt', '/SKILL.md', '/.well-known/x402.json', '/.well-known/x402', '/.well-known/agent-card.json', '/pricing', '/openapi.json', '/keys',
    '/.well-known/mcp/server-card.json', '/.well-known/ai-catalog.json'];
  let looked = 0;
  for (const d of docs) {
    const r = await get(d);
    assert.equal(r.status, 200, `${d} -> ${r.status}`);
    looked += r.body.length;
    const m = /.{0,60}algorand.{0,60}/i.exec(r.body);
    assert.equal(m, null, `${d} still names Algorand: ...${m && m[0].replace(/\s+/g, ' ')}...`);
  }
  assert.ok(looked > 200000, `control: ${looked} bytes of documents were read`);
});

test('the chain count the MCP Registry record and the server card publish is the number of networks the service can take', async () => {
  // Solana + the EVM rails (Base, Polygon, Arbitrum) + Arc + every lib/ext-rails.js network (3 in every 402, 11 on request) + Tempo (MPP) + Algorand only if it is on
  const n = 1 + rails.ALL_EVM_RAILS.length + 1 + EXT_RAILS.length + 1 + (rails.algoRail({ X402_ALGO: 'off' }) ? 1 : 0);
  assert.equal(n, 20, 'control: 1 + 3 + 1 + 14 + 1 = 20 with Algorand off (21 with it on, which is what server.json said before)');
  const sj = JSON.parse(read('server.json'));
  assert.match(sj.description, new RegExp(`\\b${n} chains\\b`), `server.json says: ${sj.description}`);
  const card = JSON.parse((await get('/.well-known/mcp/server-card.json')).body);
  assert.match(card.description, new RegExp(`\\b${n} chains\\b`), `the server card says: ${card.description}`);
  assert.equal(card.version, sj.version, 'the card is built from server.json');
});

test('the static text that describes the main service lists no Algorand among its networks', () => {
  for (const f of ['README.md', 'docs/nofx.md', 'docs/nofx.zh-CN.md', 'tools/keys-page.js', 'server.json']) {
    const text = read(f);
    assert.ok(!/Arc[,、]?\s*(and\s+)?Algorand/.test(text), `${f} lists Algorand next to Arc`);
    assert.ok(!/\bNine networks\b/.test(text), `${f} says nine networks`);
  }
  assert.match(read('README.md'), /Eight networks are in every 402/, 'the README states the number that is true with the rail off');
});

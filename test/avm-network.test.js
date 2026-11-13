// R27 (13 Nov 2026): the Algorand network id at the @x402/avm boundary. @x402/avm 2.31.0 throws "Unsupported Algorand network" for the full-genesis-hash id our rail advertises (and agentfeed-algo serves live);
// lib/avm-network.js maps it to avm's CAIP-2 id for price parsing only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ExactAvmScheme } = require('@x402/avm/exact/server');
const { ExactAvmSchemeFullId, toAvmNetwork } = require('../lib/avm-network');
const rails = require('../lib/rails');

const CAIP2_MAIN = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k';

test('control: the raw avm scheme refuses the id the rail advertises (the R26 failure), and accepts its own CAIP-2 id', async () => {
  const raw = new ExactAvmScheme();
  await assert.rejects(raw.parsePrice('$0.01', rails.ALGORAND_MAINNET), /Unsupported Algorand network/);
  const ok = await raw.parsePrice('$0.01', CAIP2_MAIN);
  assert.equal(ok.asset, '31566704'); assert.equal(ok.amount, '10000');
});

test('the adapter prices the advertised id like avm prices its CAIP-2 id: USDC ASA 31566704, 6 decimals', async () => {
  const s = new ExactAvmSchemeFullId();
  assert.ok(s instanceof ExactAvmScheme);
  for (const [price, amount] of [['$0.001', '1000'], ['$0.01', '10000'], ['$1', '1000000'], ['$0.005', '5000']]) {
    const r = await s.parsePrice(price, rails.ALGORAND_MAINNET);
    assert.deepEqual({ amount: r.amount, asset: r.asset }, { amount, asset: '31566704' }, price);
  }
  assert.equal(s.getAssetDecimals('31566704', rails.ALGORAND_MAINNET), 6);
  assert.equal(s.getAssetDecimals('31566704', CAIP2_MAIN), 6, 'the CAIP-2 id still works through the adapter');
  assert.equal(s.getAssetDecimals('999', rails.ALGORAND_MAINNET), undefined, 'an unknown asset is still unknown');
});

test('the mapping touches the two Algorand ids only: any other network string is passed through and still refused by avm', async () => {
  assert.equal(toAvmNetwork(rails.ALGORAND_MAINNET), CAIP2_MAIN);
  assert.equal(toAvmNetwork('algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='), 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe');
  assert.equal(toAvmNetwork('eip155:8453'), 'eip155:8453');
  assert.equal(toAvmNetwork('algorand:notarealgenesis'), 'algorand:notarealgenesis');
  await assert.rejects(new ExactAvmSchemeFullId().parsePrice('$0.01', 'algorand:notarealgenesis'), /Unsupported Algorand network/);
});

test('the advertised id is unchanged: it is the full genesis hash (not CAIP-2) that agentfeed-algo serves', () => {
  assert.equal(rails.ALGORAND_MAINNET, 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=');
  assert.equal(rails.algoRail({}).network, rails.ALGORAND_MAINNET);
});

'use strict';
// R10 Phase B (14 Oct 2026): XRPL, Stellar, Sui, NEAR, Hedera, Fogo — built, off until a payTo is set (lib/nonevm-rails.js).
//   off       no *_PAY_TO: no row, no accept, no facilitator claim
//   on        with a payTo of the right shape: on request only, through Ultravioleta only, the official requirement shapes
//   refused   a payment on each reaches Ultravioleta and no other facilitator; refused, it is a 402 and never served
//   shapes    a payTo of the wrong shape refuses to boot the row
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { SOLANA_MAINNET_CAIP2 } = require('@x402/svm');
const payments = require('../payments');
const compat = require('../lib/compat');
const { railContext } = require('../lib/rail-ctx');
const { NONEVM_RAILS, nonEvmRails } = require('../lib/nonevm-rails');
const { FACILITATOR_URLS, EXT_RAILS } = require('../lib/ext-rails');
const rails = require('../lib/rails');

const ALGO = rails.algoRail({});
// well-formed stand-ins, never live accounts
const PAYTOS = {
  XRPL_PAY_TO: 'rsN9ZFdez7VJJPzswkwpb4QBZTHHP7oVRK',
  STELLAR_PAY_TO: 'GA2226DVH7XAGTRL7LELZ35V5QEAJDVQZLZOEKEIMXBGHB3CB5FCYYPH',
  SUI_PAY_TO: '0x' + 'ab'.repeat(32),
  NEAR_PAY_TO: 'agentfeed-test.near',
  HEDERA_PAY_TO: '0.0.10920431',
  FOGO_PAY_TO: 'J7mxBLSz51Tcbog3XsiJTAXS64N46KqbpRGQmd3dQMKp',
};
const dec = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

function stub(name, calls) {
  const nets = ['eip155:8453', 'eip155:137', 'eip155:42161', ...EXT_RAILS.map((r) => r.network)];
  const kinds = [
    { x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET_CAIP2, extra: { feePayer: 'D6ZhtNQ5nT9ZnTHUbqXZsTx5MH2rPFiBBggX4hY1WePM' } },
    ...nets.map((network) => ({ x402Version: 2, scheme: 'exact', network })),
    { x402Version: 2, scheme: 'exact', network: ALGO.network, extra: { feePayer: 'QWOWU2E6BB76HEQRRMXWZ2MU4HAQIYZWEPP2W7Y377ZRDIW7ZKD4MMMEPM' } },
    ...NONEVM_RAILS.map((r) => ({ x402Version: 2, scheme: 'exact', network: r.network, extra: { feePayer: `${name}-feepayer-${r.family}` } })),
  ];
  return {
    async getSupported() { return { kinds, extensions: [], signers: {} }; },
    async verify(_p, req) { calls.push([name, req.network]); return { isValid: false, invalidReason: 'stub_refused' }; },
    async settle(_p, req) { calls.push(['SETTLE', name, req.network]); return { success: false, errorReason: 'stub', transaction: '', network: req.network }; },
  };
}
const nameFor = (cfg) => (cfg && cfg.url === FACILITATOR_URLS.ultravioleta ? 'ultravioleta' : cfg && cfg.url === FACILITATOR_URLS.payai ? 'payai' : cfg && cfg.url === ALGO.facilitator ? 'goplausible' : 'cdp');

async function boot(t, extraEnv) {
  const ENV = { X402_NETWORK: 'mainnet', FACILITATOR_URL: 'https://stub-cdp.invalid/x402', PAY_TO: '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', PAY_TO_EVM: '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6', X402_HF: 'off', X402_ARC: 'off', ...extraEnv };
  const names = [...Object.keys(ENV), ...Object.keys(PAYTOS), 'X402_NONEVM'];
  const keep = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  for (const k of names) delete process.env[k];
  Object.assign(process.env, ENV);
  t.after(() => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const calls = [], served = [];
  const layer = payments.buildPaymentLayer({ makeClient: (cfg) => stub(nameFor(cfg), calls) });
  const app = express();
  app.use(compat.stripNetworkSuffix); app.use(railContext); app.use(layer.middleware);
  app.get('/api/perp', (req, res) => { served.push(1); res.json({ ok: true }); });
  const srv = app.listen(0); t.after(() => srv.close());
  await new Promise((r) => srv.once('listening', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, calls, served, layer };
}

test('Phase B off: with no payTo set there is no non-EVM row, accept or suffix answer', async (t) => {
  const { base, layer } = await boot(t, {});
  assert.equal(layer.NONEVM.length, 0);
  for (const r of NONEVM_RAILS) {
    const c = dec((await fetch(`${base}/api/perp|${r.network}`)).headers.get('payment-required'));
    assert.ok(!c.accepts.some((a) => a.network === r.network), `${r.network} absent`);
  }
});

test('Phase B on: each family on request only, official requirement shapes, through Ultravioleta only, refused = 402 never served', async (t) => {
  const { base, calls, served, layer } = await boot(t, PAYTOS);
  assert.equal(layer.NONEVM.length, 6);
  const plain = dec((await fetch(`${base}/api/perp`)).headers.get('payment-required'));
  assert.ok(!plain.accepts.some((a) => NONEVM_RAILS.some((r) => r.network === a.network)), 'never in the default 402');
  for (const r of NONEVM_RAILS) {
    const c = dec((await fetch(`${base}/api/perp%7C${r.network}`)).headers.get('payment-required'));
    const a = c.accepts[c.accepts.length - 1];
    assert.equal(a.network, r.network);
    assert.equal(a.payTo, PAYTOS[r.env]);
    if (r.family === 'xrpl') {
      assert.deepEqual([a.asset, a.amount, a.extra.issuer, a.extra.areFeesSponsored], [r.token.currency, '0.005', r.token.issuer, false], 'XRPL: @x402/xrpl IOU shape');
    } else {
      assert.equal(a.asset, r.token.address);
      assert.equal(a.amount, String(0.005 * 10 ** r.token.decimals));
    }
    if (r.family === 'hedera' || r.family === 'sui' || r.family === 'svm') assert.equal(a.extra.feePayer, `ultravioleta-feepayer-${r.family}`, `${r.network}: Ultravioleta's fee payer`);
    calls.length = 0;
    const res = await fetch(`${base}/api/perp`, { headers: { 'payment-signature': enc({ x402Version: 2, resource: c.resource, accepted: a, payload: { transaction: 'AAAA' } }) } });
    assert.equal(res.status, 402, r.network);
    assert.deepEqual(calls, [['ultravioleta', r.network]], `${r.network}: verified by Ultravioleta only, nothing settled`);
  }
  assert.equal(served.length, 0);
  // the manifest marks every one as on request
  const { makeManifestAccepts } = require('../lib/manifest');
  const m = await makeManifestAccepts({ getLayer: () => layer })();
  const perp = m.get('GET /api/perp');
  for (const r of NONEVM_RAILS) assert.equal(perp.find((x) => x.network === r.network).on_request, `|${r.network}`);
  assert.equal(perp.find((x) => x.network === 'xrpl:0').price_usd, 0.005, 'XRPL decimal amount read as dollars');
});

test('Phase B: a payTo of the wrong shape refuses to boot its row', () => {
  assert.throws(() => nonEvmRails({ XRPL_PAY_TO: '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6' }), /XRPL_PAY_TO is not a XRPL account/);
  assert.throws(() => nonEvmRails({ HEDERA_PAY_TO: '0.0.x' }), /HEDERA_PAY_TO/);
  assert.equal(nonEvmRails({ ...PAYTOS, X402_NONEVM: 'off' }).length, 0);
});

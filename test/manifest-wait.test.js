// 15 Oct 2026, #95: the startup manifest build waits for every facilitator to report instead of firing on a 5 s timer.
//   unit   waitForFacilitators / startupManifest with a fake clock: backoff, the 60 s cap, one log line naming a silent facilitator,
//          and initialize() is never called.
//   real   the REAL buildPaymentLayer with all five facilitators behind it (CDP, Circle Arc, GoPlausible, Ultravioleta, PayAI;
//          the Circle client is the real class against a local server, the rest are stubs with a delay in getSupported). It shows
//          the old failure ("Facilitator does not support exact on eip155:1329") when the build runs too early, then the new
//          wait builds the manifest with every facilitator's networks, and no facilitator is asked for /supported twice.
'use strict';
require('./helpers/box-dbs-scratch');   // R35: a dev machine has no /opt/overhang/overhang.db (tools/overhang.js opens it at require time)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { waitForFacilitators, startupManifest, makeManifestAccepts } = require('../lib/manifest');

// ---- unit: a fake clock and a fake resource server
function fakeLayer({ readyAtMs = {}, clock }) {
  const probes = [
    { name: 'cdp', network: 'solana:main' }, { name: 'circle', network: 'eip155:5042' }, { name: 'goplausible', network: 'algorand:x' },
    { name: 'ultravioleta', network: 'eip155:10' }, { name: 'payai', network: 'eip155:1329' },
  ];
  const calls = { initialize: 0, lookups: 0 };
  const resourceServer = {
    initialize() { calls.initialize++; throw new Error('initialize() must never be called by the manifest wait'); },
    getSupportedKind(v, network, scheme) {
      calls.lookups++;
      assert.equal(v, 2); assert.equal(scheme, 'exact');
      const p = probes.find((x) => x.network === network);
      const at = readyAtMs[p.name];
      return at !== undefined && clock.t >= at ? { x402Version: 2, scheme, network } : undefined;
    },
  };
  return { layer: { facilitatorProbes: probes, resourceServer }, calls };
}
const fakeClock = () => { const c = { t: 0, sleeps: [] }; c.now = () => c.t; c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; }; return c; };

test('#95 unit: all five report late (payai at 20 s): it waits with doubling backoff, builds on the poll after, and never calls initialize()', async () => {
  const clock = fakeClock();
  const { layer, calls } = fakeLayer({ clock, readyAtMs: { cdp: 0, circle: 100, goplausible: 2000, ultravioleta: 3000, payai: 20000 } });
  const r = await waitForFacilitators({ getLayer: () => layer, sleep: clock.sleep, now: clock.now });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(clock.sleeps.slice(0, 5), [500, 1000, 2000, 4000, 8000], 'doubling from 0.5 s');
  assert.ok(clock.sleeps.every((s) => s <= 8000), 'capped step');
  assert.ok(r.waitedMs >= 20000 && r.waitedMs < 29000, `ready within one step of the 20 s mark, waited ${r.waitedMs}`);
  assert.equal(calls.initialize, 0);
});

test('#95 unit: a facilitator that never reports -> waits exactly to the 60 s cap, a bounded number of polls, names it', async () => {
  const clock = fakeClock();
  const { layer, calls } = fakeLayer({ clock, readyAtMs: { cdp: 0, circle: 0, goplausible: 0, ultravioleta: 0 } }); // payai never
  const lines = [];
  const built = [];
  const out = await startupManifest({ getLayer: () => layer, manifestAccepts: async () => { built.push(1); return new Map(); }, log: (l) => lines.push(l), sleep: clock.sleep, now: clock.now });
  assert.equal(out, null);
  assert.equal(built.length, 0, 'no build attempt while a facilitator is silent');
  assert.equal(lines.length, 1, 'exactly one log line');
  assert.match(lines[0], /^\[manifest\] facilitator not reporting after 60 s: payai \(eip155:1329\);/);
  assert.ok(!/not built yet/.test(lines[0]));
  assert.equal(clock.t, 60000, 'stopped at the cap, the last sleep clipped to it');
  assert.ok(clock.sleeps.length <= 12, `bounded polling, ${clock.sleeps.length} sleeps`);
  assert.equal(calls.initialize, 0);
});

test('#95 unit: two silent facilitators are named in the same single line; control: one reporting facilitator is not named', async () => {
  const clock = fakeClock();
  const { layer } = fakeLayer({ clock, readyAtMs: { cdp: 0, circle: 0, goplausible: 0 } }); // ultravioleta and payai silent
  const lines = [];
  await startupManifest({ getLayer: () => layer, manifestAccepts: async () => new Map(), log: (l) => lines.push(l), capMs: 5000, sleep: clock.sleep, now: clock.now });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /facilitators not reporting after 5 s: ultravioleta \(eip155:10\), payai \(eip155:1329\);/);
  assert.ok(!/cdp|circle|goplausible/.test(lines[0]));
});

test('#95 unit: everyone ready -> builds at once and logs the success line; a build failure after everyone reported says so; no layer (payments off) builds at once', async () => {
  const clock = fakeClock();
  const { layer } = fakeLayer({ clock, readyAtMs: { cdp: 0, circle: 0, goplausible: 0, ultravioleta: 0, payai: 0 } });
  const lines = [];
  const m = await startupManifest({ getLayer: () => layer, manifestAccepts: async () => new Map([['a', []], ['b', []]]), log: (l) => lines.push(l), sleep: clock.sleep, now: clock.now });
  assert.equal(m.size, 2);
  assert.deepEqual(lines, ['[manifest] accepts built for 2 routes']);
  assert.deepEqual(clock.sleeps, [], 'no waiting when everyone has reported');
  const l2 = [];
  await startupManifest({ getLayer: () => layer, manifestAccepts: async () => { throw new Error('boom'); }, log: (l) => l2.push(l), sleep: clock.sleep, now: clock.now });
  assert.deepEqual(l2, ['[manifest] build failed after every facilitator reported: boom']);
  const l3 = [];
  await startupManifest({ getLayer: () => null, manifestAccepts: async () => new Map(), log: (l) => l3.push(l), sleep: clock.sleep, now: clock.now });
  assert.deepEqual(l3, ['[manifest] accepts built for 0 routes']);
});

// ---- real: the actual payment layer with five facilitators
const payments = require('../payments');
const rails = require('../lib/rails');
const { FACILITATOR_URLS } = require('../lib/ext-rails');
const { EXT_RAILS } = require('../lib/ext-rails');
const { SOLANA_MAINNET_CAIP2 } = (() => { try { return require('@x402/svm'); } catch { return {}; } })();

const PAY_TO = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const PAY_TO_EVM = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const ALGO = rails.algoRail({});
const FEE_PAYER = 'D6ZhtNQ5nT9ZnTHUbqXZsTx5MH2rPFiBBggX4hY1WePM';
const SOL = SOLANA_MAINNET_CAIP2 || 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const sleepMs = (ms) => new Promise((r) => { setTimeout(r, ms).unref(); }); // unref: a stub that answers after the test is over must not hold the process

/** A stub facilitator that claims every network and answers getSupported after `delayMs`; counts those calls. */
function delayedStub(name, delayMs, counts) {
  const evm = ['eip155:8453', 'eip155:137', 'eip155:42161', ...EXT_RAILS.map((r) => r.network)];
  const kinds = [
    { x402Version: 2, scheme: 'exact', network: SOL, extra: { feePayer: FEE_PAYER } },
    ...evm.map((network) => ({ x402Version: 2, scheme: 'exact', network })),
    { x402Version: 2, scheme: 'exact', network: ALGO.network, extra: { feePayer: 'QWOWU2E6BB76HEQRRMXWZ2MU4HAQIYZWEPP2W7Y377ZRDIW7ZKD4MMMEPM' } },
  ];
  return {
    name,
    async getSupported() { counts[name] = (counts[name] || 0) + 1; await sleepMs(delayMs); return { kinds, extensions: [], signers: {} }; },
    async verify() { return { isValid: false, invalidReason: 'stub' }; },
    async settle() { return { success: false, errorReason: 'stub', transaction: '', network: 'x' }; },
  };
}
const nameFor = (cfg) => (cfg && cfg.url === FACILITATOR_URLS.ultravioleta ? 'ultravioleta' : cfg && cfg.url === FACILITATOR_URLS.payai ? 'payai' : cfg && cfg.url === ALGO.facilitator ? 'goplausible' : 'cdp');

async function fiveFacilitatorLayer(t, delays) {
  const { generatePrivateKey } = require('viem/accounts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-manifest-'));
  const keyFile = path.join(dir, 'arc.key');
  fs.writeFileSync(keyFile, generatePrivateKey(), { mode: 0o600 });
  const counts = {};
  const circle = http.createServer((req, res) => {
    counts.circle = (counts.circle || 0) + 1;
    setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:5042' }], extensions: [], signers: {} })); }, delays.circle);
  });
  await new Promise((r) => circle.listen(0, '127.0.0.1', r));
  t.after(() => { circle.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ENV = { X402_NETWORK: 'mainnet', FACILITATOR_URL: 'https://stub-cdp.invalid/x402', PAY_TO, PAY_TO_EVM, X402_HF: 'off', ARC_PAYTO_KEY: keyFile, CIRCLE_FACILITATOR_URL: `http://127.0.0.1:${circle.address().port}/v1/facilitator/x402` };
  const UNSET = ['X402_ARC', 'X402_EXT', 'X402_EXT_NETWORKS', 'X402_PAYAI', 'X402_ULTRAVIOLETA', 'X402_EVM_NETWORKS', 'X402_ALGO', 'CIRCLE_API_KEY'];
  const keep = {};
  for (const k of [...Object.keys(ENV), ...UNSET]) keep[k] = process.env[k];
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  for (const k of UNSET) delete process.env[k];
  t.after(() => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const layer = payments.buildPaymentLayer({ makeClient: (cfg) => { const n = nameFor(cfg); return delayedStub(n, delays[n] || 0, counts); } });
  return { layer, counts };
}

test('#95 real layer: five facilitators, payai answers last; an early build fails as it did on 15 Oct, the wait builds it with every facilitator\'s networks, no second /supported', async (t) => {
  const origWarn = console.warn; const origLog = console.log; console.log = () => {}; console.warn = () => {};
  t.after(() => { console.log = origLog; console.warn = origWarn; });
  const { layer, counts } = await fiveFacilitatorLayer(t, { cdp: 0, circle: 100, goplausible: 150, ultravioleta: 0, payai: 1500 });
  console.log = origLog;
  assert.deepEqual(layer.facilitatorProbes.map((p) => p.name), ['cdp', 'circle', 'goplausible', 'ultravioleta', 'payai']);
  assert.deepEqual(layer.facilitatorProbes.slice(1).map((p) => p.network), ['eip155:5042', ALGO.network, 'eip155:10', 'eip155:1329']);
  const manifestAccepts = makeManifestAccepts({ getLayer: () => layer });
  // the old failure: a build after four facilitators answered and before the last one did (the 5 s timer lost this race at 09:28:55)
  for (let i = 0; i < 300 && !layer.resourceServer.getSupportedKind(2, 'eip155:10', 'exact'); i++) await sleepMs(20); // until ultravioleta, the fourth, has reported
  assert.ok(layer.resourceServer.getSupportedKind(2, 'eip155:10', 'exact'), 'four facilitators have reported');
  await assert.rejects(() => manifestAccepts(), /Facilitator does not support exact on eip155:(1329|196)/);
  assert.equal(layer.resourceServer.getSupportedKind(2, 'eip155:1329', 'exact'), undefined, 'payai has not reported yet');
  const lines = [];
  const t0 = Date.now();
  const m = await startupManifest({ getLayer: () => layer, manifestAccepts, log: (l) => lines.push(l), capMs: 20000 });
  const waited = Date.now() - t0;
  assert.ok(m && m.size === Object.keys(layer.routes).length && m.size > 80, `built for ${m && m.size} routes`);
  assert.deepEqual(lines, [`[manifest] accepts built for ${m.size} routes`]);
  assert.ok(!lines.some((l) => /not built yet/.test(l)));
  assert.ok(waited >= 100 && waited < 8000, `waited ${waited} ms: for payai only (about 1.5 s after it started), not a fixed 5 s`);
  const nets = new Set([...m.values()].flat().map((a) => a.network));
  for (const n of [SOL, 'eip155:5042', ALGO.network, 'eip155:10', 'eip155:1329']) assert.ok(nets.has(n), `${n} is in the manifest`);
  for (const p of layer.facilitatorProbes) assert.ok(layer.resourceServer.getSupportedKind(2, p.network, 'exact'), `${p.name} reported`);
  // never a second initialize(): each facilitator was asked for /supported exactly once
  assert.deepEqual(counts, { cdp: 1, circle: 1, goplausible: 1, ultravioleta: 1, payai: 1 });
});

test('#95 real layer: a facilitator that never answers -> one line naming it after the cap, no manifest, the others unaffected', async (t) => {
  const origWarn = console.warn; const origLog = console.log; console.log = () => {}; console.warn = () => {};
  t.after(() => { console.log = origLog; console.warn = origWarn; });
  const { layer } = await fiveFacilitatorLayer(t, { cdp: 0, circle: 0, goplausible: 0, ultravioleta: 0, payai: 60000 }); // payai answers long after the cap
  console.log = origLog;
  // initialize() reads the facilitators one after another, so a silent one also holds back those after it. payai is last here: wait until the
  // four before it have reported (condition-based, so a loaded machine cannot make this flaky), then give payai only the 1 s cap.
  for (let i = 0; i < 1000 && !layer.resourceServer.getSupportedKind(2, 'eip155:10', 'exact'); i++) await sleepMs(20);
  const lines = [];
  let built = 0;
  await startupManifest({ getLayer: () => layer, manifestAccepts: async () => { built++; return new Map(); }, log: (l) => lines.push(l), capMs: 1000 });
  assert.equal(built, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[manifest\] facilitator not reporting after 1 s: payai \(eip155:1329\);/);
  assert.ok(layer.resourceServer.getSupportedKind(2, 'eip155:10', 'exact'), 'ultravioleta did report');
});

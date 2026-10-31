// R23 T3: the dedicated x402-test wallet (31 Oct 2026): the generator, the lazy loader, the refusal of treasuries and own wallets, the balance reads.
// Only fresh random keys in temp directories are used here. No existing key (Gack9, the treasuries, any payer) is read, and the tests never print a key.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const nodeModule = require('module');
const S = require('./fixtures/r23/x402/seller');
const W = require('../tools/r23/x402/wallet');
const T = require('../tools/r23/x402/test');
const OWN = require('../lib/own-traffic');
const { makeSpend } = require('../tools/r23/spend');

const ROOT = path.join(__dirname, '..');
const GEN = path.join(ROOT, 'ops', 'r23-x402-wallet-gen.mjs');
const tmpDirs = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x402wal-')); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const mode = (p) => fs.statSync(p).mode & 0o777;
const gen = (dir) => spawnSync(process.execPath, [GEN], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), X402TEST_WALLET_DIR: dir }, encoding: 'utf8', cwd: ROOT });
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const b58 = (bytes) => require('@solana/kit').getBase58Decoder().decode(Uint8Array.from(bytes));

// ================= the generator
test('generator: makes both keys in a 700 directory with 600 files, prints only the two public addresses (which are the files\' addresses), and no key byte appears in stdout or stderr', async () => {
  const dir = path.join(mkTmp(), 'wallet');
  const r = gen(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(mode(dir).toString(8), '700'); assert.equal(mode(path.join(dir, 'base.key')).toString(8), '600'); assert.equal(mode(path.join(dir, 'solana.json')).toString(8), '600');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['base.key', 'solana.json']);
  const w = await W.loadWallets({ dir, env: {}, own: new Set(), treasuries: new Set() });
  assert.deepEqual(w.problems, []);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 4, 'a header line, the two addresses, and the two addresses as the JSON of tools/r23/x402/test-wallet.json');
  assert.equal(lines[1].trim(), `base   ${w.base.address}`); assert.equal(lines[2].trim(), `solana ${w.solana.address}`);
  assert.deepEqual(JSON.parse(lines[3].replace(/^tools\/r23\/x402\/test-wallet\.json: /, '')), { base: w.base.address, solana: w.solana.address }, 'the last line is the committable file');
  // every form the key could be printed in
  const hex = fs.readFileSync(path.join(dir, 'base.key'), 'utf8').trim();
  const arr = JSON.parse(fs.readFileSync(path.join(dir, 'solana.json'), 'utf8'));
  assert.equal(arr.length, 64); assert.match(hex, /^0x[0-9a-f]{64}$/);
  const needles = {
    'base hex with 0x': hex, 'base hex without 0x': hex.slice(2), 'base hex upper': hex.slice(2).toUpperCase(),
    'solana array text': JSON.stringify(arr), 'solana array no brackets': arr.join(','), 'solana seed hex': Buffer.from(arr.slice(0, 32)).toString('hex'), 'solana seed base58': b58(arr.slice(0, 32)), 'solana keypair base58': b58(arr),
    'solana seed base64': Buffer.from(arr.slice(0, 32)).toString('base64'), 'solana keypair base64': Buffer.from(arr).toString('base64'),
  };
  const contains = (hay, needle) => hay.includes(needle) || hay.toLowerCase().includes(needle.toLowerCase());
  for (const [what, needle] of Object.entries(needles)) {
    // G1: the search finds the needle when it IS present (known positive), and only then is its absence believed
    assert.ok(contains(`prefix ${needle} suffix`, needle), `${what}: the search matches a known positive`);
    assert.ok(!contains(r.stdout, needle), `${what} is not in stdout`); assert.ok(!contains(r.stderr, needle), `${what} is not in stderr`);
  }
  assert.ok(!/[0-9a-fA-F]{64}/.test(r.stdout), 'no 64-hex run at all in stdout'); assert.ok(/[0-9a-fA-F]{64}/.test(`x${hex.slice(2)}`), 'the 64-hex regex matches a known positive');
  assert.match(lines[1], /0x[0-9a-fA-F]{40}$/);
});
test('generator: a second run refuses, exits 2, prints nothing on stdout, and changes nothing (hashes and modes identical); a partial wallet is refused too and nothing is added', () => {
  const dir = path.join(mkTmp(), 'wallet');
  assert.equal(gen(dir).status, 0);
  const before = { b: sha(path.join(dir, 'base.key')), s: sha(path.join(dir, 'solana.json')), mb: fs.statSync(path.join(dir, 'base.key')).mtimeMs, ms: fs.statSync(path.join(dir, 'solana.json')).mtimeMs };
  const r = gen(dir);
  assert.equal(r.status, 2); assert.equal(r.stdout, ''); assert.match(r.stderr, /refusing to run: .*already exist/); assert.match(r.stderr, /Nothing was written or changed/);
  assert.deepEqual({ b: sha(path.join(dir, 'base.key')), s: sha(path.join(dir, 'solana.json')), mb: fs.statSync(path.join(dir, 'base.key')).mtimeMs, ms: fs.statSync(path.join(dir, 'solana.json')).mtimeMs }, before);
  assert.equal(mode(path.join(dir, 'base.key')).toString(8), '600');
  // partial: only base.key exists -> refused, solana.json is NOT created; the file is untouched
  const dir2 = path.join(mkTmp(), 'w2'); fs.mkdirSync(dir2, { mode: 0o700 }); fs.writeFileSync(path.join(dir2, 'base.key'), 'placeholder\n', { mode: 0o600 });
  const r2 = gen(dir2);
  assert.equal(r2.status, 2); assert.deepEqual(fs.readdirSync(dir2), ['base.key']); assert.equal(fs.readFileSync(path.join(dir2, 'base.key'), 'utf8'), 'placeholder\n');
  // and an existing directory with loose permissions is tightened to 700
  const dir3 = path.join(mkTmp(), 'w3'); fs.mkdirSync(dir3, { mode: 0o755 }); fs.chmodSync(dir3, 0o755);
  assert.equal(gen(dir3).status, 0); assert.equal(mode(dir3).toString(8), '700');
});
test('generator: two runs make two different wallets (fresh random keys, not a derived or fixed one)', async () => {
  const a = path.join(mkTmp(), 'a'); const b = path.join(mkTmp(), 'b');
  assert.equal(gen(a).status, 0); assert.equal(gen(b).status, 0);
  const wa = await W.loadWallets({ dir: a, env: {}, own: new Set(), treasuries: new Set() }); const wb = await W.loadWallets({ dir: b, env: {}, own: new Set(), treasuries: new Set() });
  assert.notEqual(wa.base.address, wb.base.address); assert.notEqual(wa.solana.address, wb.solana.address);
  assert.notEqual(sha(path.join(a, 'base.key')), sha(path.join(b, 'base.key')));
});

// ================= the loader
test('loader: reads per call (a replaced key file is seen at once, nothing cached) and loads nothing at require time (a fresh process that requires both routes reads no key file)', async () => {
  const dir = path.join(mkTmp(), 'wallet'); assert.equal(gen(dir).status, 0);
  const first = (await W.loadWallets({ dir, env: {}, own: new Set(), treasuries: new Set() })).base.address;
  const { generatePrivateKey } = require('viem/accounts');
  fs.writeFileSync(path.join(dir, 'base.key'), `${generatePrivateKey()}\n`, { mode: 0o600 });
  const second = (await W.loadWallets({ dir, env: {}, own: new Set(), treasuries: new Set() })).base.address;
  assert.notEqual(first, second, 'the new key file is read on the next call');
  // require time: hook fs.readFileSync / readFileSync in a child and require the routes
  const probe = `
    const fs = require('fs'); const reads = []; const r = fs.readFileSync; fs.readFileSync = function (p, ...a) { reads.push(String(p)); return r.call(this, p, ...a); };
    const e = fs.existsSync; let exists = []; fs.existsSync = function (p) { exists.push(String(p)); return e.call(this, p); };
    require(${JSON.stringify(path.join(ROOT, 'tools/r23/x402/index.js'))});
    process.stdout.write(JSON.stringify({ keyReads: reads.filter((p) => p.startsWith(${JSON.stringify(dir)})), keyExists: exists.filter((p) => p.startsWith(${JSON.stringify(dir)})) }));`;
  const out = spawnSync(process.execPath, ['-e', probe], { env: { PATH: process.env.PATH, X402TEST_WALLET_DIR: dir }, encoding: 'utf8', cwd: ROOT });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { keyReads: [], keyExists: [] }, 'requiring the routes touches no key file');
});
test('loader: a key file readable by group or others, a malformed one and a wrong-length keypair are refused with a reason; the other chain still loads; no file text ever appears in a result', async () => {
  const dir = path.join(mkTmp(), 'wallet'); assert.equal(gen(dir).status, 0);
  const ok = async (d = dir) => W.loadWallets({ dir: d, env: {}, own: new Set(), treasuries: new Set() });
  let w = await ok(); assert.ok(w.base && w.solana);
  fs.chmodSync(path.join(dir, 'base.key'), 0o644);
  w = await ok(); assert.equal(w.base, null); assert.ok(w.solana); assert.deepEqual(w.problems, [{ chain: 'base', reason: 'the key file is readable by group or others; it must be mode 600' }]);
  fs.chmodSync(path.join(dir, 'base.key'), 0o600);
  const secretText = 'SECRET-KEY-TEXT-0123456789abcdef';
  fs.writeFileSync(path.join(dir, 'base.key'), `${secretText}\n`, { mode: 0o600 }); fs.writeFileSync(path.join(dir, 'solana.json'), JSON.stringify([1, 2, 3]), { mode: 0o600 });
  w = await ok(); assert.equal(w.base, null); assert.equal(w.solana, null); assert.equal(w.problems.length, 2);
  assert.ok(!JSON.stringify(w).includes(secretText), 'the file text is not in the result');
  assert.ok(JSON.stringify(w).includes('not a 0x and 64 hex key'), 'the reason is'); assert.ok(JSON.stringify(w.problems).includes('not a 64-byte keypair array'));
  // a Solana keypair whose public half does not belong to its seed is refused by the signer constructor
  const bytes = Array.from(crypto.randomBytes(64));
  fs.writeFileSync(path.join(dir, 'solana.json'), JSON.stringify(bytes), { mode: 0o600 });
  w = await ok(); assert.equal(w.solana, null);
  // nothing set up: no problem is reported, the chains are simply absent
  const empty = await ok(mkTmp()); assert.deepEqual(empty, { base: null, solana: null, problems: [] });
});
test('route level: a key file that is garbage leaves the route at 503 "Not charged", the seller is never contacted, and neither the error nor the console carries the file text', async () => {
  const dir = path.join(mkTmp(), 'wallet'); fs.mkdirSync(dir, { mode: 0o700 });
  const secretText = 'SECRET-KEY-TEXT-fedcba9876543210';
  fs.writeFileSync(path.join(dir, 'base.key'), `${secretText}\n`, { mode: 0o600 });
  const sel = S.makeSeller({}); const tr = S.stubTransport(sel.script);
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    const e = await T.runTest({ url: `https://${S.HOST}${S.PATH}` }, { env: { X402TEST_WALLET_DIR: dir }, spend: makeSpend({ file: ':memory:', caps: { x402test: { perCall: 0.05, perDay: 2 } } }) }).catch((x) => x);
    assert.equal(e.status, 503); assert.match(e.message, /not usable right now\. Not charged\.$/); assert.equal(sel.log.length, 0);
    assert.ok(!e.message.includes(secretText) && !logged.join('\n').includes(secretText), 'no file text in the error or the log'); assert.match(logged.join('\n'), /wallet files refused.*base/);
    // nothing at all in the directory -> "not set up"
    const e2 = await T.runTest({ url: `https://${S.HOST}${S.PATH}` }, { env: { X402TEST_WALLET_DIR: path.join(dir, 'nope') } }).catch((x) => x);
    assert.equal(e2.status, 503); assert.match(e2.message, /not set up\. Not charged\.$/); assert.equal(sel.log.length, 0);
  } finally { console.error = orig; tr.restore(); }
});

// ================= never use an existing wallet
const knownAddr = { gack9: 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu', cj7: '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', e6e6: '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6' };
test('refusal: every address on lib/own-traffic.js\'s list is refused (any case), the two treasuries are refused as treasuries, PAY_TO* of the environment too; an unrelated address is not (control)', () => {
  assert.ok(OWN.OWN_WALLET_LIST.length >= 7);
  for (const a of OWN.OWN_WALLET_LIST) {
    assert.equal(W.refusal(a, { env: {} }), 'own wallet', a);
    if (a.startsWith('0x')) { assert.equal(W.refusal(a.toLowerCase(), { env: {} }), 'own wallet', `${a} lower`); assert.equal(W.refusal(`0x${a.slice(2).toUpperCase()}`, { env: {} }), 'own wallet', `${a} upper`); }
  }
  assert.equal(W.refusal(knownAddr.gack9, { env: {} }), 'own wallet');
  assert.equal(W.refusal(knownAddr.cj7, { env: {} }), 'treasury'); assert.equal(W.refusal(knownAddr.e6e6, { env: {} }), 'treasury'); assert.equal(W.refusal(knownAddr.e6e6.toLowerCase(), { env: {} }), 'treasury');
  assert.equal(W.refusal('0x9999999999999999999999999999999999999999', { env: { PAY_TO_EVM: '0x9999999999999999999999999999999999999999' } }), 'treasury', 'a payTo of the environment is a treasury');
  assert.equal(W.refusal('0x0Cf44185564F2b72E291050DC79E578429E52f83', { env: {} }), 'treasury', 'the Arc payTo of the live challenge'); assert.equal(W.refusal('0xBa3056eC310658e42dFb8a0Fa349C5406212bE37', { env: {} }), 'treasury');
  assert.equal(W.refusal('0x9999999999999999999999999999999999999998', { env: { X402TEST_REFUSE_ADDRESSES: '0x9999999999999999999999999999999999999998' } }), 'treasury', 'X402TEST_REFUSE_ADDRESSES adds to the list');
  assert.equal(W.refusal(S.PAY_TO_SOL_2, { env: { PAY_TO: S.PAY_TO_SOL_2 } }), 'treasury'); assert.equal(W.refusal('0x9999999999999999999999999999999999999999', { env: {} }), null, 'an unrelated address is allowed');
  assert.equal(W.refusal('SomeUnrelatedAddress1111111111111111111111111', { env: {} }), null);
});
test('refusal: a key file whose address is an own wallet or a treasury is NOT loaded; lifting the own-wallet refusal for an exact address works and never lifts a treasury', async () => {
  const dir = path.join(mkTmp(), 'wallet'); assert.equal(gen(dir).status, 0);
  const real = await W.loadWallets({ dir, env: {}, own: new Set(), treasuries: new Set() });
  const [b, s] = [real.base.address, real.solana.address];
  // control: with empty lists both load
  assert.ok(real.base && real.solana);
  // the wallet's own address put on the own-wallet list: refused, with the reason
  let w = await W.loadWallets({ dir, env: {}, own: new Set([b.toLowerCase(), s]), treasuries: new Set() });
  assert.equal(w.base, null); assert.equal(w.solana, null); assert.deepEqual(w.problems.map((p) => p.reason), ['the address in the key file is on the own-wallet list', 'the address in the key file is on the own-wallet list']);
  // the same through the REAL list: a list that holds the address (patched in for the run)
  const list = OWN.OWN_WALLET_LIST; list.push(b, s);
  try {
    w = await W.loadWallets({ dir, env: {}, own: undefined, treasuries: new Set() });
    assert.equal(w.base, null, 'lib/own-traffic.js\'s own list is consulted'); assert.equal(w.solana, null);
    // lifted for the exact addresses: loads again
    w = await W.loadWallets({ dir, env: { X402TEST_ALLOW_OWN_ADDRESS: `${b.toLowerCase()}, ${s}` }, own: undefined, treasuries: new Set() });
    assert.ok(w.base && w.solana, 'the exemption lifts the own-wallet refusal for exactly those addresses');
    w = await W.loadWallets({ dir, env: { X402TEST_ALLOW_OWN_ADDRESS: s }, own: undefined, treasuries: new Set() });
    assert.equal(w.base, null, 'the exemption is per address'); assert.ok(w.solana);
  } finally { list.splice(list.length - 2, 2); }
  assert.ok(!OWN.OWN_WALLET_LIST.includes(b), 'the real list is restored');
  // a treasury: refused, and the exemption does not apply
  w = await W.loadWallets({ dir, env: { PAY_TO_EVM: b, PAY_TO: s, X402TEST_ALLOW_OWN_ADDRESS: `${b},${s}` }, own: new Set([b, s]) });
  assert.equal(w.base, null); assert.equal(w.solana, null); assert.deepEqual(w.problems.map((p) => p.reason), ['the address in the key file is a treasury address', 'the address in the key file is a treasury address']);
  // route level: an own-wallet key makes the route a 503 and the seller is never contacted
  const sel = S.makeSeller({}); const tr = S.stubTransport(sel.script); const orig = console.error; console.error = () => {};
  try {
    const e = await T.runTest({ url: `https://${S.HOST}${S.PATH}` }, { env: { X402TEST_WALLET_DIR: dir, PAY_TO_EVM: b, PAY_TO: s } }).catch((x) => x);
    assert.equal(e.status, 503); assert.match(e.message, /not usable/); assert.equal(sel.log.length, 0);
  } finally { console.error = orig; tr.restore(); }
});

// ================= balances
test('Solana ATA: the account the balance is read from is the one @solana-program/token derives (a fixed vector and the generated wallet)', async () => {
  const { findAssociatedTokenPda } = nodeModule.createRequire(require.resolve('@x402/svm'))('@solana-program/token');
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  for (const owner of [knownAddr.cj7, S.PAY_TO_SOL, S.FEE_PAYER]) {
    const [want] = await findAssociatedTokenPda({ mint: USDC, owner, tokenProgram: W.TOKEN_PROGRAM });
    assert.equal(await W.usdcAta(owner), want, owner);
  }
  assert.notEqual(await W.usdcAta(S.PAY_TO_SOL), await W.usdcAta(S.FEE_PAYER));
});
test('Solana balance: a good answer, a never-created account (zero), and every other failure is a 503 "Not charged" (never zero)', async () => {
  const owner = S.FEE_PAYER;
  const rpcOf = (f) => async (method, params) => { assert.equal(method, 'getTokenAccountBalance'); assert.equal(params[0], await W.usdcAta(owner)); return f(); };
  assert.equal(await W.solanaUsdcBalance(owner, { rpc: rpcOf(() => ({ value: { amount: '12345', decimals: 6, uiAmount: 0.012345 } })) }), 12345n);
  assert.equal(await W.solanaUsdcBalance(owner, { rpc: rpcOf(() => { throw new Error('solana rpc: Invalid param: could not find account'); }) }), 0n, 'no token account means nothing was ever sent');
  for (const [what, f] of [['transport', () => { throw Object.assign(new Error('solana rpc http 429. Not charged.'), { status: 503 }); }], ['odd shape', () => ({ value: {} })], ['null', () => null], ['wrong decimals', () => ({ value: { amount: '5', decimals: 9 } })], ['non-digit amount', () => ({ value: { amount: '5e3', decimals: 6 } })]]) {
    const e = await W.solanaUsdcBalance(owner, { rpc: rpcOf(f) }).catch((x) => x);
    assert.equal(e.status, 503, what); assert.match(e.message, /Not charged\.$/, what);
  }
});
test('Solana balance through the real lib/solrpc.js against a loopback JSON-RPC: the request is getTokenAccountBalance of the derived account', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { const j = JSON.parse(b); seen.push(j); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { context: { slot: 1 }, value: { amount: '777000', decimals: 6, uiAmount: 0.777 } } })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const solrpc = require('../lib/solrpc'); const saved = { u: process.env.SOLANA_RPC_URL, f: process.env.RPC_FALLBACKS };
  process.env.SOLANA_RPC_URL = `http://127.0.0.1:${srv.address().port}`; process.env.RPC_FALLBACKS = ''; solrpc._reset();
  try {
    assert.equal(await W.solanaUsdcBalance(S.FEE_PAYER), 777000n);
    assert.equal(seen[0].method, 'getTokenAccountBalance'); assert.equal(seen[0].params[0], await W.usdcAta(S.FEE_PAYER));
  } finally { for (const [k, v] of [['SOLANA_RPC_URL', saved.u], ['RPC_FALLBACKS', saved.f]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } solrpc._reset(); srv.close(); }
});
test('Base balance: eth_call balanceOf on the Base USDC contract with the padded address; a failed read is a 503 in every shape (HTTP error, RPC error, junk result, timeout), never zero', async () => {
  const owner = '0x00000000000000000000000000000000000000Ab';
  let mode_ = 'ok'; const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b); seen.push(j);
      if (mode_ === 'hang') return;
      if (mode_ === 'http') { res.statusCode = 502; return res.end('bad gateway'); }
      res.setHeader('content-type', 'application/json');
      if (mode_ === 'rpcerror') return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }));
      if (mode_ === 'junk') return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'not hex' }));
      if (mode_ === 'notjson') return res.end('<html>');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${(2500000n).toString(16)}` }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const env = { X402TEST_BASE_RPC: `http://127.0.0.1:${srv.address().port}` };
  try {
    assert.equal(await W.baseUsdcBalance(owner, { env }), 2500000n);
    assert.equal(seen[0].method, 'eth_call'); assert.equal(seen[0].params[0].to, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'); assert.equal(seen[0].params[0].data, `0x70a08231${'0'.repeat(62)}ab`); assert.equal(seen[0].params[1], 'latest');
    assert.equal(seen[0].params[0].data.length, 2 + 8 + 64);
    for (const m of ['http', 'rpcerror', 'junk', 'notjson', 'hang']) {
      mode_ = m;
      const e = await W.baseUsdcBalance(owner, { env, timeoutMs: 200 }).catch((x) => x);
      assert.equal(e.status, 503, m); assert.match(e.message, /Base balance of the test wallet could not be read.*Not charged\.$/, m);
    }
    await assert.rejects(W.baseUsdcBalance('0x123', { env }), /not an EVM address/);
  } finally { srv.closeAllConnections(); srv.close(); }
});

// ================= the tracked file of the dedicated wallet's public addresses (tools/r23/x402/test-wallet.json)
test('dedicated file: a key whose address is on the own list is accepted when it equals the file\'s address for the SAME chain, with no environment variable; every negative control refuses', async () => {
  const dir = path.join(mkTmp(), 'wallet'); assert.equal(gen(dir).status, 0);
  const real = await W.loadWallets({ dir, env: {}, own: new Set(), treasuries: new Set(), dedicated: {} });
  const [b, s] = [real.base.address, real.solana.address];
  const fileOf = (o) => { const f = path.join(mkTmp(), 'test-wallet.json'); fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o)); return f; };
  const list = OWN.OWN_WALLET_LIST; list.push(b, s);       // lib/own-traffic.js lists the dedicated wallet, as the lead will
  const load = (dedicatedFile, env = {}, extra = {}) => W.loadWallets({ dir, env, own: undefined, treasuries: undefined, dedicated: W.dedicatedWallets(dedicatedFile), ...extra });
  try {
    // control: listed on the own wallet list and nothing lifts it -> refused on both chains
    let w = await load('/nonexistent/test-wallet.json');
    assert.equal(w.base, null); assert.equal(w.solana, null); assert.equal(w.problems.length, 2, 'file absent: refused');
    // the file names both addresses -> both load, no environment variable
    w = await load(fileOf({ base: b, solana: s }));
    assert.ok(w.base && w.solana, JSON.stringify(w.problems)); assert.deepEqual(w.problems, []); assert.equal(w.base.address, b); assert.equal(w.solana.address, s);
    // a lower-case EVM address in the file is the same wallet
    w = await load(fileOf({ base: b.toLowerCase(), solana: s })); assert.ok(w.base && w.solana);
    // the lift is per chain: a file that names only the Base address leaves the Solana key refused, and the reverse
    w = await load(fileOf({ base: b })); assert.ok(w.base); assert.equal(w.solana, null);
    w = await load(fileOf({ solana: s })); assert.equal(w.base, null); assert.ok(w.solana);
    // the address differs: another address of the right format in the file does not lift it
    w = await load(fileOf({ base: '0x1111111111111111111111111111111111111111', solana: S.PAY_TO_SOL_2 })); assert.equal(w.base, null); assert.equal(w.solana, null);
    // the other chain's address in the wrong slot is not an address of that chain
    w = await load(fileOf({ base: s, solana: b })); assert.equal(w.base, null); assert.equal(w.solana, null);
    // a file that is not JSON, an array, a string, or has non-string values lifts nothing
    for (const bad of ['not json', '[]', '"x"', 'null', JSON.stringify({ base: 5, solana: ['x'] }), '']) { w = await load(fileOf(bad)); assert.equal(w.base, null, bad); assert.equal(w.solana, null, bad); }
    // the file's address equals a TREASURY (the manifest's payTo): refused as a treasury, the file cannot lift it
    w = await load(fileOf({ base: b, solana: s }), { PAY_TO_EVM: b, PAY_TO: s });
    assert.equal(w.base, null); assert.equal(w.solana, null); assert.deepEqual(w.problems.map((p) => p.reason), ['the address in the key file is a treasury address', 'the address in the key file is a treasury address']);
    w = await load(fileOf({ base: b, solana: s }), { X402TEST_REFUSE_ADDRESSES: `${b},${s}` }); assert.equal(w.base, null); assert.equal(w.solana, null);
    // what the reader returns: addresses of the right format only, EVM lower-cased, anything else null
    assert.deepEqual(W.dedicatedWallets(fileOf({ base: '0x123', solana: 'abc' })), { base: null, solana: null });
    assert.deepEqual(W.dedicatedWallets(fileOf({ base: b, solana: s })), { base: b.toLowerCase(), solana: s });
    assert.deepEqual(W.dedicatedWallets(fileOf({ base: s, solana: b })), { base: null, solana: null });
    // the file is read per call: rewriting it is seen at once
    const f = fileOf({ base: b, solana: s }); assert.ok((await load(f)).base); fs.writeFileSync(f, '{}'); assert.equal((await load(f)).base, null);
  } finally { list.splice(list.length - 2, 2); }
  assert.ok(!OWN.OWN_WALLET_LIST.includes(b), 'the real list is restored');
  // not on the own list at all: the file is not needed (a fresh wallet loads with no file)
  const plain = await W.loadWallets({ dir, env: {}, own: undefined, treasuries: undefined, dedicated: {} }); assert.ok(plain.base && plain.solana);
});
test('dedicated file: it can never lift Gack9 or any own wallet that existed before the dedicated one, nor a treasury; the environment variable cannot either; each of those is still on the real list', () => {
  assert.equal(W.PROTECTED_OWN.length, 7);
  for (const a of W.PROTECTED_OWN) assert.ok(OWN.OWN_WALLET_LIST.some((x) => x.toLowerCase() === a.toLowerCase()), `${a} is still on lib/own-traffic.js's list (drift check)`);
  assert.ok(W.PROTECTED_OWN.includes(knownAddr.gack9));
  for (const a of W.PROTECTED_OWN) {
    const chain = a.startsWith('0x') ? 'base' : 'solana';
    assert.equal(W.refusal(a, { env: {}, chain, dedicated: { [chain]: a } }), 'own wallet', `${a}: named in the file for its own chain`);
    assert.equal(W.refusal(a, { env: {}, chain: chain === 'base' ? 'solana' : 'base', dedicated: { base: a, solana: a } }), 'own wallet', `${a}: named for the other chain`);
    assert.equal(W.refusal(a, { env: { X402TEST_ALLOW_OWN_ADDRESS: a }, chain, dedicated: {} }), 'own wallet', `${a}: named in X402TEST_ALLOW_OWN_ADDRESS`);
  }
  for (const a of [knownAddr.cj7, knownAddr.e6e6, '0x0Cf44185564F2b72E291050DC79E578429E52f83', '0xBa3056eC310658e42dFb8a0Fa349C5406212bE37']) {
    const chain = a.startsWith('0x') ? 'base' : 'solana';
    assert.equal(W.refusal(a, { env: { X402TEST_ALLOW_OWN_ADDRESS: a }, chain, dedicated: { [chain]: a }, own: new Set([a.toLowerCase()]) }), 'treasury', a);
  }
  // control: an address on the own list that is not protected IS lifted by the file for its chain, and only for its chain
  const x = '0x7777777777777777777777777777777777777777';
  assert.equal(W.refusal(x, { env: {}, chain: 'base', dedicated: { base: x }, own: new Set([x]), treasuries: new Set() }), null);
  assert.equal(W.refusal(x, { env: {}, chain: 'solana', dedicated: { base: x }, own: new Set([x]), treasuries: new Set() }), 'own wallet');
  assert.equal(W.refusal(x, { env: {}, dedicated: { base: x }, own: new Set([x]), treasuries: new Set() }), 'own wallet', 'no chain, no lift');
});
test('dedicated file: the default path is tools/r23/x402/test-wallet.json, read per call by the loader when no override is given (a hooked read stands in for the committed file)', async () => {
  assert.equal(W.DEDICATED_FILE, path.join(ROOT, 'tools', 'r23', 'x402', 'test-wallet.json'));
  const dir = path.join(mkTmp(), 'wallet'); assert.equal(gen(dir).status, 0);
  const real = await W.loadWallets({ dir, env: {}, own: new Set(), treasuries: new Set(), dedicated: {} });
  const [b, s] = [real.base.address, real.solana.address];
  const list = OWN.OWN_WALLET_LIST; list.push(b, s);
  const orig = fs.readFileSync; let reads = 0;
  fs.readFileSync = function (p, ...a) { if (String(p) === W.DEDICATED_FILE) { reads++; return JSON.stringify({ base: b, solana: s }); } return orig.call(this, p, ...a); };
  try {
    const w = await W.loadWallets({ dir, env: {} });         // no override, no environment variable
    assert.ok(w.base && w.solana, JSON.stringify(w.problems)); assert.equal(reads, 1, 'the file was read once for this call');
    await W.loadWallets({ dir, env: {} }); assert.equal(reads, 2, 'and again for the next: nothing cached');
  } finally { fs.readFileSync = orig; list.splice(list.length - 2, 2); }
  const w2 = await W.loadWallets({ dir, env: {} });         // the real default: no committed file or a file of other addresses
  assert.ok(!OWN.OWN_WALLET_LIST.includes(b)); assert.ok(w2.base && w2.solana, 'a wallet that is not on the list needs no file');
});

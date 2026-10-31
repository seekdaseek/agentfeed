// ops/r23-x402-rss.js: resident memory of the two x402 routes (R23 T3, 31 Oct 2026). One fresh process per run:
//   node --expose-gc ops/r23-x402-rss.js <lint|base|solana> [preload]   (run it 3 times per mode)
// It reads rss (after a gc) before the routes are required, runs 20 calls and reads rss again. `lint` is 20 lints; `base` and `solana` are 20 paid tests with an ephemeral in-memory wallet
// (no key file, no network: an inline seller and, for solana, a loopback JSON-RPC). With `preload` the libraries the real server already holds (viem, @solana/kit, @x402/*, zod,
// better-sqlite3) are required before the first reading, which is the increase the routes add to the server. Prints one JSON line.
'use strict';
const path = require('path');
const http = require('http');
const mode = process.argv[2] || 'lint';
const rq = require('module').createRequire(path.join(__dirname, '..', 'package.json'));   // resolves the packages the way the server does, subpath exports included
const preload = process.argv[3] === 'preload';
const ROOT = path.join(__dirname, '..');
const mb = (n) => Math.round((n / 1048576) * 10) / 10;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

(async () => {
  if (preload) {
    for (const m of ['viem', 'viem/accounts', '@solana/kit', '@x402/fetch', '@x402/evm/exact/client', '@x402/evm/exact/v1/client', '@x402/svm', '@x402/svm/exact/client', '@x402/svm/exact/v1/client', 'zod', 'better-sqlite3']) rq(m);
    require(path.join(ROOT, 'lib', 'safe-fetch.js')); require(path.join(ROOT, 'lib', 'own-traffic.js'));
  }
  let rpcUrl; let rpcSrv;
  if (mode === 'solana') {
    const K = rq('@solana/kit');
    const mint = Buffer.alloc(82); mint.writeBigUInt64LE(1000000n, 36); mint[44] = 6; mint[45] = 1;
    const blockhash = K.getBase58Decoder().decode(Uint8Array.from({ length: 32 }, (_, i) => i + 7));
    rpcSrv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { const j = JSON.parse(b); res.setHeader('content-type', 'application/json');
      const result = j.method === 'getAccountInfo' ? { context: { slot: 1 }, value: { data: [mint.toString('base64'), 'base64'], executable: false, lamports: 1, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 82 } } : { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 1000 } };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result })); }); });
    await new Promise((r) => rpcSrv.listen(0, '127.0.0.1', r)); rpcUrl = `http://127.0.0.1:${rpcSrv.address().port}`;
  }
  // wallets made before the first reading are not the routes' memory; they are created in the routes' own libraries, so they only matter for the fresh-process figure
  let wallet = null;
  if (mode !== 'lint') {
    const { generatePrivateKey, privateKeyToAccount } = rq('viem/accounts');
    const K = rq('@solana/kit');
    const { toClientSvmSigner } = rq('@x402/svm');
    const a = privateKeyToAccount(generatePrivateKey()); const kp = await K.generateKeyPairSigner();
    wallet = { base: { chain: 'base', address: a.address, signer: a }, solana: { chain: 'solana', address: kp.address, signer: toClientSvmSigner(kp) }, problems: [] };
  }
  global.gc(); const rss0 = process.memoryUsage().rss;

  const { entries } = require(path.join(ROOT, 'tools/r23/x402/index.js'));
  const lintEntry = entries.find((e) => e.name === 'get_x402_lint'); const testEntry = entries.find((e) => e.name === 'get_x402_test');
  const base = { scheme: 'exact', network: 'eip155:8453', amount: '5000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: `0x${'55'.repeat(20)}`, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } };
  const sol = { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '5000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'ComputeBudget111111111111111111111111111111', maxTimeoutSeconds: 300, extra: { feePayer: 'DN3L5t4cfHdzLDprZN2QdBuqEKyFumsVquYeRY42mh2T' } };
  const accept = mode === 'solana' ? sol : base;
  const URL_ = 'https://api.example.com/v1/data';
  const challenge = { x402Version: 2, error: 'Payment required', resource: { url: URL_, description: 'Rss fixture', mimeType: 'application/json' }, accepts: [accept] };
  const hdr402 = { 'payment-required': b64(challenge), 'content-type': 'application/json', 'cache-control': 'no-store' };
  const fetch = async (url, o) => {
    const u = new URL(url); const h = o.headers || {};
    if (o.method === 'HEAD') return { url, status: 402, contentType: 'application/json', headers: hdr402, body: Buffer.alloc(0) };
    if (u.pathname !== '/v1/data') return { url, status: 404, contentType: 'text/plain', headers: {}, body: Buffer.from('nf') };
    if (h['PAYMENT-SIGNATURE']) {
      const payer = mode === 'solana' ? wallet.solana.address : wallet.base.address;
      const tx = mode === 'solana' ? rq('@solana/kit').getBase58Decoder().decode(new Uint8Array(64).fill(7)) : `0x${'ab'.repeat(32)}`;
      return { url, status: 200, contentType: 'application/json', headers: { 'payment-response': b64({ success: true, transaction: tx, network: accept.network, payer }) }, body: Buffer.from('{"ok":true,"rows":[1,2,3]}') };
    }
    return { url, status: 402, contentType: 'application/json', headers: hdr402, body: Buffer.from('{}') };
  };
  const { makeSpend } = require(path.join(ROOT, 'tools/r23/spend.js'));
  const spend = mode === 'lint' ? null : makeSpend({ file: ':memory:', caps: { x402test: { perCall: 0.05, perDay: 1000 } } });
  const deps = { fetch, ...(mode === 'lint' ? {} : { loadWallets: async () => wallet, balance: { base: async () => 10n ** 9n, solana: async () => 10n ** 9n }, spend, caps: { perCall: 0.05, perDay: 1000 }, solanaRpcUrl: rpcUrl, checkUrl: undefined }) };
  const { makeEntries: mkLint } = require(path.join(ROOT, 'tools/r23/x402-lint.js')); const { makeEntries: mkTest } = require(path.join(ROOT, 'tools/r23/x402-test.js'));
  const route = mode === 'lint' ? mkLint(deps)[0] : mkTest(deps)[0];
  void lintEntry; void testEntry;
  let last;
  const N = Number(process.env.CALLS) || 20;
  for (let i = 0; i < N; i++) last = await route.run({ url: URL_ });
  global.gc(); const rss1 = process.memoryUsage().rss;
  console.log(JSON.stringify({ mode, preload, calls: N, verdict: last.verdict, rss_before_mb: mb(rss0), rss_after_mb: mb(rss1), delta_mb: mb(rss1 - rss0) }));
  if (rpcSrv) { rpcSrv.closeAllConnections(); rpcSrv.close(); }
  if (spend) spend.close();
})().catch((e) => { console.error('measurement failed:', e && e.message); process.exit(1); });

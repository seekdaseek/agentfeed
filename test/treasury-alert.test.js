// ops/af-digest.js treasuryAlert (R22, 30 Oct 2026): the USDC account of every Solana payTo in the manifest exists, or ONE Telegram line, then quiet for an hour.
// On 30 Oct the treasury's USDC account was closed by a wallet cleanup (08:10:41Z, recreated 10:35:14Z) and every Solana payment would have been refused meanwhile.
// No Telegram, no real network: send is a stub, the RPC is injected or a loopback stub, the manifest is a loopback server.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
process.env.OVERHANG_DB_PATH = process.env.OVERHANG_DB_PATH || path.join(os.tmpdir(), 'none.db');
process.env.AF_SERVICE_ENV = path.join(os.tmpdir(), 'no-such-agentfeed.env');   // loadRpcEnv must not read the box's file in a test
const { treasuryAlert, solanaPayTos, usdcAccountOf } = require('../ops/af-digest');
const { startRpcStub } = require('./helpers/rpc-stub');

const TREASURY = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TREASURY_ATA = 'HqbmBbnEQVN1xhjXM3uqBbJQf1zTrLnTp5dG9teBaz5z';   // the account closed at 08:10:41Z on 30 Oct 2026 (tx 4QbYAp4m...), recreated 10:35:14Z
const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const MANIFEST = { resources: [
  { accepts: [{ network: SOL, payTo: TREASURY, asset: USDC }, { network: 'eip155:8453', payTo: '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }] },
  { accepts: [{ network: SOL, payTo: TREASURY, asset: USDC }, { network: SOL, payTo: undefined, asset: USDC }, { network: 'eip155:137', payTo: TREASURY, asset: USDC }] },
] };
const harness = (ok = true) => { const sent = [], logs = []; return { sent, logs, io: { send: async (t) => { sent.push(t); return ok; }, log: (l) => logs.push(l) } }; };
const rpcWith = (value) => async () => ({ context: { slot: 1 }, value });

test('known positive: the derived account for the treasury and USDC is the one that was closed on 30 Oct (so a missing answer means this address)', async () => {
  assert.equal(await usdcAccountOf(TREASURY, USDC), TREASURY_ATA);
});

test('solanaPayTos: one entry per distinct Solana payTo and asset; EVM accepts and incomplete ones are ignored', () => {
  assert.deepEqual(solanaPayTos(MANIFEST), [{ payTo: TREASURY, asset: USDC }]);
  assert.deepEqual(solanaPayTos({ resources: [{ accepts: [{ network: SOL, payTo: 'A', asset: USDC }, { network: SOL, payTo: 'B', asset: USDC }] }] }).map((x) => x.payTo), ['A', 'B']);
  assert.deepEqual(solanaPayTos({}), []);
});

test('missing: one line naming the account and the payTo, and no secret; then quiet for an hour; after the hour it says it again', async () => {
  const h = harness(), st = {}, io = { ...h.io, targets: solanaPayTos(MANIFEST), rpc: rpcWith(null) };
  assert.equal(await treasuryAlert(st, NOW, io), 1);
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0].includes(TREASURY_ATA) && h.sent[0].includes(TREASURY) && !/\n/.test(h.sent[0]), h.sent[0]);
  assert.doesNotMatch(h.sent[0], /bot\d|api\.telegram|TG_BOT_TOKEN|api-key|helius/i);
  assert.equal(await treasuryAlert(st, NOW + 5 * 60e3, io), 0);
  assert.equal(await treasuryAlert(st, NOW + 59 * 60e3, io), 0);
  assert.equal(h.sent.length, 1, 'quiet inside the hour');
  assert.equal(await treasuryAlert(st, NOW + 61 * 60e3, io), 1);
  assert.equal(h.sent.length, 2, 'again after the hour');
});

test('present: nothing sent; and when it comes back the state is cleared, so the next closure alerts at once', async () => {
  const h = harness(), st = {}, targets = solanaPayTos(MANIFEST);
  assert.equal(await treasuryAlert(st, NOW, { ...h.io, targets, rpc: rpcWith(null) }), 1);
  assert.equal(await treasuryAlert(st, NOW + 60e3, { ...h.io, targets, rpc: rpcWith({ owner: 'Tokenkeg', lamports: 1 }) }), 0);
  assert.deepEqual(st.treasury, {}, 'back: forgotten');
  assert.match(h.logs.join('\n'), /is back/);
  assert.equal(await treasuryAlert(st, NOW + 120e3, { ...h.io, targets, rpc: rpcWith(null) }), 1, 'closed again inside the hour: alerts at once');
  assert.equal(h.sent.length, 2);
});

test('an RPC error, or an answer of an unexpected shape, is not a missing account: no line, no state', async () => {
  const h = harness(), st = {}, targets = solanaPayTos(MANIFEST);
  assert.equal(await treasuryAlert(st, NOW, { ...h.io, targets, rpc: async () => { throw new Error('solana rpc http 429'); } }), 0);
  assert.equal(await treasuryAlert(st, NOW, { ...h.io, targets, rpc: async () => null }), 0);
  assert.equal(await treasuryAlert(st, NOW, { ...h.io, targets, rpc: async () => ({ context: {} }) }), 0);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(st.treasury, {});
  assert.equal((h.logs.join('\n').match(/not reported as missing/g) || []).length, 3);
});

test('a failed Telegram send leaves the state alone, so the next run tries again', async () => {
  const bad = harness(false), st = {}, targets = solanaPayTos(MANIFEST);
  assert.equal(await treasuryAlert(st, NOW, { ...bad.io, targets, rpc: rpcWith(null) }), 0);
  assert.deepEqual(st.treasury, {});
  const good = harness(true);
  assert.equal(await treasuryAlert(st, NOW + 5 * 60e3, { ...good.io, targets, rpc: rpcWith(null) }), 1);
});

test('only Solana USDC is checked: another asset is skipped, and a manifest without a Solana payTo says so and sends nothing', async () => {
  const h = harness();
  assert.equal(await treasuryAlert({}, NOW, { ...h.io, targets: [{ payTo: TREASURY, asset: 'So11111111111111111111111111111111111111112' }], rpc: rpcWith(null) }), 0);
  assert.match(h.logs.join('\n'), /no Solana USDC payTo/);
  assert.deepEqual(h.sent, []);
});

test('end to end through lib/solrpc and a loopback manifest: missing alerts; present is quiet; a provider that refuses (429) is an error, not a missing account', async (t) => {
  const manifest = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(MANIFEST)); });
  await new Promise((r) => manifest.listen(0, '127.0.0.1', r));
  t.after(() => manifest.close());
  process.env.AF_MANIFEST_URL = `http://127.0.0.1:${manifest.address().port}/.well-known/x402.json`;
  const solrpc = require('../lib/solrpc');
  const run = async (stubOpts) => {
    const stub = await startRpcStub(stubOpts);
    process.env.SOLANA_RPC_URL = stub.url; delete process.env.HELIUS_API_KEY; process.env.RPC_FALLBACKS = '';   // '' = no fallback: unset would add the public RPC, a real connection
    solrpc._reset();
    const h = harness();
    try { return { alerts: await treasuryAlert({}, NOW, h.io), h, stub }; } finally { stub.close(); }
  };
  const missing = await run({ mode: 'ok' });
  assert.equal(missing.alerts, 1);
  assert.ok(missing.h.sent[0].includes(TREASURY_ATA));
  assert.equal(missing.stub.count('getAccountInfo'), 1, 'one read for the one distinct Solana payTo');
  const present = await run({ mode: 'ok', accountPresent: true });
  assert.equal(present.alerts, 0);
  assert.deepEqual(present.h.sent, []);
  const refused = await run({ mode: 'capped' });
  assert.equal(refused.alerts, 0);
  assert.deepEqual(refused.h.sent, []);
  assert.match(refused.h.logs.join('\n'), /rpc error .*not reported as missing/);
  assert.ok(refused.stub.count('getAccountInfo') >= 1, 'it did ask the loopback provider, and nothing else');
  solrpc._reset();
});

test('wired into --alert: a dry run of the real CLI says the account is missing when it is, and reports it present when it is (loopback manifest and RPC)', async (t) => {
  const { execFile } = require('child_process');
  const fs = require('fs');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treasury-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbf = path.join(dir, 'af.db');
  const db = new Database(dbf);
  db.exec('CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL, status TEXT NOT NULL, latency_ms INTEGER, ip TEXT, error_msg TEXT, req_host TEXT, req_path TEXT, user_agent TEXT, method TEXT)');
  db.close();
  const cal = path.join(dir, 'cal.json');
  fs.writeFileSync(cal, JSON.stringify({ fetched_at: new Date(Date.now() - 86400_000).toISOString(), coins: {} }));   // young: the calibration line stays silent
  const manifest = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(MANIFEST)); });
  await new Promise((r) => manifest.listen(0, '127.0.0.1', r));
  t.after(() => manifest.close());
  const run = async (stubOpts) => {
    const stub = await startRpcStub(stubOpts);
    try {
      return await new Promise((resolve) => execFile(process.execPath, [path.join(__dirname, '..', 'ops', 'af-digest.js'), '--alert', '--dry'], { encoding: 'utf8', env: {
        PATH: process.env.PATH, AGENTFEED_DB: dbf, AF_DIGEST_STATE: path.join(dir, 'state.json'), BRIEF_CALIBRATION: cal, OVERHANG_DB_PATH: process.env.OVERHANG_DB_PATH,
        AF_MANIFEST_URL: `http://127.0.0.1:${manifest.address().port}/.well-known/x402.json`, SOLANA_RPC_URL: stub.url, RPC_FALLBACKS: '', AF_SERVICE_ENV: path.join(dir, 'none.env') } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
    } finally { stub.close(); }
  };
  const missing = await run({ mode: 'ok' });
  assert.equal(missing.code, 0, missing.stderr);
  assert.match(missing.stdout, new RegExp(`would send ---\\nAgentFeed: the USDC account ${TREASURY_ATA} of the Solana payTo ${TREASURY} does not exist`));
  const present = await run({ mode: 'ok', accountPresent: true });
  assert.equal(present.code, 0, present.stderr);
  assert.match(present.stdout, /treasury usdc check \(dry\): 1 Solana payTo, 1 account\(s\) present, 0 alert\(s\)/);
  assert.doesNotMatch(present.stdout, /the USDC account/);
});

test('the default manifest the cron reads is the local service: the port af-digest.js names is the port server.js listens on by default', () => {
  const fs = require('fs');
  const digest = fs.readFileSync(path.join(__dirname, '..', 'ops', 'af-digest.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const port = /process\.env\.AF_MANIFEST_URL \|\| 'http:\/\/127\.0\.0\.1:(\d+)\/\.well-known\/x402\.json'/.exec(digest);
  assert.ok(port, 'the default manifest URL is a loopback URL of the well-known manifest');
  assert.match(server, new RegExp(`process\\.env\\.PORT \\|\\| ${port[1]}\\b`), `server.js listens on ${port[1]} by default`);
});

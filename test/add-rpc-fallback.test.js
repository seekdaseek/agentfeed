// R20h (30 Oct 2026): ops/add-rpc-fallback.sh puts a keyed Solana RPC provider into the failover chain from ONE command. The provider URL (with its key) arrives on stdin and
// is never printed; the provider is probed BEFORE .env is touched (getSlot, and getTokenLargestAccounts, the method the public RPC refuses); .env is backed up, the mode kept,
// exactly one RPC_FALLBACKS line written. Nothing here restarts anything: AF_RESTART_CMD stands in for the pm2 cycle.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startRpcStub } = require('./helpers/rpc-stub');

const SCRIPT = path.resolve(__dirname, '..', 'ops', 'add-rpc-fallback.sh');
const SECRET = 'SECRETKEY0123456789abcdefABCDEF';

function envDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addrpc-'));
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=3006\nHELIUS_API_KEY=old-helius-value\nRPC_FALLBACKS=https://old.example/fallback\nMPP_RPC_URL=https://api.mainnet-beta.solana.com\n', { mode: 0o600 });
  fs.chmodSync(path.join(dir, '.env'), 0o600);
  return dir;
}
function run(dir, stdin) {
  return new Promise((resolve) => {
    const c = spawn('bash', [SCRIPT], { env: { PATH: process.env.PATH, AF_DIR: dir, AF_RESTART_CMD: `echo restarted > "${dir}/restarted.flag"`, AF_NO_CHECK: '1' } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
    c.stdin.end(stdin);
  });
}

test('a provider that serves getSlot and getTokenLargestAccounts is written once, keyed first and the public RPC last, with a backup, the file mode kept and a restart; the URL is never printed', async () => {
  const stub = await startRpcStub({ mode: 'ok' });
  const dir = envDir();
  const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  try {
    const url = `${stub.url}/v2/${SECRET}`;
    const r = await run(dir, url + '\n');
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes(SECRET) && !r.out.includes(url), 'the URL (and its key) is not in the output');
    assert.match(r.out, /getSlot: ok/);
    assert.match(r.out, /getTokenLargestAccounts: ok \(3 accounts\)/);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.equal(env.split('\n').filter((l) => l.startsWith('RPC_FALLBACKS=')).length, 1, 'exactly one RPC_FALLBACKS line');
    assert.ok(env.includes(`RPC_FALLBACKS=${url},https://api.mainnet-beta.solana.com\n`));
    for (const keep of ['PORT=3006', 'HELIUS_API_KEY=old-helius-value', 'MPP_RPC_URL=https://api.mainnet-beta.solana.com']) assert.ok(env.includes(keep + '\n'), `${keep} untouched`);
    assert.ok(!env.includes('old.example'), 'the old RPC_FALLBACKS line is replaced');
    assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600, 'the mode is kept');
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('.env.bak-pre-rpc-fallbacks-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), before, 'the backup is the old file, byte for byte');
    assert.ok(fs.existsSync(path.join(dir, 'restarted.flag')), 'the restart command ran');
    assert.equal(stub.count('getTokenLargestAccounts'), 1);
  } finally { stub.close(); }
});

test('a provider that refuses the heavy method (the public RPC\'s answer), is capped, or does not answer is NOT written: .env unchanged, no backup, no restart, no URL printed', async () => {
  for (const [label, opts] of [['refuses getTokenLargestAccounts', { mode: 'public', refuse: ['getTokenLargestAccounts'] }], ['out of credits', { mode: 'capped' }]]) {
    const stub = await startRpcStub(opts);
    const dir = envDir();
    const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    try {
      const url = `${stub.url}/v2/${SECRET}`;
      const r = await run(dir, url + '\n');
      assert.equal(r.code, 1, `${label}: ${r.out}`);
      assert.match(r.out, /FAILED/);
      assert.match(r.out, /\.env was NOT changed/);
      assert.ok(!r.out.includes(SECRET), `${label}: no key in the output`);
      assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before, `${label}: .env untouched`);
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== '.env'), [], `${label}: no backup, no flag, no temp file`);
    } finally { stub.close(); }
  }
  const dir = envDir();
  const r = await run(dir, 'https://127.0.0.1:1/v2/' + SECRET + '\n');   // nothing listens there
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes(SECRET));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== '.env'), []);
});

test('bad input is refused before anything runs: no URL, a plain http URL to a remote host', async () => {
  for (const stdin of ['', '\n', 'http://example.com/v2/' + SECRET + '\n', 'solana-mainnet.g.alchemy.com/v2/' + SECRET + '\n']) {
    const dir = envDir();
    const r = await run(dir, stdin);
    assert.equal(r.code, 2, JSON.stringify(stdin) + ' ' + r.out);
    assert.ok(!r.out.includes(SECRET));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== '.env'), []);
  }
});

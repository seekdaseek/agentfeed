// R24 item 4: the module NEVER signs and NEVER sends. This test scans the source of tools/r24/txprecheck/ (and the existing files it calls) for any call that could: a send or sign method, key handling,
// a wallet client. A scanner is only evidence if it matches a known positive, so each pattern is first run against a planted call of its kind; a second scan lists every JSON-RPC method the module
// names and fails on any that is not on the read-only allowlist.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'tools', 'r24', 'txprecheck');
const CALLED = ['tools/tokenrisk.js', 'tools/honeypot.js', 'lib/solrpc.js'].map((f) => path.join(ROOT, f));          // existing code the module calls

// [name, pattern, a planted call of that kind]
const FORBIDDEN = [
  ['sendTransaction', /sendTransaction/i, 'await connection.sendTransaction(tx)'],
  ['sendRawTransaction', /sendRawTransaction/i, "rpc('sendRawTransaction', [b64])"],
  ['eth_sendRawTransaction', /eth_sendRawTransaction/i, "request('eth_sendRawTransaction', [signed])"],
  ['eth_sendTransaction', /eth_sendTransaction/i, "request('eth_sendTransaction', [tx])"],
  ['signTransaction', /signTransaction/i, 'const s = await wallet.signTransaction(tx)'],
  ['signMessage / signTypedData', /sign(Message|TypedData|Bytes|AndSend)/i, 'client.signTypedData(typed)'],
  ['sendAndConfirm', /sendAndConfirm/i, 'sendAndConfirmTransactionFactory({ rpc })'],
  ['bundles and user operations', /(sendBundle|sendUserOperation|wallet_sendCalls|sendTransactionWithoutConfirming)/i, "request('eth_sendBundle', [])"],
  ['a sign call', /\b(sign|signer\.sign|\.sign)\s*\(/, 'const sig = key.sign(message)'],
  ['key material', /(privateKey|secretKey|keypair|mnemonic|seedPhrase|generateKeyPair|createKeyPairFromBytes|privateKeyToAccount)/i, 'const k = Keypair.fromSecretKey(bytes)'],
  ['a wallet client', /(createWalletClient|walletClient|writeContract|sendTransactionSync)/i, 'createWalletClient({ account, transport })'],
  ['a key environment variable', /process\.env\.[A-Z_]*(PRIVATE|SECRET|MNEMONIC|WALLET_KEY|KEYPAIR)/, 'process.env.PAYER_PRIVATE_KEY'],
];
const scan = (source) => FORBIDDEN.filter(([, re]) => re.test(source)).map(([name]) => name);
const files = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));

test('positive control: the scanner matches a planted call of every forbidden kind, and does not match plain read-only code', () => {
  for (const [name, re, planted] of FORBIDDEN) {
    assert.ok(re.test(planted), `${name}: the pattern must match its planted call (${planted})`);
    assert.ok(scan(`// a module\nfunction x() {\n  ${planted}\n}\n`).includes(name), `${name}: the scanner must report it inside a file`);
  }
  assert.deepEqual(scan("const out = await rpc('simulateTransaction', [b64, { sigVerify: false }]);\nconst signers = keys.filter((k) => k.signer);\nrequest('eth_simulateV1', params);"), [], 'read-only code is clean');
});

test('negative control: a file with a planted send call is reported by the same directory scan the real check uses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosend-'));
  try {
    fs.writeFileSync(path.join(dir, 'clean.js'), "module.exports = () => rpc('simulateTransaction', []);\n");
    fs.writeFileSync(path.join(dir, 'planted.js'), "module.exports = (tx) => rpc('sendTransaction', [tx]);\n");
    const hits = files(dir).map((f) => [path.basename(f), scan(fs.readFileSync(f, 'utf8'))]).filter(([, h]) => h.length);
    assert.deepEqual(hits, [['planted.js', ['sendTransaction']]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the module contains no call that signs or sends, and holds no key material', () => {
  const fl = files(DIR);
  assert.ok(fl.length >= 12, `the scan covers the whole module (${fl.length} files)`);
  const hits = fl.map((f) => [path.relative(ROOT, f), scan(fs.readFileSync(f, 'utf8'))]).filter(([, h]) => h.length);
  assert.deepEqual(hits, []);
  const called = CALLED.map((f) => [path.relative(ROOT, f), scan(fs.readFileSync(f, 'utf8'))]).filter(([, h]) => h.length);
  assert.deepEqual(called, [], 'nor does the existing code it calls (the token-risk reads and the Solana RPC helper)');
});

test('every JSON-RPC method the module names is on the read-only allowlist (positive control: a planted write method is not)', () => {
  const ALLOW = new Set(['eth_getBlockByNumber', 'eth_simulateV1', 'eth_call', 'eth_getCode', 'eth_getTransactionCount', 'getMultipleAccounts', 'simulateTransaction']);
  const names = (src) => {
    const out = new Set();
    for (const m of src.matchAll(/['"`]((?:eth|debug|trace|net|web3|wallet|personal|engine|txpool|alchemy)_[A-Za-z0-9]+)['"`]/g)) out.add(m[1]);
    for (const m of src.matchAll(/\b(?:rpc|deps\.rpc|request)\(\s*['"`]([A-Za-z0-9_]+)['"`]/g)) out.add(m[1]);
    return [...out];
  };
  const planted = names("request('eth_sendRawTransaction', []); deps.rpc('sendTransaction', []); const x = 'debug_traceCall';");
  assert.deepEqual(planted.sort(), ['debug_traceCall', 'eth_sendRawTransaction', 'sendTransaction'], 'the extractor finds planted names of every spelling it is meant to');
  assert.ok(planted.every((n) => !ALLOW.has(n)));
  const found = new Set();
  for (const f of files(DIR)) for (const n of names(fs.readFileSync(f, 'utf8'))) found.add(n);
  assert.deepEqual([...found].filter((n) => !ALLOW.has(n)), [], 'only allowlisted methods');
  assert.deepEqual([...ALLOW].filter((n) => !found.has(n)), [], 'and every allowlisted method is really used (the allowlist is not padded)');
});

test('the only network access in the module is the fixed Base endpoint list and the repo\'s Solana helper: no caller-supplied URL is fetched', () => {
  const src = files(DIR).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const fetches = [...src.matchAll(/\bfetch(?:Impl)?\s*\(/g)].length;
  assert.ok(fetches >= 1);
  const only = files(DIR).filter((f) => /\bfetchImpl?\s*\(|globalThis\.fetch/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f));
  assert.deepEqual(only, ['base-rpc.js'], 'one file makes HTTP requests, and its URLs come from defaultUrls() (environment or the two fixed hosts), never from a query parameter');
  assert.ok(!/q\.(url|uri|endpoint|rpc)\b/i.test(src), 'no query parameter is used as an address to call');
});

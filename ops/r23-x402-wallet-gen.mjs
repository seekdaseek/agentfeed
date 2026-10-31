// ops/r23-x402-wallet-gen.mjs: make the NEW keypairs of the x402-test wallet (R23 T3, 31 Oct 2026). Run it ON THE BOX, once:
//   X402TEST_WALLET_DIR=/opt/agentfeed/x402-test-wallet node ops/r23-x402-wallet-gen.mjs
// It writes base.key (a 0x and 64 hex secp256k1 key, for Base) and solana.json (a 64-byte ed25519 keypair array, the format solana-keygen writes) into the directory (mode 700),
// both files mode 600, and prints ONLY the two public addresses (and them once more as the JSON of tools/r23/x402/test-wallet.json). It refuses to run when either file already exists and then changes nothing. It never prints, logs or returns key
// material, and never reads an existing key. These are fresh random keys: no existing wallet (the treasuries, Gack9, any payer) is involved.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createKeyPairSignerFromBytes, getBase58Decoder } from '@solana/kit';

const dir = process.env.X402TEST_WALLET_DIR || '/opt/agentfeed/x402-test-wallet';
const baseFile = path.join(dir, 'base.key');
const solFile = path.join(dir, 'solana.json');

const exists = [baseFile, solFile].filter((f) => fs.existsSync(f));
if (exists.length) {
  console.error(`refusing to run: ${exists.map((f) => path.basename(f)).join(' and ')} already exist(s) in ${dir}. Nothing was written or changed. Move the old wallet away on purpose if you really want a new one.`);
  process.exit(2);
}

// ---- generate both keys in memory first; nothing touches the disk until both are good
const baseKey = generatePrivateKey();
const baseAddress = privateKeyToAccount(baseKey).address;

const kp = crypto.generateKeyPairSync('ed25519');
const seed = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const keypairBytes = Uint8Array.from([...seed, ...pub]);
const solAddress = getBase58Decoder().decode(pub);
const check = await createKeyPairSignerFromBytes(keypairBytes);      // throws when the public half does not belong to the seed
if (check.address !== solAddress) { console.error('internal check failed: the Solana address does not match the keypair. Nothing was written.'); process.exit(3); }

// ---- write: directory 700, files 600, never over an existing file ('wx' fails if it exists)
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.chmodSync(dir, 0o700);
fs.writeFileSync(baseFile, `${baseKey}\n`, { flag: 'wx', mode: 0o600 });
fs.chmodSync(baseFile, 0o600);
fs.writeFileSync(solFile, JSON.stringify(Array.from(keypairBytes)), { flag: 'wx', mode: 0o600 });
fs.chmodSync(solFile, 0o600);

console.log(`x402-test wallet created in ${dir} (directory mode 700, key files mode 600). Public addresses:`);
console.log(`  base   ${baseAddress}`);
console.log(`  solana ${solAddress}`);
console.log(`tools/r23/x402/test-wallet.json: ${JSON.stringify({ base: baseAddress, solana: solAddress })}`);   // the two public addresses, ready to commit: they let the loader accept these keys although lib/own-traffic.js lists them

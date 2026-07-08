// gen-wallet.mjs — create a throwaway devnet payer keypair -> payer-wallet.json
// Fund it with devnet USDC at https://faucet.circle.com (select Solana Devnet).
// No SOL needed: the facilitator pays gas.
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createKeyPairSignerFromBytes } from '@solana/kit';

const kp = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey));
const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
const seed = pkcs8.slice(pkcs8.length - 32);
const secret = new Uint8Array(64);
secret.set(seed, 0);
secret.set(raw, 32);
fs.writeFileSync('payer-wallet.json', JSON.stringify([...secret]));

const signer = await createKeyPairSignerFromBytes(secret);
console.log('payer-wallet.json written');
console.log('address:', signer.address);
console.log('fund with devnet USDC: https://faucet.circle.com');

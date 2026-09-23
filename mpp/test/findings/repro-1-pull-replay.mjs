// FINDINGS #1 reproduction — @solana/mpp 0.7.0 (npm `latest`) pull path.
//
// Presents ONE real, already-settled pull credential TWICE against the SAME
// server instance and the SAME store. §11.6: "A signature that has been
// consumed MUST NOT be accepted again." The second presentation must be
// refused before anything is acted on.
//
// Prereq: /tmp/afstub/credential.txt holds a real credential captured from a
// completed sandbox payment, and MPP_SECRET_KEY matches the server that issued it.
// Run: node mpp/test/findings/repro-1-pull-replay.mjs
import fs from 'node:fs';
import { Mppx, solana, Store } from '@solana/mpp/server';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TP = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const R = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';

const credential = fs.readFileSync('/tmp/afstub/credential.txt', 'utf8').trim();
const decoded = JSON.parse(Buffer.from(credential, 'base64url').toString());

const store = Store.memory();
const reads = [];
const traced = {
  get: (k) => { reads.push(['get', k]); return store.get(k); },
  put: (k, v) => { reads.push(['put', k]); return store.put(k, v); },
  delete: (k) => store.delete(k),
  update: (k, f) => { reads.push(['update', k]); return store.update(k, f); },
};

const x = Mppx.create({
  methods: [solana.charge({
    currency: USDC, decimals: 6, network: 'localnet', recipient: R,
    rpcUrl: 'https://402.surfnet.dev:8899', store: traced, tokenProgram: TP,
  })],
  realm: 'localhost',
  secretKey: process.env.MPP_SECRET_KEY,
});

const present = () =>
  x.charge({ amount: '1000', description: 'SOL spot price', scope: 'GET /api/sol-price' })(
    new Request('http://localhost:4009/api/sol-price', { headers: { Authorization: `Payment ${credential}` } }),
  );

console.log('credential type :', decoded.payload.type);
const first = await present();
console.log('first present   :', first.status);
const afterFirst = reads.length;
const second = await present();
console.log('second present  :', second.status);

console.log('\nstore operations during the SECOND presentation:');
const during = reads.slice(afterFirst);
console.log(during.length === 0 ? '  (none)' : during.map(([op, k]) => `  ${op} ${k}`).join('\n'));

const consultedBeforeActing = during.length > 0 && during[0][0] !== 'put';
console.log('\nconsumed-store consulted before acting on the replay:', consultedBeforeActing);
console.log(second.status === 200
  ? 'RESULT: the second presentation SETTLED — one payment, two grants (§11.6 violated)'
  : `RESULT: refused with ${second.status}, but ${consultedBeforeActing ? 'via the store' : 'NOT via the consumed store — the refusal came from the network, not the server'}`);

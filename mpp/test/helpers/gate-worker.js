// test/helpers/gate-worker.js — boot the MPP gate in a SEPARATE process against
// a shared SQLite file.
//
// This exists because @solana/mpp 0.7.0 guards push-mode replay with
// `withKeyLock`, a process-local promise map. Its own comment says so:
//
//   "Scope: single Node process. Multi-process/replica deployments sharing one
//    Store must back the consumed marker with an atomic reserve."
//
// A same-process concurrency test therefore cannot tell our atomic claim apart
// from upstream's mutex — both pass. Two processes sharing one database is the
// only arrangement where the mutex does nothing and the claim is the sole
// defence.
//
// env: DB_PATH, PORT, MODE=push|pull, VERIFY_DELAY_MS, SIGNATURE

const express = require('express');
const Database = require('better-sqlite3');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TREASURY = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const PAYER = 'EqRNNpKVpu6jm8iRTNa17Rht2TRTzCtNNz37M9m2Di1';
const TREASURY_ATA = 'HqbmBbnEQVN1xhjXM3uqBbJQf1zTrLnTp5dG9teBaz5z';
const PAYER_ATA = 'GVcCJrq1NYwZJa2N86DNjz5H2UscmBA8EXGQYryM8euo';

const SIGNATURE = process.env.SIGNATURE;
const VERIFY_DELAY_MS = Number(process.env.VERIFY_DELAY_MS || 120);
const RPC = process.env.MPP_RPC_URL;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = typeof url === 'string' ? url : String(url && url.url);
  if (!target.startsWith(RPC)) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const reply = (obj) => new Response(JSON.stringify({ id: 1, jsonrpc: '2.0', ...obj }));

  if (body.method === 'getLatestBlockhash') {
    return reply({ result: { value: { blockhash: 'ASUYmXrNLsEzHAttWdVwEw6LjxzJxVRo2UyPjCDrLEoB' } } });
  }
  if (body.method === 'simulateTransaction') return reply({ result: { value: { err: null, logs: [] } } });
  if (body.method === 'sendTransaction') {
    process.stdout.write('EVENT sendTransaction\n');
    return reply({ result: SIGNATURE });
  }
  if (body.method === 'getSignatureStatuses') {
    return reply({ result: { value: [{ confirmationStatus: 'confirmed', err: null }] } });
  }
  if (body.method === 'getTransaction') {
    // Upstream's on-chain verification sends JSON-RPC id 1; the gate's
    // post-settlement payer lookup tags itself 'mpp-payer-lookup'. They are
    // reported as different events so the race's "only the claim winner did
    // on-chain verification work" count stays a count of verifications.
    if (body.id === 'mpp-payer-lookup') {
      process.stdout.write('EVENT payerLookup\n');
    } else {
      process.stdout.write('EVENT getTransaction\n');
      await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
    }
    return reply({
      result: {
        meta: { err: null },
        transaction: {
          message: {
            // jsonParsed puts the fee payer first; feePayer:false makes it the
            // transfer authority too (§9.2).
            accountKeys: [
              { pubkey: PAYER, signer: true, source: 'transaction', writable: true },
              { pubkey: PAYER_ATA, signer: false, source: 'transaction', writable: true },
            ],
            instructions: [
              {
                program: 'spl-token',
                programId: TOKEN_PROGRAM,
                parsed: {
                  type: 'transferChecked',
                  info: {
                    authority: PAYER,
                    destination: TREASURY_ATA,
                    mint: USDC,
                    source: PAYER_ATA,
                    tokenAmount: { amount: '1000', decimals: 6 },
                  },
                },
              },
            ],
          },
        },
      },
    });
  }
  return reply({ result: null });
};

const mpp = require('../../index');
const PRICES = { 'GET /api/sol-price': { usd: 0.001, tool: 'get_sol_price', desc: 'SOL spot price' } };

(async () => {
  const db = new Database(process.env.DB_PATH);
  // busy_timeout FIRST: switching journal_mode itself takes an exclusive lock,
  // so setting the timeout afterwards is too late when two workers open the
  // same file at once.
  db.pragma('busy_timeout = 5000');
  // journal_mode is NOT set here on purpose: SQLite refuses to switch into or
  // out of WAL while another connection has the file open, and busy_timeout
  // does not rescue that. The database is created and put into WAL once,
  // before any worker starts — which is also how production works.
  // Both workers race to create this; IF NOT EXISTS makes that safe.
  db.exec(`CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tool TEXT, status TEXT,
    payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL)`);

  await mpp.init({ db, prices: PRICES, routes: Object.keys(PRICES) });

  const app = express();
  const insert = db.prepare(
    `INSERT INTO calls (ts, tool, status, payer_wallet, tx_sig, amount_usdc) VALUES (?,?,?,?,?,?)`,
  );
  app.get('/api/sol-price', mpp.gate('GET /api/sol-price'));
  app.use(mpp.wrapX402((req, res) => res.status(402).json({})));
  app.get('/api/sol-price', (req, res) => {
    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      const s = req.mppSettlement || null;
      insert.run(Date.now(), 'get_sol_price', s ? 'paid' : 'free', s?.payer ?? null, s?.transaction ?? null, s ? 0.001 : null);
    });
    res.json({ tool: 'get_sol_price', data: { price: 1 } });
  });

  // Bind an ephemeral port and report it: fixed ports collide with a previous
  // run's stragglers and make the race fail before it starts.
  const server = app.listen(0, () => process.stdout.write(`READY ${server.address().port}\n`));
})().catch((error) => {
  process.stderr.write(`worker failed: ${error.message}\n`);
  process.exit(1);
});

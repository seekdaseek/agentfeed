// test/helpers/race-two-processes.js — fire one credential at TWO processes
// sharing one SQLite file, at the same instant, and report what happened.
//
// Standalone (not under node:test) so the result is unambiguous and the
// spawned servers are always reaped.
//
// usage: node test/helpers/race-two-processes.js push|pull [delayMs]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const MODE = process.argv[2] === 'pull' ? 'pull' : 'push';
const DELAY = Number(process.argv[3] || 150);

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'mainnet-pull-credential.json'), 'utf8'),
);
const SIGNATURE = FIXTURE.transactionSignature;
const WORKER = path.join(__dirname, 'gate-worker.js');

function startWorker(dbPath) {
  const child = spawn(process.execPath, [WORKER], {
    env: {
      DB_PATH: dbPath,
      HOME: process.env.HOME,
      MPP_ENABLED: 'true',
      MPP_NETWORK: 'mainnet',
      MPP_REALM: 'localhost',
      MPP_RPC_URL: 'http://stub.invalid/rpc',
      MPP_SECRET_KEY: 'f'.repeat(64),
      PATH: process.env.PATH,
      PAY_TO: '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7',
      SIGNATURE,
      VERIFY_DELAY_MS: String(DELAY),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = [];
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  const ready = new Promise((resolve, reject) => {
    // Consume only COMPLETE, NEW lines. Re-scanning the cumulative buffer on
    // every chunk would re-count events already seen and silently inflate the
    // broadcast count.
    let pending = '';
    child.stdout.on('data', (c) => {
      pending += String(c);
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith('EVENT ')) events.push(line.slice(6).trim());
        const m = line.match(/READY (\d+)/);
        if (m) resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`worker exited ${code}; stderr: ${err.slice(0, 500)}`)));
  });
  return { child, events, ready };
}

function parseChallenge(header) {
  const out = {};
  for (const [, k, v] of header.slice(8).matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) out[k] = v;
  return out;
}

(async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpp-race-')), 'agentfeed.db');
  // Create the file and put it into WAL ONCE, before any worker opens it.
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.close();

  const a = startWorker(dbPath);
  const b = startWorker(dbPath);
  let out = { ok: false };
  try {
    const [portA, portB] = await Promise.all([a.ready, b.ready]);

    // Both workers share MPP_SECRET_KEY, so a challenge minted by A verifies in
    // B — exactly two replicas behind one load balancer.
    const challenge = await fetch(`http://127.0.0.1:${portA}/api/sol-price`);
    const params = parseChallenge(challenge.headers.get('www-authenticate'));
    const token = Buffer.from(
      JSON.stringify({
        challenge: {
          id: params.id,
          realm: params.realm,
          method: params.method,
          intent: params.intent,
          request: params.request,
          ...(params.expires ? { expires: params.expires } : {}),
          ...(params.opaque ? { opaque: params.opaque } : {}),
        },
        payload:
          MODE === 'push'
            ? { type: 'signature', signature: SIGNATURE }
            : { type: 'transaction', transaction: FIXTURE.transaction },
      }),
    ).toString('base64url');

    const hit = (port) =>
      fetch(`http://127.0.0.1:${port}/api/sol-price`, { headers: { Authorization: `Payment ${token}` } })
        .then(async (r) => ({ receipt: Boolean(r.headers.get('payment-receipt')), status: r.status }));

    const [ra, rb] = await Promise.all([hit(portA), hit(portB)]);
    await new Promise((r) => setTimeout(r, 300));

    const db = new Database(dbPath, { readonly: true });
    out = {
      calls: db.prepare('SELECT COUNT(*) c FROM calls').get().c,
      consumed: db.prepare('SELECT COUNT(*) c FROM mpp_consumed').get().c,
      getTransaction: [...a.events, ...b.events].filter((e) => e === 'getTransaction').length,
      // The gate's post-settlement payer lookup, reported separately by the
      // worker. Pull mode must be 0 (the credential already names the payer,
      // so attribution costs no network); push mode must be exactly 1.
      payerLookup: [...a.events, ...b.events].filter((e) => e === 'payerLookup').length,
      mode: MODE,
      ok: true,
      receipts: [ra.receipt, rb.receipt].filter(Boolean).length,
      sendTransaction: [...a.events, ...b.events].filter((e) => e === 'sendTransaction').length,
      statuses: [ra.status, rb.status].sort(),
    };
    db.close();
  } catch (error) {
    out = { error: error.message, ok: false };
  } finally {
    a.child.kill('SIGKILL');
    b.child.kill('SIGKILL');
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(out.ok ? 0 : 1);
})();

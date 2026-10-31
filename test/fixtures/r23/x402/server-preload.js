// test/fixtures/r23/x402/server-preload.js: preloaded (NODE_OPTIONS=--require) into the REAL server.js that test/helpers/real-server.js boots, for test/r23-x402-real-server.test.js.
// The routes are the real ones: expansion.js mounts tools/r23/index.js (x402-lint and x402-test among them), titles and questions are the repo's. This file mounts NOTHING and
// registers nothing; it only puts mock sellers behind a stubbed https.request, so the real lib/safe-fetch.js, the real routes, the real wallet files, the real spend ledger and the real
// x402 client libraries run:
//   seller.test (a good v2 seller), free.test (serves its answer free), down.test (never answers), pricey.test (asks 0.06 USD).
// Every request a seller sees is appended to $AF_SELLER_LOG, and every settlement its facilitator makes too.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.AF_ROOT;
const LOG = process.env.AF_SELLER_LOG;
const note = (line) => { if (LOG) { try { fs.appendFileSync(LOG, `${line}\n`); } catch { /* best effort */ } } };
function stubSellers() {
  const S = require(path.join(ROOT, 'test', 'fixtures', 'r23', 'x402', 'seller.js'));
  const facilitator = { settle: (accepted, payer) => { const rec = { success: true, transaction: `0x${'cd'.repeat(32)}`, network: accepted.network, payer }; note(`SETTLE ${accepted.network} ${payer}`); return rec; } };
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body });
  const sellers = {
    'seller.test': S.makeSeller({ facilitator }),
    'free.test': S.makeSeller({ host: 'free.test', unpaid: () => json(200, '{"free":true}') }),
    'pricey.test': S.makeSeller({ host: 'pricey.test', accepts: [S.offer('base', 2, { amount: 60000 })] }),
  };
  const script = async (u, opts) => {
    const headers = opts.headers || {};
    note(`REQ ${opts.method} ${u.host}${u.pathname} paid=${Boolean(headers['PAYMENT-SIGNATURE'] || headers['payment-signature'])}`);
    if (u.host === 'down.test') return Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    const s = sellers[u.host];
    return s ? s.script(u, opts) : S.fakeRes(404, { 'content-type': 'text/plain' }, 'unknown host');
  };
  // only the seller hosts are answered by the stub; any other request goes where it always went (and is refused by the harness's own preload)
  const http = require('http'); const https = require('https');
  const realHttps = https.request; const realHttp = http.request;
  S.stubTransport(script);
  const stub = https.request;
  const hosts = new Set(['seller.test', 'free.test', 'down.test', 'pricey.test']);
  const dispatch = (real) => function (u) { return u && hosts.has(u.host) ? stub.apply(this, arguments) : real.apply(this, arguments); };
  https.request = dispatch(realHttps); http.request = dispatch(realHttp);
}

stubSellers();

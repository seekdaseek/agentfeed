// test/fixtures/r24/txprecheck/rpc-servers.js: loopback JSON-RPC servers for the real-server test of GET /api/tx-precheck (R24 item 4). The server under test is the repository's own, with the route mounted by
// expansion.js; nothing is mounted or registered by the test. Only the TRANSPORTS are stubbed: the Solana RPC (SOLANA_RPC_URL, no fallbacks) and the Base RPC (TXPRECHECK_BASE_RPCS, BASE_SIM_RPC) point at
// these servers, which answer from the fake worlds of build.js / evm-world.js. Every real host stays refused by test/helpers/af-test-preload.js. Each request is appended to `log` ("SOL <method>" / "BASE <method>").
'use strict';
const http = require('http');
const B = require('./build');
const W = require('./evm-world');
const S = require('./scenarios');

/** a loopback JSON-RPC server: handler(method, params) -> the `result`, or { error } for a JSON-RPC error; a throw (or `down`) answers HTTP 500 */
function serve(label, log, handler, { down = false } = {}) {
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { res.statusCode = 400; return res.end('{}'); }
      log.push(`${label} ${j.method}`);
      if (down) { res.statusCode = 500; return res.end('down'); }
      try {
        const r = await handler(j.method, j.params);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(r && r.error ? { jsonrpc: '2.0', id: j.id, error: r.error } : { jsonrpc: '2.0', id: j.id, result: r }));
      } catch { res.statusCode = 500; res.end('error'); }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); } })));
}

/** { log, sol, base, down: { sol, base }, close } : the working worlds, and a pair that always answers HTTP 500 */
async function startAll() {
  const log = [];
  const sol = B.stubSol(S.solWorld());
  const evm = W.makeEvmWorld(S.baseWorld());
  const s = await serve('SOL', log, (m, p) => sol.rpc(m, p, {}));
  const b = await serve('BASE', log, async (m, p) => { const r = await evm.request(m, p, {}); return r.error ? { error: r.error } : r.result; });
  const ds = await serve('SOL', log, () => null, { down: true });
  const db = await serve('BASE', log, () => null, { down: true });
  return { log, sol: s, base: b, down: { sol: ds, base: db }, close: () => { for (const x of [s, b, ds, db]) x.close(); } };
}

/** the environment that points a server under test at a pair of these servers */
const envFor = (sol, base) => ({ SOLANA_RPC_URL: sol.url, RPC_FALLBACKS: '', TXPRECHECK_BASE_RPCS: base.url, BASE_SIM_RPC: base.url });

module.exports = { startAll, envFor };

// test/helpers/rpc-stub.js: a loopback Solana JSON-RPC endpoint that behaves like the providers measured on 30 Oct 2026.
//   mode 'ok'       answers every method (a keyed provider)
//   mode 'capped'   HTTP 429 "max usage reached" for everything (a Helius key out of credits)
//   mode 'public'   answers every method except `refuse`, which gets HTTP 429 {"code":429,"message":"Too many requests for a specific RPC call"}
//                   (the Solana Labs public RPC and getTokenLargestAccounts)
//   option accountPresent: a base64 getAccountInfo answers a token account instead of null (the account exists)
//   mode 'cups'     answers every method except `refuse`, which gets HTTP 429 {"code":429,"message":"Your app has exceeded its compute units per second capacity..."}
//                   (Alchemy's Free plan and getProgramAccounts, measured 30 Oct 2026)
// It counts the calls per method, so a test can say how many times an endpoint was asked what.
'use strict';
const http = require('http');

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MINT_ACCOUNT = {
  context: { slot: 463000000 },
  value: { owner: TOKEN_PROGRAM, lamports: 1461600, executable: false, rentEpoch: 0, space: 82,
    data: { program: 'spl-token', space: 82, parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000', mintAuthority: null, freezeAuthority: null, isInitialized: true } } } },
};
const LARGEST = { context: { slot: 463000000 }, value: [
  { address: 'Hld1111111111111111111111111111111111111111', amount: '300000000000', decimals: 6, uiAmount: 300000, uiAmountString: '300000' },
  { address: 'Hld2222222222222222222222222222222222222222', amount: '200000000000', decimals: 6, uiAmount: 200000, uiAmountString: '200000' },
  { address: 'Hld3333333333333333333333333333333333333333', amount: '100000000000', decimals: 6, uiAmount: 100000, uiAmountString: '100000' },
] };

function answer(method, params, accountPresent) {
  if (method === 'getAccountInfo') {
    const enc = params && params[1] && params[1].encoding;
    if (enc === 'jsonParsed') return MINT_ACCOUNT;
    return accountPresent ? { context: { slot: 463000000 }, value: { owner: TOKEN_PROGRAM, lamports: 2039280, executable: false, rentEpoch: 0, space: 165, data: ['', 'base64'] } } : { context: { slot: 463000000 }, value: null };   // base64: a Metaplex PDA that does not exist, or (accountPresent) a token account
  }
  if (method === 'getTokenLargestAccounts') return LARGEST;
  if (method === 'getMultipleAccounts') return { context: { slot: 463000000 }, value: (params[0] || []).map(() => null) };
  if (method === 'getSlot') return 463000000;
  if (method === 'getProgramAccounts') return [];
  if (method === 'getBalance') return { context: { slot: 463000000 }, value: 0 };
  return null;
}

function startRpcStub({ mode = 'ok', refuse = [], delayMs = 0, accountPresent = false } = {}) {
  const counts = new Map();
  const hits = [];
  const refused = new Set(refuse);
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let j = {};
      try { j = JSON.parse(body); } catch { /* not JSON */ }
      const method = j.method || 'unknown';
      counts.set(method, (counts.get(method) || 0) + 1);
      hits.push({ t: Date.now(), method });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (mode === 'capped') { res.statusCode = 429; res.setHeader('content-type', 'text/plain'); return res.end('max usage reached'); }
      if (mode === 'public' && refused.has(method)) {
        res.statusCode = 429; res.setHeader('content-type', 'application/json');
        return res.end('{"jsonrpc":"2.0","error":{"code": 429,"message":"Too many requests for a specific RPC call"}, "id": 1 }');
      }
      if (mode === 'cups' && refused.has(method)) {
        res.statusCode = 429; res.setHeader('content-type', 'application/json');
        return res.end('{"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message."}}');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, result: answer(method, j.params, accountPresent) }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    resolve({ url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, port, counts, hits, count: (m) => counts.get(m) || 0, total: () => [...counts.values()].reduce((a, b) => a + b, 0), close: () => srv.close() });
  }));
}

module.exports = { startRpcStub, LARGEST, MINT_ACCOUNT };

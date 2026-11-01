// test/fixtures/r24/txprecheck/scenarios.js: the invented world shared by the preload (inject.cjs) and the real-server test, so both build the SAME transactions.
// Solana: the fee payer names the scenario (ok, a failing simulation, a node that is down, an unlimited delegate). Base: the `to` address does.
'use strict';
const B = require('./build');
const W = require('./evm-world');

const P = { ok: B.addr('scenario ok'), fail: B.addr('scenario fail'), down: B.addr('scenario down'), approve: B.addr('scenario approve'), friend: B.addr('scenario friend'), acct: B.addr('scenario token account'), delegate: B.addr('scenario delegate') };
const MAX = (1n << 64n) - 1n;
const tx = {
  ok: () => B.buildTx({ payer: P.ok, instructions: [B.memo(P.ok, 'hello')] }),
  fail: () => B.buildTx({ payer: P.fail, instructions: [B.memo(P.fail, 'hello')] }),
  down: () => B.buildTx({ payer: P.down, instructions: [B.memo(P.down, 'hello')] }),
  approve: () => B.buildTx({ payer: P.approve, instructions: [B.tokApprove(P.acct, P.delegate, P.approve, MAX)] }),
};

function solWorld() {
  const accounts = { [P.ok]: B.sysAcct(5_000_000_000), [P.fail]: B.sysAcct(5_000_000_000), [P.down]: B.sysAcct(5_000_000_000), [P.approve]: B.sysAcct(5_000_000_000), [P.friend]: B.sysAcct(1_000_000_000), [P.acct]: B.tokAcct({ owner: P.approve, amount: 100_000_000 }) };
  const w = { accounts };
  w.sim = (txb64, addresses) => {
    if (addresses[0] === P.down) throw Object.assign(new Error('solana rpc http 429. Not charged.'), { status: 503, transport: true });
    if (addresses[0] === P.fail) return { err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Program log: failed'], unitsConsumed: 10, fee: 5000, innerInstructions: [], accounts: null };
    const post = addresses[0] === P.approve ? { [P.acct]: B.tokAcct({ owner: P.approve, amount: 100_000_000, delegate: P.delegate, delegated: MAX }) } : {};
    return { err: null, logs: ['Program log: ok'], unitsConsumed: 100, fee: 5000, innerInstructions: [], accounts: addresses.map((a) => (a in post ? post[a] : accounts[a]) || null) };
  };
  return w;
}

const ADDR = { me: '0x1111111111111111111111111111111111111111', weth: '0x4200000000000000000000000000000000000006', down: '0x00000000000000000000000000000000000d0d0d', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', router: '0x6ff5693b99212da76ad316178a184ab56d299b43', spender: '0x7777777777777777777777777777777777777777' };
const MAXU = (1n << 256n) - 1n;
function baseWorld() {
  return {
    head: { number: 5000, timestamp: 1_800_000_000 }, eth: { [ADDR.me]: 10n * 10n ** 18n, [ADDR.weth]: 1000n * 10n ** 18n }, tok: { [ADDR.usdc]: { [ADDR.me]: 500_000_000n }, [ADDR.weth]: { [ADDR.me]: 0n } },
    meta: { [ADDR.usdc]: { symbol: 'USDC', name: 'USD Coin', decimals: 6 }, [ADDR.weth]: { symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 } }, code: [ADDR.usdc, ADDR.weth, ADDR.router, ADDR.down], nonce: { [ADDR.me]: 3 },
    scenario: (c) => {
      const to = c.to.toLowerCase();
      if (to === ADDR.down) return { throw: Object.assign(new Error('Base RPC unavailable (eth_simulateV1: timeout). Not charged.'), { status: 503, retryAfter: 30 }) };
      if (to === ADDR.usdc) return { status: '0x1', logs: [W.logApproval(ADDR.usdc, ADDR.me, ADDR.spender, MAXU)] };
      return { status: '0x1', logs: [W.logEth(ADDR.me, ADDR.weth, 1000n)], apply: (s) => { s.eth.set(ADDR.me, s.eth.get(ADDR.me) - 1000n); } };
    },
  };
}

module.exports = { P, ADDR, tx, solWorld, baseWorld };

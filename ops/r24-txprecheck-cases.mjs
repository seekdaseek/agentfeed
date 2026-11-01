// ops/r24-txprecheck-cases.mjs: builds the 12 crafted transactions of the tx-precheck gate (GATES-r24.md section 4) from LIVE mainnet state. It builds UNSIGNED transactions and requests; it signs
// nothing, sends nothing, and holds no key (a well-known funded account is the fee payer: the simulation does not verify signatures). Every address below is a public mainnet account.
//   6 benign (ordinary): 1 a small SOL transfer, 2 a small USDC transfer to an existing token account, 3 an account created for oneself, 4 a memo (Solana), 5 an exact-amount approval to a well-known
//     router, 6 a wrap (Base)
//   6 risky, exactly one of each kind: 7 drainer-style (the whole SOL balance of an account to a fresh account), 8 a delegate grant, 9 a close-account to a stranger (Solana),
//     10 an unlimited approval, 11 a call to an unverified contract, 12 a swap into a token whose existing token-risk read is high-risk (Base)
// 7 Solana + 5 Base. The expected warning id of every risky case is fixed here, before the module is run on any of them. How the live values are chosen is a rule written in each case, never a look at what
// the module answers. `node ops/r24-txprecheck-cases.mjs` prints the resolved recipes (no module run).
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const K = require('@solana/kit');
const V = require('viem');
const B = require(path.join(ROOT, 'test/fixtures/r24/txprecheck/build.js'));

// ---- the fixed public accounts (read on chain 1 Nov 2026; their roles are only "has the balance the case needs")
export const SOL = {
  A: 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', A_USDC: 'DeqZejBFrRwWraY4g4besYmibTY1QcV1Fcg6VfoEvn4T',   // a wallet with thousands of SOL, and its USDC token account
  B: 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', B_USDC: '7dQmths1cyCQ4xaC5KcVfXz4BvVWtnHc3hcgnfnE1PBx',   // a second such wallet and its USDC token account
  C: '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S',                                                            // a wallet with a few SOL (the account that is drained)
  D: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',                                                            // a wallet with many token accounts (one of them is closed)
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  MINTS_FOR_CASE_3: ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'So11111111111111111111111111111111111111112', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'],
};
export const BASE = {
  S: '0xe3478b0bb1a5084567c319096437924948be1964',                                          // an externally owned account with ETH and USDC on Base
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', WETH: '0x4200000000000000000000000000000000000006',
  ROUTER: '0x6fF5693b99212Da76ad316178A184AB56D299b43',                                    // Uniswap Universal Router (official: Uniswap/universal-router deploy-addresses/base.json)
  V2_ROUTER: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',                                 // Uniswap V2 Router02 (official: Uniswap v2 deployments page)
  UNVERIFIED: '0x0a2854fbbd9b3ef66f17d47284e7f899b9509330',                                // a contract with no source match on Sourcify (checked 1 Nov 2026, verification only)
  FAKE_TOKEN: '0xeb0c9ee7c468f474eaf666d728ed6713b10432ba',                                // a token whose existing token-risk read (tools/honeypot.js) was not_sellable when this list was registered
};

const fresh = (n) => K.getAddressDecoder().decode(crypto.createHash('sha256').update(`r24 txprecheck gate fresh account ${n}`).digest());
const ataOf = async (owner, mint) => (await K.getProgramDerivedAddress({ programAddress: K.address(B.ATA), seeds: [K.getAddressEncoder().encode(K.address(owner)), K.getAddressEncoder().encode(K.address(B.TOKEN)), K.getAddressEncoder().encode(K.address(mint))] }))[0];
const enc = (fn, args) => V.encodeFunctionData({ abi: V.parseAbi(['function approve(address,uint256)', 'function deposit()', 'function swapExactETHForTokens(uint256,address[],address,uint256)']), functionName: fn, args });
const MAX256 = (1n << 256n) - 1n;

/** the 12 cases from live state. deps = { sol: lib/solrpc.rpc-like (method, params) -> result, base: (method, params) -> result, honeypot: (token) -> existing read, now } */
export async function buildCases(deps) {
  const sol = deps.sol; const baseCall = deps.base;
  const acct = async (a) => (await sol('getAccountInfo', [a, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
  const blockhash = (await sol('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  const mk = (payer, instructions) => K.getBase64EncodedWireTransaction(K.compileTransaction(K.pipe(K.createTransactionMessage({ version: 'legacy' }), (x) => K.setTransactionMessageFeePayer(K.address(payer), x),
    (x) => K.setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash.blockhash, lastValidBlockHeight: BigInt(blockhash.lastValidBlockHeight) }, x), (x) => K.appendTransactionMessageInstructions(instructions, x))));
  const facts = {};
  const need = async (what, cond) => { if (!(await cond())) throw new Error(`gate precondition failed: ${what}`); };

  // existing accounts the cases rely on
  for (const a of [SOL.A, SOL.B, SOL.C, SOL.D]) await need(`${a} is a system account with at least 1 SOL`, async () => { const v = await acct(a); return v && v.owner === B.SYSTEM && v.lamports >= 1e9; });
  for (const [a, owner] of [[SOL.A_USDC, SOL.A], [SOL.B_USDC, SOL.B]]) await need(`${a} is a USDC token account of ${owner} holding at least 1 USDC`, async () => { const v = await acct(a); const i = v && v.data.parsed && v.data.parsed.info; return i && i.mint === SOL.USDC && i.owner === owner && Number(i.tokenAmount.amount) >= 1e6 && !i.delegate; });
  const fr = [1, 2, 3].map(fresh);
  for (const f of fr) await need(`${f} does not exist`, async () => (await acct(f)) === null);

  const cases = [];
  // 1 benign: a small SOL transfer to an existing account
  cases.push({ n: 1, id: 'S1-small-sol-transfer', chain: 'solana', kind: 'benign', expected: null, what: `0.001 SOL from ${SOL.A} to ${SOL.B}, both existing system accounts`, query: { chain: 'solana', tx: mk(SOL.A, [B.sysTransfer(SOL.A, SOL.B, 1_000_000)]) } });
  // 2 benign: a small token transfer to an existing token account
  cases.push({ n: 2, id: 'S2-small-usdc-transfer', chain: 'solana', kind: 'benign', expected: null, what: `0.01 USDC (transferChecked) from ${SOL.A_USDC} to ${SOL.B_USDC}, both existing, authority ${SOL.A}`, query: { chain: 'solana', tx: mk(SOL.A, [B.tokTransferChecked(SOL.A_USDC, SOL.USDC, SOL.B_USDC, SOL.A, 10_000, 6)]) } });
  // 3 benign: an account created for oneself. Rule: wallet B, the first mint of MINTS_FOR_CASE_3 (in order) whose associated token account for B does not exist yet
  let c3 = null;
  for (const mint of SOL.MINTS_FOR_CASE_3) { const m = await acct(mint); if (!m || !m.data.parsed || m.data.parsed.type !== 'mint' || m.owner !== B.TOKEN) continue; const a = await ataOf(SOL.B, mint); if ((await acct(a)) === null) { c3 = { mint, ata: a }; break; } }
  if (!c3) throw new Error('gate precondition failed: no mint of the list lacks an associated token account for wallet B');
  facts.case3 = c3;
  cases.push({ n: 3, id: 'S3-create-account-for-oneself', chain: 'solana', kind: 'benign', expected: null, what: `CreateIdempotent of the associated token account ${c3.ata} for mint ${c3.mint}; payer and owner are ${SOL.B}`, query: { chain: 'solana', tx: mk(SOL.B, [B.ataCreate(SOL.B, c3.ata, SOL.B, c3.mint)]) } });
  // 4 benign: a memo
  cases.push({ n: 4, id: 'S4-memo', chain: 'solana', kind: 'benign', expected: null, what: `a Memo program v2 instruction signed by ${SOL.A}`, query: { chain: 'solana', tx: mk(SOL.A, [B.memo(SOL.A, 'r24 txprecheck gate memo')]) } });
  // 5 benign: an exact-amount approval to a well-known router
  cases.push({ n: 5, id: 'B1-exact-approval-known-router', chain: 'base', kind: 'benign', expected: null, what: `USDC.approve(Uniswap Universal Router, 1 USDC exactly) from ${BASE.S}`, query: { chain: 'base', from: BASE.S, to: BASE.USDC, data: enc('approve', [BASE.ROUTER, 1_000_000n]), value: '0' } });
  // 6 benign: a wrap
  cases.push({ n: 6, id: 'B2-wrap', chain: 'base', kind: 'benign', expected: null, what: `WETH9.deposit() with 0.001 ETH from ${BASE.S}`, query: { chain: 'base', from: BASE.S, to: BASE.WETH, data: enc('deposit', []), value: '1000000000000000' } });

  // 7 risky (2) drainer-style: the whole SOL balance of C, less the 5000-lamport fee of one signature, to an account that does not exist
  const cBal = await sol('getBalance', [SOL.C, { commitment: 'confirmed' }]);
  const drain = BigInt(cBal.value) - 5000n;
  facts.case7 = { source_balance_lamports: String(cBal.value), transfer_lamports: String(drain), destination: fr[0] };
  cases.push({ n: 7, id: 'S5-drainer-whole-balance-to-fresh', chain: 'solana', kind: 'risky', risky_type: '(2) drainer-style transfer', expected: 'transfer_to_fresh_account', what: `${drain} lamports (the whole balance ${cBal.value} less the 5000 fee) from ${SOL.C} to ${fr[0]}, an address that does not exist`, query: { chain: 'solana', tx: mk(SOL.C, [B.sysTransfer(SOL.C, fr[0], drain)]) } });
  // 8 risky (3) delegate grant: Approve of 1 USDC on A's USDC account to an address that does not exist
  cases.push({ n: 8, id: 'S6-delegate-grant', chain: 'solana', kind: 'risky', risky_type: '(3) delegate grant', expected: 'delegate_granted', what: `SPL Approve of 1 USDC on ${SOL.A_USDC} (owner ${SOL.A}) to the delegate ${fr[1]}`, query: { chain: 'solana', tx: mk(SOL.A, [B.tokApprove(SOL.A_USDC, fr[1], SOL.A, 1_000_000)]) } });
  // 9 risky (4) close-account to a stranger. Rule: the first USDC token account of wallet D (in getTokenAccountsByOwner order) that is initialized, holds 0, has no close authority and no delegate
  const dAccts = await sol('getTokenAccountsByOwner', [SOL.D, { mint: SOL.USDC }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const empty = dAccts.value.find((v) => { const i = v.account.data.parsed.info; return i.state === 'initialized' && i.tokenAmount.amount === '0' && !i.closeAuthority && !i.delegate; });
  if (!empty) throw new Error('gate precondition failed: wallet D has no empty USDC token account without a close authority');
  facts.case9 = { closed_account: empty.pubkey, rent_lamports: empty.account.lamports, destination: fr[2] };
  cases.push({ n: 9, id: 'S7-close-account-to-stranger', chain: 'solana', kind: 'risky', risky_type: '(4) close-account to a stranger', expected: 'close_account_to_other', what: `CloseAccount of ${empty.pubkey} (empty USDC account of ${SOL.D}), its lamports sent to ${fr[2]}`, query: { chain: 'solana', tx: mk(SOL.D, [B.tokClose(empty.pubkey, fr[2], SOL.D)]) } });

  // 10 risky (1) unlimited approval: the same token and spender as case 5, with the largest uint256
  cases.push({ n: 10, id: 'B3-unlimited-approval', chain: 'base', kind: 'risky', risky_type: '(1) unlimited approval', expected: 'unlimited_approval', what: `USDC.approve(Uniswap Universal Router, 2^256-1) from ${BASE.S}`, query: { chain: 'base', from: BASE.S, to: BASE.USDC, data: enc('approve', [BASE.ROUTER, MAX256]), value: '0' } });
  // 11 risky (5) unverified contract: an empty-calldata call to a contract with code and no verified source
  cases.push({ n: 11, id: 'B4-unverified-contract', chain: 'base', kind: 'risky', risky_type: '(5) unknown program or unverified contract', expected: 'unknown_program', what: `a call with empty calldata from ${BASE.S} to ${BASE.UNVERIFIED}`, query: { chain: 'base', from: BASE.S, to: BASE.UNVERIFIED, data: '0x', value: '0' } });
  // 12 risky (6) fake-token swap: 0.001 ETH into the token through the Uniswap V2 router. Precondition: the existing token-risk read of the token is high-risk NOW (recorded; not scored)
  const read = await deps.honeypot(BASE.FAKE_TOKEN);
  facts.case12 = { existing_read_verdict: read.verdict, sellable: read.sellable, buy_tax_pct: read.buy_tax_pct, sell_tax_pct: read.sell_tax_pct, high_risk_now: ['not_sellable', 'extreme_tax', 'high_tax'].includes(read.verdict) };
  const deadline = BigInt(Math.floor(deps.now() / 1000) + 3600);
  cases.push({ n: 12, id: 'B5-fake-token-swap', chain: 'base', kind: 'risky', risky_type: '(6) fake-token swap', expected: 'high_risk_token', what: `swapExactETHForTokens with 0.001 ETH from ${BASE.S} into ${BASE.FAKE_TOKEN} through the Uniswap V2 router`, query: { chain: 'base', from: BASE.S, to: BASE.V2_ROUTER, data: enc('swapExactETHForTokens', [0n, [BASE.WETH, BASE.FAKE_TOKEN], BASE.S, deadline]), value: '1000000000000000' } });

  // the live preconditions of the Base sender
  const ethBal = BigInt((await baseCall('eth_getBalance', [BASE.S, 'latest'])).result);
  facts.base_sender_eth_wei = ethBal.toString();
  if (ethBal < 10n ** 16n) throw new Error('gate precondition failed: the Base sender holds less than 0.01 ETH');
  return { cases, facts };
}

// ---- CLI: print the resolved recipes (the module is NOT run)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const SR = require(path.join(ROOT, 'lib/solrpc'));
  const { makeBaseRpc } = require(path.join(ROOT, 'tools/r24/txprecheck/base-rpc'));
  const base = makeBaseRpc();
  const { cases, facts } = await buildCases({ sol: (m, p) => SR.rpc(m, p), base: (m, p) => base.request(m, p), honeypot: (t) => require(path.join(ROOT, 'tools/honeypot')).getHoneypotCheck({ token: t, chain: 'base' }), now: Date.now });
  console.log(JSON.stringify({ facts, cases: cases.map((c) => ({ n: c.n, id: c.id, chain: c.chain, kind: c.kind, risky_type: c.risky_type || null, expected: c.expected, what: c.what, input_bytes: JSON.stringify(c.query).length })) }, null, 1));
}

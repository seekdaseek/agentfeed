// R24 item 4: GET /api/tx-precheck, chain=solana: input caps, the decoding, every warning, every benign pass-through, the failing simulation, the 503 paths and the shape of the published example.
// The RPC is a stub (test/fixtures/r24/txprecheck/build.js): nothing here touches the network. The live gate is a separate run (ops/r24-txprecheck-gate.mjs).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('./fixtures/r24/txprecheck/build');
const O = require('../tools/r24/txprecheck/sol-ops');
const L = require('../tools/r24/txprecheck/limits');
const { precheckSolana } = require('../tools/r24/txprecheck/solana');
const { run } = require('../tools/r24/txprecheck');
const example = require('../tools/r24/txprecheck/example');

const me = B.addr('me'); const friend = B.addr('friend'); const stranger = B.addr('stranger'); const fresh = B.addr('fresh wallet');
const myUsdc = B.addr('my usdc'); const friendUsdc = B.addr('friend usdc'); const freshAta = B.addr('fresh ata'); const emptyAta = B.addr('empty ata');
const junkMint = B.addr('junk mint'); const myJunk = B.addr('my junk');
const noRisk = async () => { throw new Error('the token-risk read should not be called'); };
const WORLD = () => ({
  [me]: B.sysAcct(5_000_000_000), [friend]: B.sysAcct(2_000_000_000), [stranger]: B.sysAcct(1_000_000_000),
  [myUsdc]: B.tokAcct({ owner: me, amount: 100_000_000 }), [friendUsdc]: B.tokAcct({ owner: friend, amount: 5_000_000 }), [emptyAta]: B.tokAcct({ owner: me, amount: 0 }),
  [myJunk]: B.tokAcct({ mint: junkMint, owner: me, amount: 7_000_000_000, decimals: 9 }),
});
/** run the route's Solana half against a stub world; `post` overrides the post-state of some accounts; `risk` answers token-risk reads */
async function go(instructions, { payer = me, accounts = WORLD(), post = {}, sim, risk = noRisk, lookups = null, extraSim = {}, deps = {} } = {}) {
  const w = { accounts, sim: sim || null };
  w.sim = sim || B.simOk(w, post, extraSim);
  const stub = B.stubSol(w);
  const tx = B.buildTx({ payer, instructions, lookups });
  const out = await precheckSolana({ tx }, { rpc: stub.rpc, now: Date.now, solRisk: risk, ...deps });
  return { out, stub, tx };
}
const ids = (out) => out.warnings.map((w) => w.id);

test('input: the base64 text is checked against the exact caps before anything else (1644 characters, 1232 bytes)', () => {
  assert.equal(L.MAX_SOL_TX_B64, 4 * Math.ceil(L.MAX_SOL_TX_BYTES / 3));
  assert.equal(L.MAX_SOL_TX_B64, 1644); assert.equal(L.MAX_SOL_TX_BYTES, 1232);
  assert.throws(() => O.parseInput('A'.repeat(1645)), /1644/);
  assert.throws(() => O.parseInput(''), /missing required parameter: tx/);
  assert.throws(() => O.parseInput(undefined), /missing required parameter: tx/);
  assert.throws(() => O.parseInput(42), /base64 string/);
  assert.throws(() => O.parseInput('not base64 !!!'), /not base64/);
  // 1644 characters is not refused for its length: the next check (the bytes) is what speaks
  assert.throws(() => O.parseInput('A'.repeat(1644)), /1233 bytes|at most 1232/);   // 1644 base64 characters decode to 1233 bytes
  assert.throws(() => O.parseInput('QQ=='), /too short/);
  // a "+" lost to URL decoding arrives as a space and is put back; url-safe base64 is accepted
  const tx = B.buildTx({ payer: me, instructions: [B.memo(me, 'hi')] });
  assert.equal(O.parseInput(tx.replace(/\+/g, ' ')).b64, tx);
  assert.equal(O.parseInput(tx.replace(/\+/g, '-').replace(/\//g, '_')).b64, tx);
});

test('input: bytes that are not a legacy or version 0 transaction are a 400, with no RPC call', async () => {
  const calls = [];
  const deps = { rpc: async (m) => { calls.push(m); return {}; }, now: Date.now };
  for (const tx of [Buffer.alloc(200, 7).toString('base64'), Buffer.from('this is not a transaction at all, it is far too long to be anything else here').toString('base64')]) {
    await assert.rejects(precheckSolana({ tx }, deps), (e) => e.kind === 'bad_request' && /not a legacy or version 0|too short/.test(e.message));
  }
  await assert.rejects(precheckSolana({ tx: 'A'.repeat(1645) }, deps), (e) => e.kind === 'bad_request' && /1644/.test(e.message));
  assert.deepEqual(calls, [], 'a refused input never reaches the RPC');
});

test('decode: legacy and version 0 transactions, signed or unsigned, with and without lookup tables, give the keys in instruction order with the right roles', () => {
  const t = B.addr('table'); const loadedW = B.addr('loaded writable');
  const tx = B.buildTx({ payer: me, instructions: [B.sysTransfer(me, loadedW, 1000)], lookups: { [t]: [loadedW, B.addr('other')] } });
  const d = O.decodeTx(O.parseInput(tx).bytes);
  assert.equal(d.version, 0); assert.equal(d.lookups.length, 1); assert.equal(d.lookups[0].table, t);
  const { keys, missing } = O.buildKeys(d, new Map([[t, [loadedW, B.addr('other')]]]));
  assert.deepEqual(missing, []);
  const k = keys.find((x) => x.address === loadedW); assert.deepEqual([k.signer, k.writable, k.loaded], [false, true, true]);
  assert.deepEqual([keys[0].address, keys[0].signer, keys[0].writable], [me, true, true]);
  assert.equal(O.buildKeys(d, new Map()).missing[0], t, 'a table that was not supplied is reported');
  const legacy = O.decodeTx(O.parseInput(B.buildTx({ payer: me, instructions: [B.memo(me, 'x')] })).bytes);
  assert.equal(legacy.version, 'legacy'); assert.equal(legacy.signatureCount, 1);
});

// ---------- benign pass-through: no warning at all ----------

test('benign: a small SOL transfer to an existing account, a small token transfer to an existing token account, a memo, and creating an account for oneself carry NO warning', async () => {
  const newAta = B.addr('my new ata');
  const cases = [
    ['small SOL transfer', [B.sysTransfer(me, friend, 1_000_000)], {}],
    ['small token transfer', [B.tokTransferChecked(myUsdc, B.USDC, friendUsdc, me, 10_000, 6)], { post: { [myUsdc]: B.tokAcct({ owner: me, amount: 99_990_000 }), [friendUsdc]: B.tokAcct({ owner: friend, amount: 5_010_000 }) } }],
    ['memo', [B.memo(me, 'hello')], {}],
    ['create an account for oneself', [B.ataCreate(me, newAta, me, B.WSOL)], { post: { [newAta]: B.tokAcct({ mint: B.WSOL, owner: me, amount: 0, decimals: 9 }) } }],
    ['wrap: a new wrapped-SOL account for oneself, funded', [B.ataCreate(me, newAta, me, B.WSOL), B.sysTransfer(me, newAta, 1_000_000_000)], { post: { [newAta]: B.tokAcct({ mint: B.WSOL, owner: me, amount: 1_000_000_000, decimals: 9 }) } }],
  ];
  for (const [what, ix, opts] of cases) {
    const { out } = await go(ix, opts);
    assert.deepEqual(ids(out), [], `${what}: ${JSON.stringify(out.warnings)}`);
    assert.equal(out.simulation.ok, true, what);
    assert.equal(out.summary.warning_count, 0); assert.equal(out.summary.highest_severity, null);
    assert.match(out.summary.note, /not a statement that it is safe/);
  }
});

test('benign: the balance changes are per account and per token, with before, after, delta and decimals; a new token account is listed with its owner', async () => {
  const newAta = B.addr('my new ata 2');
  const { out } = await go([B.ataCreate(me, newAta, me, B.USDC), B.tokTransferChecked(myUsdc, B.USDC, newAta, me, 25_000_000, 6)], {
    post: { [myUsdc]: B.tokAcct({ owner: me, amount: 75_000_000 }), [newAta]: B.tokAcct({ owner: me, amount: 25_000_000 }), [me]: B.sysAcct(4_997_955_000) },
  });
  assert.deepEqual(ids(out), []);
  const usdcOut = out.balance_changes.find((c) => c.token_account === myUsdc);
  assert.deepEqual([usdcOut.asset, usdcOut.symbol, usdcOut.decimals, usdcOut.before, usdcOut.after, usdcOut.delta, usdcOut.delta_ui, usdcOut.account, usdcOut.owner], [B.USDC, 'USDC', 6, '100000000', '75000000', '-25000000', '-25', me, me]);
  const into = out.balance_changes.find((c) => c.token_account === newAta);
  assert.deepEqual([into.before, into.after, into.delta], ['0', '25000000', '25000000']);
  const sol = out.balance_changes.find((c) => c.asset === 'SOL' && c.account === me);
  assert.equal(sol.delta, '-2045000'); assert.equal(sol.includes_fee, true);
  assert.deepEqual(out.new_accounts.map((a) => [a.address, a.kind, a.token_owner, a.mint]), [[newAta, 'token_account', me, B.USDC]]);
  assert.equal(out.new_accounts[0].for_signer, true);
  assert.deepEqual(out.programs.map((p) => [p.name, p.known]).sort(), [['associated-token-account', true], ['spl-token', true]]);
  assert.equal(out.tokens.length, 1); assert.equal(out.tokens[0].known, true); assert.match(out.tokens[0].token_risk.skipped, /well-known/);
});

// ---------- the warnings ----------

test('delegate_granted: an SPL Approve (and ApproveChecked) names the delegate and the amount; the amount is not unlimited', async () => {
  for (const ix of [B.tokApprove(myUsdc, stranger, me, 1_000_000), B.tokApproveChecked(myUsdc, B.USDC, stranger, me, 1_000_000, 6)]) {
    const { out } = await go([ix], { post: { [myUsdc]: B.tokAcct({ owner: me, amount: 100_000_000, delegate: stranger, delegated: 1_000_000 }) } });
    assert.deepEqual(ids(out), ['delegate_granted']);
    const w = out.warnings[0];
    assert.equal(w.severity, 'medium'); assert.equal(w.delegate, stranger); assert.equal(w.token_account, myUsdc); assert.equal(w.owner, me); assert.equal(w.amount, '1000000'); assert.equal(w.amount_ui, '1'); assert.equal(w.unlimited, false);
    assert.match(w.message, new RegExp(`sets ${stranger} as delegate of token account ${myUsdc}`));
    assert.deepEqual(out.delegations.map((d) => [d.kind, d.delegate, d.amount, d.unlimited, d.source]), [['spl_delegate', stranger, '1000000', false, 'instruction']]);
  }
});

test('unlimited_approval: a delegated amount of at least 2^63 raw units is unlimited, and the delegate warning goes with it', async () => {
  const max = (1n << 64n) - 1n;
  const { out } = await go([B.tokApprove(myUsdc, stranger, me, max)], { post: { [myUsdc]: B.tokAcct({ owner: me, amount: 100_000_000, delegate: stranger, delegated: max }) } });
  assert.deepEqual(ids(out).sort(), ['delegate_granted', 'unlimited_approval']);
  assert.equal(out.warnings[0].id, 'unlimited_approval'); assert.equal(out.warnings[0].severity, 'high');
  assert.match(out.warnings[0].message, /unlimited allowance/);
  assert.equal(out.delegations[0].unlimited, true);
  // the boundary: 2^63 - 1 is not unlimited, 2^63 is
  const below = await go([B.tokApprove(myUsdc, stranger, me, (1n << 63n) - 1n)]);
  assert.deepEqual(ids(below.out), ['delegate_granted']);
  const at = await go([B.tokApprove(myUsdc, stranger, me, 1n << 63n)]);
  assert.deepEqual(ids(at.out).sort(), ['delegate_granted', 'unlimited_approval']);
});

test('delegate_granted: a delegate that appears only in the state after (a program the table does not know sets it) is found from the state, not the instructions', async () => {
  const prog = B.addr('some program');
  const { out } = await go([B.unknownProgram(prog, me, [myUsdc])], { post: { [myUsdc]: B.tokAcct({ owner: me, amount: 100_000_000, delegate: stranger, delegated: 50_000_000 }) } });
  assert.ok(ids(out).includes('delegate_granted'));
  assert.equal(out.delegations[0].source, 'state'); assert.equal(out.delegations[0].delegate, stranger);
  assert.ok(ids(out).includes('unknown_program'));
});

test('transfer_to_fresh_account: SOL to an account that does not exist is flagged; to an existing account it is not; the whole balance is a high-severity finding with the share', async () => {
  const small = await go([B.sysTransfer(me, fresh, 1_000_000)]);
  assert.deepEqual(ids(small.out), ['transfer_to_fresh_account']);
  assert.equal(small.out.warnings[0].severity, 'low'); assert.equal(small.out.warnings[0].account, fresh);
  const drain = await go([B.sysTransfer(me, fresh, 4_999_995_000)]);
  assert.deepEqual(ids(drain.out).sort(), ['large_balance_outflow', 'transfer_to_fresh_account']);
  const f = drain.out.warnings.find((w) => w.id === 'transfer_to_fresh_account');
  assert.equal(f.severity, 'high'); assert.ok(f.share_of_source_balance_pct > 99.9);
  assert.match(f.message, /does not exist on chain before this transaction/);
  const ok = await go([B.sysTransfer(me, friend, 4_999_995_000)]);
  assert.deepEqual(ids(ok.out), ['large_balance_outflow'], 'an existing destination is not fresh, but 99.9 percent of the balance leaving is still its own finding');
});

test('transfer_to_fresh_account: a token transfer into a token account that does not exist, owned by a wallet that has nothing, is flagged; into a new token account of a wallet that exists, it is not', async () => {
  const toFresh = await go([B.ataCreate(me, freshAta, fresh, B.USDC), B.tokTransferChecked(myUsdc, B.USDC, freshAta, me, 99_000_000, 6)], { post: { [freshAta]: B.tokAcct({ owner: fresh, amount: 99_000_000 }), [myUsdc]: B.tokAcct({ owner: me, amount: 1_000_000 }) } });
  assert.ok(ids(toFresh.out).includes('transfer_to_fresh_account'));
  const w = toFresh.out.warnings.find((x) => x.id === 'transfer_to_fresh_account');
  assert.equal(w.owner, fresh); assert.equal(w.severity, 'high'); assert.equal(w.asset, B.USDC);
  const toKnownWallet = await go([B.ataCreate(me, freshAta, friend, B.USDC), B.tokTransferChecked(myUsdc, B.USDC, freshAta, me, 1_000_000, 6)], { post: { [freshAta]: B.tokAcct({ owner: friend, amount: 1_000_000 }), [myUsdc]: B.tokAcct({ owner: me, amount: 99_000_000 }) } });
  assert.deepEqual(ids(toKnownWallet.out), [], 'an established wallet receiving a new token account is an ordinary payment');
});

test('transfer_to_fresh_account: a CPI the simulation reports (jsonParsed inner instruction) is read the same way as a top-level one', async () => {
  const prog = B.addr('router program');
  const inner = [{ index: 0, instructions: [{ program: 'system', programId: B.SYSTEM, parsed: { type: 'transfer', info: { source: me, destination: fresh, lamports: 3_000_000 } }, stackHeight: 2 }] }];
  const { out } = await go([B.unknownProgram(prog, me, [fresh])], { extraSim: { innerInstructions: inner } });
  assert.ok(ids(out).includes('transfer_to_fresh_account'));
  assert.ok(ids(out).includes('unknown_program'));
});

test('close_account_to_other: closing a token account and sending its lamports to someone other than the owner is flagged; closing it to the owner is not', async () => {
  const stranger2 = await go([B.tokClose(emptyAta, stranger, me)]);
  assert.deepEqual(ids(stranger2.out), ['close_account_to_other']);
  const w = stranger2.out.warnings[0];
  assert.equal(w.severity, 'high'); assert.equal(w.account, emptyAta); assert.equal(w.owner, me); assert.equal(w.destination, stranger); assert.equal(w.lamports, '2039280');
  assert.match(w.message, /which is not the account owner/);
  const own = await go([B.tokClose(emptyAta, me, me)]);
  assert.deepEqual(ids(own.out), []);
  assert.deepEqual(own.out.closed_accounts.length, 0, 'no post-state was supplied for a close in this stub, so nothing is listed as closed');
  const closed = await go([B.tokClose(emptyAta, me, me)], { post: { [emptyAta]: null, [me]: B.sysAcct(5_002_034_280) } });
  assert.deepEqual(closed.out.closed_accounts.map((c) => [c.address, c.lamports_returned, c.token_owner]), [[emptyAta, '2039280', me]]);
  // the node returns a closed account as an account with no lamports (not as null): it is gone all the same
  const zero = await go([B.tokClose(emptyAta, me, me)], { post: { [emptyAta]: B.sysAcct(0), [me]: B.sysAcct(5_002_034_280) } });
  assert.deepEqual(zero.out.closed_accounts.map((c) => c.address), [emptyAta]); assert.deepEqual(zero.out.new_accounts, []);
  assert.deepEqual(ids((await go([B.sysTransfer(me, friend, 1000)], { post: { [friend]: B.sysAcct(0) } })).out), [], 'a zero-lamport destination in the state AFTER is not a finding');
});

test('unknown_program: a program that is not in the table is flagged by id; known programs (system, token, ATA, memo, compute budget, Jupiter) are not; a CPI into an unknown program is flagged as such', async () => {
  const prog = B.addr('unknown program');
  const a = await go([B.unknownProgram(prog, me)]);
  assert.deepEqual(ids(a.out), ['unknown_program']);
  assert.equal(a.out.warnings[0].program, prog); assert.equal(a.out.warnings[0].severity, 'medium'); assert.match(a.out.warnings[0].message, /not in this service's table of well-known Solana programs/);
  assert.deepEqual(a.out.programs.map((p) => [p.address, p.known]), [[prog, false]]);
  const known = await go([B.unknownProgram('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', me), B.unknownProgram('ComputeBudget111111111111111111111111111111', me)]);
  assert.deepEqual(ids(known.out), []);
  assert.ok(known.out.programs.every((p) => p.known && p.source));
  const cpi = await go([B.unknownProgram('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', me)], { extraSim: { innerInstructions: [{ index: 0, instructions: [{ programId: prog, accounts: [me], data: '3Bxs4h24hBtQy9rw', stackHeight: 2 }] }] } });
  assert.deepEqual(ids(cpi.out), ['unknown_program']);
  assert.equal(cpi.out.warnings[0].invoked_by, 'cpi'); assert.match(cpi.out.warnings[0].message, /through another program/);
});

test('authority_change: SetAuthority (owner of a token account, mint authority removed), an assign of a signing account to a program, and a program-upgrade authority change are each flagged', async () => {
  const owner = await go([B.tokSetAuthority(myUsdc, me, 2, stranger)]);
  assert.deepEqual(ids(owner.out), ['authority_change']);
  assert.match(owner.out.warnings[0].message, new RegExp(`changes the account owner of ${myUsdc} from ${me} to ${stranger}`));
  const mintAuth = await go([B.tokSetAuthority(junkMint, me, 0, null)], { accounts: { ...WORLD(), [junkMint]: B.mintAcct({ mintAuthority: me, decimals: 9 }) } });
  assert.deepEqual(ids(mintAuth.out), ['authority_change']);
  assert.match(mintAuth.out.warnings[0].message, /to nobody \(the authority is removed\)/);
  const assign = await go([B.sysAssign(me, B.addr('some program'))]);
  assert.deepEqual(ids(assign.out), ['authority_change', 'unknown_program'].filter((x) => ids(assign.out).includes(x)));
  assert.ok(ids(assign.out).includes('authority_change'));
  assert.match(assign.out.warnings.find((w) => w.id === 'authority_change').message, /assigns the account .* which signs it/);
  const loader = await go([B.loaderSetAuthority(B.addr('program data'), me, stranger)]);
  assert.ok(ids(loader.out).includes('authority_change'));
  assert.match(loader.out.warnings.find((w) => w.id === 'authority_change').message, /program upgrade authority/);
  // from the state alone: the owner of a token account differs after the transaction
  const prog = B.addr('some program');
  const st = await go([B.unknownProgram(prog, me, [myUsdc])], { post: { [myUsdc]: B.tokAcct({ owner: stranger, amount: 100_000_000 }) } });
  assert.ok(ids(st.out).includes('authority_change'));
});

test('large_balance_outflow: 90 percent or more of a signing wallet\'s SOL or of its token account leaves; 89 percent does not; dust wallets and moves between own accounts do not count', async () => {
  const sol90 = await go([B.sysTransfer(me, friend, 4_500_000_000)]);                 // exactly 90 percent of 5 SOL
  assert.deepEqual(ids(sol90.out), ['large_balance_outflow']);
  assert.equal(sol90.out.warnings[0].share_pct, 90);
  const sol89 = await go([B.sysTransfer(me, friend, 4_450_000_000)]);
  assert.deepEqual(ids(sol89.out), []);
  const tok = await go([B.tokTransferChecked(myUsdc, B.USDC, friendUsdc, me, 95_000_000, 6)]);
  assert.deepEqual(ids(tok.out), ['large_balance_outflow']);
  assert.equal(tok.out.warnings[0].asset, B.USDC); assert.equal(tok.out.warnings[0].share_pct, 95);
  const accounts = { ...WORLD(), [B.addr('dust')]: B.sysAcct(10_000_000) };
  const dust = await go([B.sysTransfer(B.addr('dust'), friend, 9_000_000)], { payer: B.addr('dust'), accounts });
  assert.deepEqual(ids(dust.out), [], 'below 0.05 SOL an emptied wallet is dust');
  const ownAta = B.addr('my other usdc');
  const own = await go([B.tokTransferChecked(myUsdc, B.USDC, ownAta, me, 100_000_000, 6)], { accounts: { ...WORLD(), [ownAta]: B.tokAcct({ owner: me, amount: 0 }) } });
  assert.deepEqual(ids(own.out), [], 'moving a whole balance between two accounts of the same owner is not an outflow');
});

test('high_risk_token: an unknown token whose token-risk read carries two or more risk flags is flagged, with the flags; one flag is not; a well-known mint is never read', async () => {
  const reads = [];
  const riskOf = (flags) => async (mint) => { reads.push(mint); return { mint, name: 'Junk Coin', symbol: 'JUNK', supply: 1000, program: 'spl-token', authorities: { mint_authority: me, freeze_authority: me }, concentration: { top1_pct: 90, top10_pct: 99, note: 'x', top_accounts: [1, 2, 3, 4, 5].map((i) => ({ address: `a${i}`, amount: i })) }, risk_flags: flags, risk_flag_count: flags.length, source: 'x' }; };
  const swap = [B.tokTransferChecked(myJunk, junkMint, B.addr('pool junk'), me, 1_000_000, 9)];
  const accounts = { ...WORLD(), [B.addr('pool junk')]: B.tokAcct({ mint: junkMint, owner: B.addr('pool'), amount: 5, decimals: 9 }) };
  const two = await go(swap, { accounts, risk: riskOf(['mint_authority_active: supply can be inflated', 'freeze_authority_active: wallets can be frozen']) });
  assert.deepEqual(ids(two.out), ['high_risk_token']);
  assert.equal(two.out.warnings[0].token, junkMint); assert.deepEqual(two.out.warnings[0].risk_flags.length, 2);
  assert.match(two.out.warnings[0].message, /its token-risk read is high-risk: mint_authority_active, freeze_authority_active/);
  assert.equal(two.out.tokens[0].token_risk.high_risk, true); assert.equal(two.out.tokens[0].token_risk.read.concentration.top_accounts.length, 3);
  const one = await go(swap, { accounts, risk: riskOf(['high_concentration: top 10 accounts hold >50% of supply']) });
  assert.deepEqual(ids(one.out), []); assert.equal(one.out.tokens[0].token_risk.high_risk, false);
  reads.length = 0;
  await go([B.tokTransferChecked(myUsdc, B.USDC, friendUsdc, me, 10_000, 6)], { risk: riskOf(['a', 'b']) });
  assert.deepEqual(reads, [], 'USDC is in the official table and its token-risk read is skipped');
});

test('token-risk reads that fail or are late never fail the answer: the token is listed with available false and no warning', async () => {
  const swap = [B.tokTransferChecked(myJunk, junkMint, B.addr('pool junk'), me, 1_000_000, 9)];
  const accounts = { ...WORLD(), [B.addr('pool junk')]: B.tokAcct({ mint: junkMint, owner: B.addr('pool'), amount: 5, decimals: 9 }) };
  const failing = await go(swap, { accounts, risk: async () => { throw Object.assign(new Error('solana rpc http 429. Not charged.'), { status: 503 }); } });
  assert.deepEqual(ids(failing.out), []);
  assert.deepEqual(failing.out.tokens[0].token_risk, { available: false, reason: 'the token-risk read failed' });
  const t0 = Date.now();
  const late = await go(swap, { accounts, risk: () => new Promise(() => {}), deps: { now: (() => { let t = Date.now(); return () => (t += 4000); })() } });
  assert.match(late.out.tokens[0].token_risk.reason, /did not finish within 6 s/);
  assert.ok(Date.now() - t0 < 3000, 'a read that never answers does not hold the answer past the shared deadline');
});

// ---------- the simulation itself ----------

test('a transaction that FAILS in the simulation is an answer: 200 with simulation.ok false and the error; the warnings that come from the instructions are still there; there is no state after', async () => {
  const max = (1n << 64n) - 1n;
  const w = { accounts: WORLD() };
  w.sim = () => ({ err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Program log: Error: insufficient funds'], unitsConsumed: 300, fee: 5000, innerInstructions: [], accounts: null });
  const stub = B.stubSol(w);
  const tx = B.buildTx({ payer: me, instructions: [B.tokApprove(myUsdc, stranger, me, max)] });
  const out = await precheckSolana({ tx }, { rpc: stub.rpc, now: Date.now, solRisk: noRisk });
  assert.equal(out.simulation.ok, false); assert.equal(out.simulation.error, 'instruction 0 failed: custom program error 1'); assert.deepEqual(out.simulation.error_raw, { InstructionError: [0, { Custom: 1 }] });
  assert.deepEqual(out.balance_changes, []); assert.match(out.balance_changes_note, /did not succeed/);
  assert.deepEqual(ids(out).sort(), ['delegate_granted', 'unlimited_approval']);
  const str = await go([B.memo(me, 'x')], { sim: () => ({ err: 'AccountNotFound', logs: [], unitsConsumed: 0, fee: 0, innerInstructions: [], accounts: null }) });
  assert.equal(str.out.simulation.error, 'AccountNotFound'); assert.equal(str.out.simulation.ok, false);
});

test('the requests to the RPC: the pre-state read and the simulation, with the exact simulateTransaction options (sigVerify false, replaceRecentBlockhash true, innerInstructions true, jsonParsed accounts for every writable account)', async () => {
  const { stub, tx } = await go([B.sysTransfer(me, friend, 1000)]);
  assert.deepEqual(stub.calls.map((c) => c.method).sort(), ['getMultipleAccounts', 'simulateTransaction']);
  const sim = stub.calls.find((c) => c.method === 'simulateTransaction').params;
  assert.equal(sim[0], tx);
  assert.equal(sim[1].sigVerify, false); assert.equal(sim[1].replaceRecentBlockhash, true); assert.equal(sim[1].innerInstructions, true); assert.equal(sim[1].encoding, 'base64');
  assert.equal(sim[1].accounts.encoding, 'jsonParsed'); assert.deepEqual(sim[1].accounts.addresses.sort(), [me, friend].sort());
  const pre = stub.calls.find((c) => c.method === 'getMultipleAccounts').params;
  assert.equal(pre[1].encoding, 'jsonParsed');
  assert.ok(stub.calls.every((c) => c.opts.timeoutMs <= L.SIM_TIMEOUT_MS), 'every RPC call is given at most the 8 s cap');
});

test('version 0 with lookup tables: the tables are read first, their addresses become account keys, and a missing table is a 400', async () => {
  const t = B.addr('table'); const loaded = B.addr('loaded dest');
  const accounts = { ...WORLD(), [t]: B.altAcct([loaded, B.addr('another')]) };
  const { out, stub } = await go([B.sysTransfer(me, loaded, 5000)], { accounts, lookups: { [t]: [loaded, B.addr('another')] } });
  assert.equal(out.request.transaction_version, '0'); assert.deepEqual(out.request.lookup_tables, [t]);
  assert.equal(stub.calls[0].method, 'getMultipleAccounts'); assert.equal(stub.calls[0].params[1].encoding, 'base64');
  const sim = stub.calls.find((c) => c.method === 'simulateTransaction').params[1].accounts.addresses;
  assert.ok(sim.includes(loaded), 'the loaded writable address is requested after the simulation');
  assert.deepEqual(ids(out), ['transfer_to_fresh_account']);
  await assert.rejects(go([B.sysTransfer(me, loaded, 5000)], { lookups: { [t]: [loaded] } }), (e) => e.kind === 'bad_request' && /lookup table .* does not exist/.test(e.message));
});

// ---------- fail closed ----------

test('fail closed: an RPC that cannot simulate is a 503 "Not charged" (never a guess), whichever call fails', async () => {
  const down = () => Object.assign(new Error('solana rpc http 429. Not charged.'), { status: 503, transport: true });
  for (const method of ['simulateTransaction', 'getMultipleAccounts']) {
    const w = { accounts: WORLD(), sim: B.simOk({ accounts: WORLD() }), fail: (m) => (m === method ? down() : null) };
    const stub = B.stubSol(w);
    await assert.rejects(precheckSolana({ tx: B.buildTx({ payer: me, instructions: [B.sysTransfer(me, friend, 1000)] }) }, { rpc: stub.rpc, now: Date.now, solRisk: noRisk }), (e) => e.status === 503 && /Not charged/.test(e.message), method);
  }
});

test('fail closed: a simulation that does not finish within the cap is a 503 with a Retry-After, and the cap is 8 seconds', async () => {
  assert.equal(L.SIM_TIMEOUT_MS, 8000);
  const w = { accounts: WORLD(), sim: null, hang: (m) => m === 'simulateTransaction' };
  const stub = B.stubSol(w);
  const t0 = Date.now();
  await assert.rejects(precheckSolana({ tx: B.buildTx({ payer: me, instructions: [B.memo(me, 'x')] }) }, { rpc: stub.rpc, now: Date.now, solRisk: noRisk, simTimeoutMs: 200 }), (e) => e.status === 503 && e.retryAfter > 0 && /did not finish within 8 s/.test(e.message) && /Not charged\.$/.test(e.message));
  assert.ok(Date.now() - t0 < 2000);
  // the real default is what the module hands every RPC call
  const ok = B.stubSol({ accounts: WORLD(), sim: B.simOk({ accounts: WORLD() }) });
  await precheckSolana({ tx: B.buildTx({ payer: me, instructions: [B.memo(me, 'x')] }) }, { rpc: ok.rpc, now: Date.now, solRisk: noRisk });
  assert.ok(ok.calls.every((c) => c.opts.timeoutMs <= 8000 && c.opts.timeoutMs >= 300));
});

test('the route entry: chain is required and must be solana or base; a repeated parameter is a 400; the Solana half is reached through run()', async () => {
  await assert.rejects(run({}), (e) => e.kind === 'bad_request' && /missing required parameter: chain/.test(e.message));
  await assert.rejects(run({ chain: 'ethereum' }), (e) => e.kind === 'bad_request' && /not covered/.test(e.message));
  await assert.rejects(run({ chain: 'solana', tx: ['a', 'b'] }), (e) => e.kind === 'bad_request' && /more than once/.test(e.message));
  const w = { accounts: WORLD() }; w.sim = B.simOk(w);
  const stub = B.stubSol(w);
  const out = await run({ chain: ' Solana ', tx: B.buildTx({ payer: me, instructions: [B.memo(me, 'x')] }) }, { sol: { rpc: stub.rpc, now: Date.now, solRisk: noRisk } });
  assert.equal(out.chain, 'solana');
});

test('the published example has exactly the shape of a real answer', async () => {
  const ex = example.build();
  const real = (await go([B.tokApprove(myUsdc, stranger, me, 1_000_000)], { post: { [myUsdc]: B.tokAcct({ owner: me, amount: 100_000_000, delegate: stranger, delegated: 1_000_000 }) } })).out;
  assert.deepEqual(Object.keys(ex).sort(), Object.keys(real).sort());
  for (const k of ['request', 'simulation', 'summary', 'as_of']) assert.deepEqual(Object.keys(ex[k]).sort(), Object.keys(real[k]).sort(), k);
  assert.deepEqual(Object.keys(ex.warnings[0]).filter((k) => ['id', 'severity', 'message'].includes(k)), ['id', 'severity', 'message']);
  assert.deepEqual(Object.keys(ex.delegations[0]).sort(), Object.keys(real.delegations[0]).sort());
  assert.equal(JSON.stringify(ex), JSON.stringify(example.build()), 'built twice, identical');
  assert.ok(ex.warnings.some((w) => w.id === 'unlimited_approval'));
  assert.ok(JSON.stringify(real).length < 20000, 'an answer stays small');
});

test('an answer is JSON-able (no BigInt leaks) and stays within the output caps', async () => {
  const { out } = await go([B.tokTransferChecked(myUsdc, B.USDC, friendUsdc, me, 95_000_000, 6), B.sysTransfer(me, fresh, 4_999_000_000)]);
  assert.doesNotThrow(() => JSON.stringify(out));
  assert.ok(out.simulation.logs.length <= L.LOG_LINES);
  assert.ok(out.balance_changes.length <= L.MAX_BALANCE_CHANGES);
});

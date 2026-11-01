// test/fixtures/r24/txprecheck/build.js: builders for the Solana tests of GET /api/tx-precheck (R24 item 4). Everything is invented: addresses are derived from labels, nothing is signed (the
// transactions are UNSIGNED wire transactions, which is what the route accepts), and the RPC is a stub that answers from a map of accounts and a canned simulation.
'use strict';
const crypto = require('crypto');
const K = require('@solana/kit');

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const ALT = 'AddressLookupTab1e1111111111111111111111111';
const BLOCKHASH = K.getAddressDecoder().decode(crypto.createHash('sha256').update('r24 blockhash').digest());

/** a valid, invented address for a label */
const addr = (label) => K.getAddressDecoder().decode(crypto.createHash('sha256').update(`r24 txprecheck fixture ${label}`).digest());
const R = K.AccountRole;
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const meta = (address, role) => ({ address: K.address(address), role });
const W_S = R.WRITABLE_SIGNER, W = R.WRITABLE, S = R.READONLY_SIGNER, RO = R.READONLY;

// ---- instructions
const sysTransfer = (from, to, lamports) => ({ programAddress: K.address(SYSTEM), accounts: [meta(from, W_S), meta(to, W)], data: Uint8Array.from(Buffer.concat([Buffer.from([2, 0, 0, 0]), u64le(lamports)])) });
const sysAssign = (account, owner) => ({ programAddress: K.address(SYSTEM), accounts: [meta(account, W_S)], data: Uint8Array.from(Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from(K.getAddressEncoder().encode(K.address(owner)))])) });
const tokTransfer = (source, dest, authority, amount, program = TOKEN) => ({ programAddress: K.address(program), accounts: [meta(source, W), meta(dest, W), meta(authority, S)], data: Uint8Array.from(Buffer.concat([Buffer.from([3]), u64le(amount)])) });
const tokTransferChecked = (source, mint, dest, authority, amount, decimals, program = TOKEN) => ({ programAddress: K.address(program), accounts: [meta(source, W), meta(mint, RO), meta(dest, W), meta(authority, S)], data: Uint8Array.from(Buffer.concat([Buffer.from([12]), u64le(amount), Buffer.from([decimals])])) });
const tokApprove = (account, delegate, owner, amount, program = TOKEN) => ({ programAddress: K.address(program), accounts: [meta(account, W), meta(delegate, RO), meta(owner, S)], data: Uint8Array.from(Buffer.concat([Buffer.from([4]), u64le(amount)])) });
const tokApproveChecked = (account, mint, delegate, owner, amount, decimals, program = TOKEN) => ({ programAddress: K.address(program), accounts: [meta(account, W), meta(mint, RO), meta(delegate, RO), meta(owner, S)], data: Uint8Array.from(Buffer.concat([Buffer.from([13]), u64le(amount), Buffer.from([decimals])])) });
const tokSetAuthority = (account, current, typeIndex, newAuthority, program = TOKEN) => ({ programAddress: K.address(program), accounts: [meta(account, W), meta(current, S)], data: Uint8Array.from(Buffer.concat([Buffer.from([6, typeIndex]), newAuthority ? Buffer.concat([Buffer.from([1]), Buffer.from(K.getAddressEncoder().encode(K.address(newAuthority)))]) : Buffer.from([0])])) });
const tokClose = (account, destination, owner, program = TOKEN) => ({ programAddress: K.address(program), accounts: [meta(account, W), meta(destination, W), meta(owner, S)], data: Uint8Array.from([9]) });
const ataCreate = (payer, ata, wallet, mint, { idempotent = true, program = TOKEN } = {}) => ({ programAddress: K.address(ATA), accounts: [meta(payer, W_S), meta(ata, W), meta(wallet, RO), meta(mint, RO), meta(SYSTEM, RO), meta(program, RO)], data: Uint8Array.from([idempotent ? 1 : 0]) });
const memo = (signer, text) => ({ programAddress: K.address(MEMO), accounts: [meta(signer, S)], data: new TextEncoder().encode(text) });
const loaderSetAuthority = (programData, current, next) => ({ programAddress: K.address(LOADER), accounts: [meta(programData, W), meta(current, S), ...(next ? [meta(next, RO)] : [])], data: Uint8Array.from([4, 0, 0, 0]) });
const unknownProgram = (programId, signer, accounts = []) => ({ programAddress: K.address(programId), accounts: [meta(signer, W_S), ...accounts.map((a) => meta(a, W))], data: Uint8Array.from([1, 2, 3]) });

/** an unsigned wire transaction (base64). `lookups` = { tableAddress: [addresses...] } makes it a version 0 transaction that uses those tables. */
function buildTx({ payer, instructions, version = 'legacy', lookups = null }) {
  let m = K.pipe(K.createTransactionMessage({ version: lookups ? 0 : version }), (x) => K.setTransactionMessageFeePayer(K.address(payer), x),
    (x) => K.setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000n }, x), (x) => K.appendTransactionMessageInstructions(instructions, x));
  if (lookups) m = K.compressTransactionMessageUsingAddressLookupTables(m, Object.fromEntries(Object.entries(lookups).map(([t, list]) => [t, list.map((a) => K.address(a))])));
  return K.getBase64EncodedWireTransaction(K.compileTransaction(m));
}

// ---- accounts as the RPC returns them (jsonParsed)
const sysAcct = (lamports) => ({ lamports, owner: SYSTEM, executable: false, space: 0, data: ['', 'base64'], rentEpoch: 0 });
const tokAcct = ({ mint = USDC, owner, amount = 0, decimals = 6, delegate = null, delegated = 0, program = TOKEN, lamports = 2039280 }) => ({
  lamports, owner: program, executable: false, space: 165, rentEpoch: 0,
  data: { program: program === TOKEN_2022 ? 'spl-token-2022' : 'spl-token', space: 165, parsed: { type: 'account', info: { isNative: false, mint, owner, state: 'initialized', tokenAmount: { amount: String(amount), decimals, uiAmount: amount / 10 ** decimals, uiAmountString: String(amount / 10 ** decimals) }, ...(delegate ? { delegate, delegatedAmount: { amount: String(delegated), decimals, uiAmount: 0, uiAmountString: '0' } } : {}) } } },
});
const mintAcct = ({ decimals = 6, mintAuthority = null, freezeAuthority = null, supply = 1_000_000 }) => ({ lamports: 1461600, owner: TOKEN, executable: false, space: 82, rentEpoch: 0, data: { program: 'spl-token', space: 82, parsed: { type: 'mint', info: { decimals, freezeAuthority, isInitialized: true, mintAuthority, supply: String(supply) } } } });
const altAcct = (addresses) => { const head = Buffer.alloc(56); head.writeUInt32LE(1, 0); const body = Buffer.concat(addresses.map((a) => Buffer.from(K.getAddressEncoder().encode(K.address(a))))); return { lamports: 1000000, owner: ALT, executable: false, space: 56 + body.length, rentEpoch: 0, data: [Buffer.concat([head, body]).toString('base64'), 'base64'] }; };

/**
 * A stub of lib/solrpc.rpc. `world` = { accounts: Map|object address -> raw account, sim: (txBase64, addresses) -> value | function, slot }.
 * Records every call in `calls` ({ method, params }). `world.fail(method)` may return an Error to throw.
 */
function stubSol(world) {
  const calls = [];
  const accounts = world.accounts instanceof Map ? world.accounts : new Map(Object.entries(world.accounts || {}));
  const rpc = async (method, params, opts) => {
    calls.push({ method, params, opts });
    if (world.fail) { const e = world.fail(method); if (e) throw e; }
    if (world.hang && world.hang(method)) return new Promise(() => {});
    const slot = world.slot ?? 464000000;
    if (method === 'getMultipleAccounts') return { context: { slot }, value: params[0].map((a) => accounts.get(a) || null) };
    if (method === 'simulateTransaction') {
      const value = typeof world.sim === 'function' ? world.sim(params[0], params[1].accounts.addresses) : world.sim;
      return { context: { slot: slot + 1 }, value };
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { rpc, calls, accounts };
}

/** the simulation value for a transaction that ran: post-state accounts for the requested writable addresses (default: their pre-state), no inner instructions */
const simOk = (world, post = {}, extra = {}) => (tx, addresses) => ({ err: null, logs: ['Program log: ok'], unitsConsumed: 1234, fee: 5000, innerInstructions: [], accounts: addresses.map((a) => (a in post ? post[a] : (world.accounts instanceof Map ? world.accounts.get(a) : world.accounts[a])) || null), ...extra });

module.exports = { SYSTEM, TOKEN, TOKEN_2022, ATA, MEMO, LOADER, USDC, WSOL, ALT, BLOCKHASH, addr, buildTx, sysTransfer, sysAssign, tokTransfer, tokTransferChecked, tokApprove, tokApproveChecked, tokSetAuthority, tokClose, ataCreate, memo, loaderSetAuthority, unknownProgram, sysAcct, tokAcct, mintAcct, altAcct, stubSol, simOk, u64le };

// tools/r24/txprecheck/sol-ops.js: a Solana transaction's decoded form and the "ops" its instructions amount to (R24 item 4).
// Nothing here talks to the network and nothing here signs or sends anything: it reads bytes. Two sources feed the same list of ops:
//   - the top-level instructions of the transaction itself (raw bytes, decoded here for the System, SPL Token, Token-2022, Associated Token Account, BPF Loader Upgradeable and Stake programs), and
//   - the inner (CPI) instructions the simulation reports, which the node already parsed (jsonParsed) for the same programs.
// An op is a plain object { op, ... } with base58 strings and BigInt amounts. Instructions of any other program produce no op: they are still listed as an invoked program.
'use strict';
const K = require('@solana/kit');
const { bad } = require('../../r23/common');
const L = require('./limits');

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const STAKE = 'Stake11111111111111111111111111111111111111';
const isTokenProgram = (p) => p === TOKEN || p === TOKEN_2022;

const AUTHORITY_TYPES = { 0: 'mint authority', 1: 'freeze authority', 2: 'account owner', 3: 'close authority', 4: 'transfer-fee config authority', 5: 'withheld-withdraw authority', 6: 'mint close authority', 7: 'interest-rate authority', 8: 'permanent delegate', 9: 'confidential-transfer mint authority', 10: 'transfer-hook program id', 11: 'confidential-transfer fee authority', 12: 'metadata pointer authority', 13: 'group pointer authority', 14: 'group member pointer authority', 15: 'scaled-ui-amount authority', 16: 'pause authority' };
const PARSED_AUTHORITY = { mintTokens: 'mint authority', freezeAccount: 'freeze authority', accountOwner: 'account owner', closeAccount: 'close authority' };

const addr = (bytes) => K.getAddressDecoder().decode(bytes);

/** the base64 text of a transaction, checked and decoded; throws the caller's 400 for anything that is not a Solana transaction within the size cap */
function parseInput(raw) {
  if (raw != null && typeof raw !== 'string') throw bad('tx must be a base64 string');
  let s = raw == null ? '' : raw.trim().replace(/ /g, '+');   // a "+" lost to URL decoding arrives as a space
  if (!s) throw bad('missing required parameter: tx, a base64 Solana transaction (versioned or legacy, signed or unsigned)');
  if (s.length > L.MAX_SOL_TX_B64) throw bad(`tx is ${s.length} characters of base64; the cap is ${L.MAX_SOL_TX_B64} (a Solana transaction is at most ${L.MAX_SOL_TX_BYTES} bytes)`);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) throw bad('tx is not base64');
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Buffer.from(s, 'base64');
  if (bytes.length > L.MAX_SOL_TX_BYTES) throw bad(`tx is ${bytes.length} bytes; a Solana transaction is at most ${L.MAX_SOL_TX_BYTES} bytes`);
  if (bytes.length < 1 + 64 + 3 + 32 + 32 + 1) throw bad('tx is too short to be a Solana transaction');
  return { bytes: new Uint8Array(bytes), b64: bytes.toString('base64') };
}

/** { version, header, staticKeys, lookups, instructions, signatureCount, sizeBytes } from the wire bytes; throws a 400 when they are not a legacy or v0 transaction */
function decodeTx(bytes) {
  let tx; let msg;
  try {
    tx = K.getTransactionDecoder().decode(bytes);
    msg = K.getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch (e) {
    throw bad('tx is not a legacy or version 0 Solana transaction');
  }
  if (msg.version !== 'legacy' && msg.version !== 0) throw bad(`transaction version ${msg.version} is not covered (legacy and 0 are)`);
  const h = msg.header;
  if (!msg.staticAccounts.length || h.numSignerAccounts < 1 || h.numSignerAccounts > msg.staticAccounts.length) throw bad('tx header is inconsistent');
  const lookups = (msg.addressTableLookups || []).map((t) => ({ table: String(t.lookupTableAddress), writable: Array.from(t.writableIndexes), readonly: Array.from(t.readonlyIndexes) }));
  const instructions = msg.instructions.map((ix) => ({ programIndex: ix.programAddressIndex, accountIndexes: Array.from(ix.accountIndices || []), data: ix.data ? Uint8Array.from(ix.data) : new Uint8Array(0) }));
  return { version: msg.version, header: h, staticKeys: msg.staticAccounts.map(String), lookups, instructions, signatureCount: Object.keys(tx.signatures || {}).length, sizeBytes: bytes.length };
}

/** the table accounts' addresses from the raw account data (56-byte header, then 32 bytes per address) */
function tableAddresses(base64Data) {
  const b = Buffer.from(base64Data, 'base64');
  if (b.length < 56) return [];
  const out = [];
  for (let o = 56; o + 32 <= b.length; o += 32) out.push(addr(b.subarray(o, o + 32)));
  return out;
}

/**
 * Every account key in the order instructions index them, with its role. `tables` maps a lookup-table address to its list of addresses.
 * Returns { keys: [{ address, signer, writable, loaded }], missing: [table addresses not in `tables`] }.
 */
function buildKeys(d, tables = new Map()) {
  const h = d.header; const n = d.staticKeys.length;
  const keys = d.staticKeys.map((address, i) => {
    const signer = i < h.numSignerAccounts;
    const writable = signer ? i < h.numSignerAccounts - h.numReadonlySignerAccounts : i < n - h.numReadonlyNonSignerAccounts;
    return { address, signer, writable, loaded: false };
  });
  const missing = [];
  const wr = []; const ro = [];
  for (const l of d.lookups) {
    const list = tables.get(l.table);
    if (!list) { missing.push(l.table); continue; }
    for (const i of l.writable) { if (i >= list.length) throw bad('tx names an address-table index that the table does not have'); wr.push({ address: list[i], signer: false, writable: true, loaded: true }); }
    for (const i of l.readonly) { if (i >= list.length) throw bad('tx names an address-table index that the table does not have'); ro.push({ address: list[i], signer: false, writable: false, loaded: true }); }
  }
  return { keys: keys.concat(wr, ro), missing };
}

const u64 = (b, o) => b.readBigUInt64LE(o);
const rd = (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

/** the ops of one instruction given as raw bytes: (programId, account addresses, data) */
function opsFromRaw(programId, acc, data, where) {
  const b = rd(data); const out = [];
  const at = (i) => acc[i];
  try {
    if (programId === SYSTEM && b.length >= 4) {
      const t = b.readUInt32LE(0);
      if (t === 0 && b.length >= 52) out.push({ op: 'sys_create', from: at(0), to: at(1), lamports: u64(b, 4), space: u64(b, 12), owner: addr(b.subarray(20, 52)) });
      else if (t === 1 && b.length >= 36) out.push({ op: 'sys_assign', account: at(0), owner: addr(b.subarray(4, 36)) });
      else if (t === 2 && b.length >= 12) out.push({ op: 'sol_transfer', from: at(0), to: at(1), lamports: u64(b, 4) });
      else if (t === 3 && b.length >= 4 + 32 + 8) {                       // CreateAccountWithSeed: base, seed (u64 length + bytes), lamports, space, owner
        const sl = Number(u64(b, 36)); const o = 44 + sl;
        if (b.length >= o + 8 + 8 + 32) out.push({ op: 'sys_create', from: at(0), to: at(1), lamports: u64(b, o), space: u64(b, o + 8), owner: addr(b.subarray(o + 16, o + 48)) });
      } else if (t === 5 && b.length >= 12) out.push({ op: 'sol_transfer', from: at(0), to: at(1), lamports: u64(b, 4), nonce: true });   // WithdrawNonceAccount: nonce account -> destination
      else if (t === 7 && b.length >= 36) out.push({ op: 'authority_change', what: 'nonce account authority', subject: at(0), to: addr(b.subarray(4, 36)), program: 'system' });
      else if (t === 10 && b.length >= 4 + 32 + 8) {                      // AssignWithSeed: base, seed, owner
        const sl = Number(u64(b, 36)); const o = 44 + sl;
        if (b.length >= o + 32) out.push({ op: 'sys_assign', account: at(0), owner: addr(b.subarray(o, o + 32)) });
      } else if (t === 11 && b.length >= 12) out.push({ op: 'sol_transfer', from: at(0), to: at(2), lamports: u64(b, 4), withSeed: true });   // TransferWithSeed: from, base, to
    } else if (isTokenProgram(programId) && b.length >= 1) {
      const t = b[0]; const program = programId;
      if (t === 3 && b.length >= 9) out.push({ op: 'tok_transfer', source: at(0), destination: at(1), mint: null, amount: u64(b, 1), authority: at(2), program });
      else if (t === 12 && b.length >= 10) out.push({ op: 'tok_transfer', source: at(0), destination: at(2), mint: at(1), amount: u64(b, 1), decimals: b[9], authority: at(3), program });
      else if (t === 4 && b.length >= 9) out.push({ op: 'tok_approve', account: at(0), delegate: at(1), amount: u64(b, 1), mint: null, authority: at(2), program });
      else if (t === 13 && b.length >= 10) out.push({ op: 'tok_approve', account: at(0), delegate: at(2), amount: u64(b, 1), mint: at(1), decimals: b[9], authority: at(3), program });
      else if (t === 5) out.push({ op: 'tok_revoke', account: at(0), authority: at(1), program });
      else if (t === 6 && b.length >= 3) {
        const typ = b[1]; const has = b[2] === 1 && b.length >= 35;
        out.push({ op: 'tok_set_authority', account: at(0), authorityType: AUTHORITY_TYPES[typ] || `type ${typ}`, newAuthority: has ? addr(b.subarray(3, 35)) : null, authority: at(1), program });
      } else if (t === 9) out.push({ op: 'tok_close', account: at(0), destination: at(1), authority: at(2), program });
      else if (t === 8 && b.length >= 9) out.push({ op: 'tok_burn', account: at(0), mint: at(1), amount: u64(b, 1), authority: at(2), program });
      else if (t === 15 && b.length >= 10) out.push({ op: 'tok_burn', account: at(0), mint: at(1), amount: u64(b, 1), authority: at(2), program });
    } else if (programId === ATA) {
      const t = b.length === 0 ? 0 : b[0];
      if (t === 0 || t === 1) out.push({ op: 'ata_create', payer: at(0), account: at(1), wallet: at(2), mint: at(3), idempotent: t === 1 });
    } else if (programId === LOADER && b.length >= 4) {
      const t = b.readUInt32LE(0);
      if (t === 4) out.push({ op: 'authority_change', what: 'program upgrade authority', subject: at(0), to: at(2) || null, program: 'bpf-loader-upgradeable' });
      else if (t === 7) out.push({ op: 'authority_change', what: 'program upgrade authority', subject: at(0), to: at(2) || null, program: 'bpf-loader-upgradeable' });
    } else if (programId === STAKE && b.length >= 4) {
      const t = b.readUInt32LE(0);
      if ((t === 1 && b.length >= 40) || t === 10) out.push({ op: 'authority_change', what: 'stake account authority', subject: at(0), to: t === 1 ? addr(b.subarray(4, 36)) : at(3) || null, program: 'stake' });
    }
  } catch { /* a truncated instruction yields no op; the program is still reported as invoked */ }
  return out.map((o) => ({ ...o, where }));
}

const num = (v) => { try { return BigInt(v); } catch { return 0n; } };

/** the ops of one inner instruction as the node parsed it (jsonParsed), or decoded from its raw form when the node left it unparsed */
function opsFromInner(ix, where) {
  const programId = ix.programId;
  const p = ix.parsed;
  if (!p || typeof p !== 'object') {
    if (Array.isArray(ix.accounts) && typeof ix.data === 'string') {
      try { return opsFromRaw(programId, ix.accounts, K.getBase58Encoder().encode(ix.data), where); } catch { return []; }
    }
    return [];
  }
  const i = p.info || {}; const t = p.type; const out = [];
  if (programId === SYSTEM) {
    if (t === 'transfer') out.push({ op: 'sol_transfer', from: i.source, to: i.destination, lamports: num(i.lamports) });
    else if (t === 'transferWithSeed') out.push({ op: 'sol_transfer', from: i.source, to: i.destination, lamports: num(i.lamports), withSeed: true });
    else if (t === 'withdrawFromNonce') out.push({ op: 'sol_transfer', from: i.nonceAccount, to: i.destination, lamports: num(i.lamports), nonce: true });
    else if (t === 'createAccount' || t === 'createAccountWithSeed') out.push({ op: 'sys_create', from: i.source, to: i.newAccount, lamports: num(i.lamports), space: num(i.space), owner: i.owner });
    else if (t === 'assign' || t === 'assignWithSeed') out.push({ op: 'sys_assign', account: i.account, owner: i.owner });
    else if (t === 'authorizeNonce') out.push({ op: 'authority_change', what: 'nonce account authority', subject: i.nonceAccount, to: i.newAuthorized, program: 'system' });
  } else if (isTokenProgram(programId)) {
    const authority = i.authority || i.multisigAuthority || i.owner || i.multisigOwner;
    const amount = i.amount != null ? num(i.amount) : num(i.tokenAmount && i.tokenAmount.amount);
    if (t === 'transfer' || t === 'transferChecked') out.push({ op: 'tok_transfer', source: i.source, destination: i.destination, mint: i.mint || null, amount, decimals: i.tokenAmount ? i.tokenAmount.decimals : undefined, authority, program: programId });
    else if (t === 'approve' || t === 'approveChecked') out.push({ op: 'tok_approve', account: i.source, delegate: i.delegate, amount, mint: i.mint || null, decimals: i.tokenAmount ? i.tokenAmount.decimals : undefined, authority, program: programId });
    else if (t === 'revoke') out.push({ op: 'tok_revoke', account: i.source, authority, program: programId });
    else if (t === 'setAuthority') out.push({ op: 'tok_set_authority', account: i.account || i.mint, authorityType: PARSED_AUTHORITY[i.authorityType] || String(i.authorityType), newAuthority: i.newAuthority || null, authority, program: programId });
    else if (t === 'closeAccount') out.push({ op: 'tok_close', account: i.account, destination: i.destination, authority, program: programId });
    else if (t === 'burn' || t === 'burnChecked') out.push({ op: 'tok_burn', account: i.account, mint: i.mint, amount, authority, program: programId });
  } else if (programId === ATA) {
    if (t === 'create' || t === 'createIdempotent') out.push({ op: 'ata_create', payer: i.source, account: i.account, wallet: i.wallet, mint: i.mint, idempotent: t === 'createIdempotent' });
  }
  return out.map((o) => ({ ...o, where }));
}

/** top-level instructions -> [{ index, programId, accounts, data }] (account addresses resolved through `keys`) */
function resolveInstructions(d, keys) {
  return d.instructions.map((ix, index) => {
    const prog = keys[ix.programIndex];
    if (!prog) throw bad('tx names a program index that is not in its account list');
    const accounts = ix.accountIndexes.map((j) => { if (!keys[j]) throw bad('tx names an account index that is not in its account list'); return keys[j].address; });
    return { index, programId: prog.address, accounts, data: ix.data };
  });
}

/** every op of the top-level instructions */
function topOps(instructions) {
  const out = [];
  for (const ix of instructions) out.push(...opsFromRaw(ix.programId, ix.accounts, ix.data, { index: ix.index, inner: false }));
  return out;
}

/** every op of the node's inner instructions: [{ index, instructions: [...] }] */
function innerOps(inner) {
  const out = [];
  for (const group of inner || []) for (const ix of group.instructions || []) out.push(...opsFromInner(ix, { index: group.index, inner: true }));
  return out;
}

/** every program id invoked: top-level instruction programs, then inner ones; first-seen order, no duplicates */
function invokedPrograms(instructions, inner) {
  const seen = new Map();
  for (const ix of instructions) if (!seen.has(ix.programId)) seen.set(ix.programId, { top: true });
  for (const group of inner || []) for (const ix of group.instructions || []) if (ix.programId && !seen.has(ix.programId)) seen.set(ix.programId, { top: false });
  return [...seen].map(([id, v]) => ({ id, top: v.top }));
}

module.exports = { SYSTEM, TOKEN, TOKEN_2022, ATA, LOADER, STAKE, isTokenProgram, parseInput, decodeTx, tableAddresses, buildKeys, resolveInstructions, topOps, innerOps, invokedPrograms, opsFromRaw, opsFromInner, AUTHORITY_TYPES };

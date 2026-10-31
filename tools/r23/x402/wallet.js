// tools/r23/x402/wallet.js: the dedicated x402-test wallet (R23 T3, 31 Oct 2026).
//
// Keys live in two files made by ops/r23-x402-wallet-gen.mjs in X402TEST_WALLET_DIR (default /opt/agentfeed/x402-test-wallet): base.key (0x and 64 hex) and solana.json (a
// 64-byte keypair array, the format solana-keygen writes). They are read PER CALL, used and dropped: nothing is read at require time, no key or file text is cached, and no error
// or log line built here carries key material. A key file is REFUSED (the chain is treated as not set up) when it is readable by group or others, is unreadable, or when the address
// it holds is a treasury (the manifest's payTo values: PAY_TO* in the environment plus the two documented treasuries) or is on lib/own-traffic.js's own-wallet list. The own-wallet
// refusal is lifted for the dedicated wallet in two ways, so it can be listed as an own payer without locking itself out: (1) the tracked file tools/r23/x402/test-wallet.json
// ({ "base": "0x...", "solana": "..." }, the two PUBLIC addresses the generator printed) lifts it for a key whose address equals the file's address FOR THE SAME CHAIN, no environment
// variable needed; (2) X402TEST_ALLOW_OWN_ADDRESS lifts it for exact addresses. Neither ever lifts a treasury (manifest payTo), nor any of the own wallets that existed before the dedicated
// one (PROTECTED_OWN: Gack9, the Circle Gateway payer, the owner's wallets ...): naming one of those in the file or the variable changes nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const { unavailable } = require('../common');
const R = require('./rubric');
const P = require('./parse');

const DEFAULT_DIR = '/opt/agentfeed/x402-test-wallet';
const FILES = { base: 'base.key', solana: 'solana.json' };
// the treasuries as the manifest lists them: cj7 (Solana) and 6e6 (Base, Polygon, Arbitrum) from the documented wallets, plus the Arc payTo and the Gateway receiver authorizer that the live
// challenge of 31 Oct 2026 carries. All public addresses. PAY_TO* of the environment and X402TEST_REFUSE_ADDRESSES (comma separated) add to them on the box.
const KNOWN_TREASURIES = ['4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6', '0x0Cf44185564F2b72E291050DC79E578429E52f83', '0xBa3056eC310658e42dFb8a0Fa349C5406212bE37'];
// the own wallets of lib/own-traffic.js as of 31 Oct 2026, before the dedicated test wallet: real keys exist elsewhere for each, so nothing can make the loader accept them (a drift test checks
// that each is still on the real list).
const PROTECTED_OWN = ['EqRNNpKVpu6jm8iRTNa17Rht2TRTzCtNNz37M9m2Di1', 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu', 'TeStKWyNre9PW8XbLfvuBm9f6EnTBYqS5GXTzciCnHw', '0xFEfF369D5048b2Cf817d87467E48404b3ADfE4Ee',
  '0x05b38ff795a2d750788157f1119e5d403d8ef47a', '0xcc1177889ff3fb19ed851c1dd9bf4b1871ee3736', '0xB96c536A2b01584c5Dd8967AF0d8Ba97eBC2417F'];
const DEDICATED_FILE = path.join(__dirname, 'test-wallet.json');
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BALANCE_OF = '0x70a08231';

const norm = (a) => (P.isEvmAddr(a) ? String(a).toLowerCase() : String(a));

/** the payTo values of the manifest as far as the environment knows them, plus the two documented treasuries -> Set of normalised addresses */
function treasuryAddresses(env = process.env) {
  const s = new Set(KNOWN_TREASURIES.map(norm));
  for (const [k, v] of Object.entries(env)) if (/^PAY_TO/.test(k) && typeof v === 'string' && v.trim()) s.add(norm(v.trim()));
  for (const a of String(env.X402TEST_REFUSE_ADDRESSES || '').split(',').map((x) => x.trim()).filter(Boolean)) s.add(norm(a));
  return s;
}
/** lib/own-traffic.js's list -> Set of normalised addresses */
const ownAddresses = () => new Set(require('../../../lib/own-traffic').OWN_WALLET_LIST.map(norm));
const allowedOwn = (env = process.env) => new Set(String(env.X402TEST_ALLOW_OWN_ADDRESS || '').split(',').map((x) => x.trim()).filter(Boolean).map(norm));

/**
 * The two public addresses of the dedicated wallet from the tracked file -> { base, solana } (normalised, each null when absent or not an address of its chain). Read per call;
 * a missing, unreadable or malformed file is simply "no dedicated address": the lift then does not apply.
 */
function dedicatedWallets(file = DEDICATED_FILE) {
  const out = { base: null, solana: null };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object') {
      if (P.isEvmAddr(j.base)) out.base = norm(j.base);
      if (P.isSolAddr(j.solana)) out.solana = norm(j.solana);
    }
  } catch { /* no file, or not JSON */ }
  return out;
}

/** -> null when the address may be used, else 'treasury' or 'own wallet'. `chain` ('base' | 'solana') says which entry of the dedicated file may lift the own-wallet refusal. */
function refusal(address, { env = process.env, own = ownAddresses(), treasuries = treasuryAddresses(env), chain, dedicated = dedicatedWallets(), protectedOwn = PROTECTED_OWN } = {}) {
  const a = norm(address);
  if (treasuries.has(a)) return 'treasury';
  if (protectedOwn.some((p) => norm(p) === a)) return 'own wallet';
  if (own.has(a)) {
    const fileLift = Boolean(chain && dedicated && dedicated[chain] && norm(dedicated[chain]) === a);
    if (!fileLift && !allowedOwn(env).has(a)) return 'own wallet';
  }
  return null;
}

const REFUSED_TEXT = { treasury: 'the address in the key file is a treasury address', 'own wallet': 'the address in the key file is on the own-wallet list' };
const walletDir = (env = process.env) => env.X402TEST_WALLET_DIR || DEFAULT_DIR;

function readKeyFile(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { reason: 'the key path is not a regular file' });
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw Object.assign(new Error('permissions'), { reason: 'the key file is readable by group or others; it must be mode 600' });
  return fs.readFileSync(file, 'utf8');
}

/**
 * -> { base, solana, problems }. Each wallet is { chain, address, signer } or null; `problems` is [{ chain, reason }] for a file that exists and was refused or could not be read
 * (a file that does not exist is not a problem, it is simply not set up). Nothing thrown here carries key text.
 */
async function loadWallets({ env = process.env, dir = walletDir(env), own, treasuries, dedicated = dedicatedWallets() } = {}) {
  const out = { base: null, solana: null, problems: [] };
  const refuse = (a, chain) => refusal(a, { env, own, treasuries, chain, dedicated });
  const problem = (chain, reason) => out.problems.push({ chain, reason });
  // ---- Base
  const bf = path.join(dir, FILES.base);
  if (fs.existsSync(bf)) {
    try {
      const hex = readKeyFile(bf).trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw Object.assign(new Error('format'), { reason: 'not a 0x and 64 hex key' });
      const { privateKeyToAccount } = require('viem/accounts');
      const account = privateKeyToAccount(hex);
      const why = refuse(account.address, 'base');
      if (why) problem('base', REFUSED_TEXT[why]);
      else out.base = { chain: 'base', address: account.address, signer: account };
    } catch (e) { problem('base', e.reason || 'the key file could not be read'); }
  }
  // ---- Solana
  const sf = path.join(dir, FILES.solana);
  if (fs.existsSync(sf)) {
    try {
      const arr = JSON.parse(readKeyFile(sf));
      if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw Object.assign(new Error('format'), { reason: 'not a 64-byte keypair array' });
      const K = require('@solana/kit');
      const kp = await K.createKeyPairSignerFromBytes(Uint8Array.from(arr));
      const why = refuse(kp.address, 'solana');
      if (why) problem('solana', REFUSED_TEXT[why]);
      else out.solana = { chain: 'solana', address: kp.address, signer: require('@x402/svm').toClientSvmSigner(kp) };
    } catch (e) { problem('solana', e.reason || 'the key file could not be read'); }
  }
  return out;
}

// ---- balances (USDC, atomic units as BigInt). A read that fails is an error, never a zero.
const BASE_RPC_DEFAULT = 'https://mainnet.base.org';

async function baseUsdcBalance(address, { env = process.env, fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 8000 } = {}) {
  if (!P.isEvmAddr(address)) throw new Error('not an EVM address');
  const url = env.X402TEST_BASE_RPC || BASE_RPC_DEFAULT;
  const data = BALANCE_OF + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  let j;
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: R.PAYABLE.base.asset, data }, 'latest'] }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > 10000) throw new Error('answer too large');
    j = JSON.parse(text);
  } catch (e) { throw unavailable(`the Base balance of the test wallet could not be read (${P.show(e.message, 60)})`, 120); }
  if (!j || j.error || typeof j.result !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(j.result)) throw unavailable('the Base balance of the test wallet could not be read (unexpected answer)', 120);
  return BigInt(j.result);
}

/** the USDC associated token account of a Solana owner (classic token program) */
async function usdcAta(owner, mint = R.PAYABLE.solana.asset) {
  const K = require('@solana/kit');
  const enc = K.getAddressEncoder();
  const [ata] = await K.getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(owner), enc.encode(TOKEN_PROGRAM), enc.encode(mint)] });
  return ata;
}

async function solanaUsdcBalance(address, { rpc = (...a) => require('../../../lib/solrpc').rpc(...a) } = {}) {
  if (!P.isSolAddr(address)) throw new Error('not a Solana address');
  const ata = await usdcAta(address);
  let r;
  try { r = await rpc('getTokenAccountBalance', [ata, { commitment: 'confirmed' }]); } catch (e) {
    if (/could not find account/i.test(String((e && e.message) || ''))) return 0n;     // the account was never created: nothing was ever sent to it
    throw unavailable(`the Solana balance of the test wallet could not be read (${P.show((e && e.message) || 'error', 60)})`, 120);
  }
  const v = r && r.value;
  if (!v || typeof v.amount !== 'string' || !/^\d{1,30}$/.test(v.amount) || v.decimals !== 6) throw unavailable('the Solana balance of the test wallet could not be read (unexpected answer)', 120);
  return BigInt(v.amount);
}

module.exports = { loadWallets, refusal, dedicatedWallets, PROTECTED_OWN, DEDICATED_FILE, treasuryAddresses, ownAddresses, allowedOwn, walletDir, baseUsdcBalance, solanaUsdcBalance, usdcAta, DEFAULT_DIR, FILES, KNOWN_TREASURIES, ATA_PROGRAM, TOKEN_PROGRAM };

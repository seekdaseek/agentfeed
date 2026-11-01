// tools/r24/txprecheck/warn.js: the warning vocabulary of GET /api/tx-precheck and the small number helpers both chains share (R24 item 4).
// A warning is a FACT about what the simulated transaction does, in a plain sentence: it never says a transaction is safe and never tells the reader what to do.
// The ids are stable: a client may match on them.
'use strict';

const IDS = Object.freeze([
  'unlimited_approval',          // an allowance or delegated amount that no balance can exhaust
  'delegate_granted',            // a delegate (Solana) or an operator for a whole collection (EVM) may move assets without a new signature
  'transfer_to_fresh_account',   // value goes to an account that did not exist, or had no balance, code or history, before the transaction
  'close_account_to_other',      // a token account is closed and its lamports go to someone other than its owner
  'unknown_program',             // a program or contract that is not in this service's table of well-known ones is invoked
  'high_risk_token',             // a token involved has a high-risk token-risk read
  'authority_change',            // an owner, authority or admin is changed
  'large_balance_outflow',       // 90 percent or more of an account's balance of one asset leaves it
  'approval_to_unknown_spender', // an allowance is granted to a spender that is not in the table of well-known contracts (EVM)
]);
const RANK = { high: 3, medium: 2, low: 1 };
const OUTFLOW_FRACTION_BPS = 9000n;          // 90 percent
const SOL_OUTFLOW_FLOOR_LAMPORTS = 50_000_000n;   // 0.05 SOL: below this an emptied wallet is dust, not a finding
const ETH_OUTFLOW_FLOOR_WEI = 5n * 10n ** 16n;    // 0.05 ETH
const UNLIMITED_U64 = 1n << 63n;                  // Solana: at least half of the u64 range
const UNLIMITED_EVM = (1n << 96n) - 1n;           // EVM: at least the uint96 maximum (covers uint96, uint128, uint160 and uint256 "max" conventions)

/** build one warning; `detail` is merged in after the fixed keys */
function warning(id, severity, message, detail = {}) {
  if (!IDS.includes(id)) throw new Error(`unknown warning id ${id}`);
  if (!RANK[severity]) throw new Error(`unknown severity ${severity}`);
  return { id, severity, message, ...detail };
}

/** highest severity first, then the order of IDS, then the order found */
function sortWarnings(list) {
  return list.map((w, i) => [w, i]).sort((a, b) => (RANK[b[0].severity] - RANK[a[0].severity]) || (IDS.indexOf(a[0].id) - IDS.indexOf(b[0].id)) || (a[1] - b[1])).map((x) => x[0]);
}

/** a raw integer as a decimal string with `decimals` places, no float involved and no trailing zeros */
function fmtUnits(raw, decimals) {
  const neg = raw < 0n; const abs = neg ? -raw : raw;
  const d = Number.isInteger(decimals) && decimals > 0 ? decimals : 0;
  let s = abs.toString();
  if (d > 0) {
    s = s.padStart(d + 1, '0');
    const frac = s.slice(s.length - d).replace(/0+$/, '');
    s = s.slice(0, s.length - d) + (frac ? `.${frac}` : '');
  }
  return (neg ? '-' : '') + s;
}

/** whole percent-with-two-decimals of part over whole, in integer arithmetic; null when whole is not positive */
function pct(part, whole) {
  if (whole <= 0n) return null;
  return Number((part * 10000n) / whole) / 100;
}

/** true when `part` is at least OUTFLOW_FRACTION of `whole` */
const isLargeShare = (part, whole) => whole > 0n && part * 10000n >= whole * OUTFLOW_FRACTION_BPS;

module.exports = { IDS, RANK, warning, sortWarnings, fmtUnits, pct, isLargeShare, SOL_OUTFLOW_FLOOR_LAMPORTS, ETH_OUTFLOW_FLOOR_WEI, UNLIMITED_U64, UNLIMITED_EVM, OUTFLOW_FRACTION_BPS };

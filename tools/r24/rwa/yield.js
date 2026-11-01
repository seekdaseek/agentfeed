// tools/r24/rwa/yield.js: the arithmetic of get_rwa_yields. Prices are integers (the contract's raw value) so nothing is lost before the ratio is taken.
//   simple  (P_t / P_t-N - 1) x 365 / N          N = the days between the two block times (7 or 30, plus the few hours the 6-hour anchor adds)
//   apy     (P_t / P_t-N) ^ (365 / N) - 1
// Results are percent per year. A price that is not a positive integer, or a window that is not a positive number of days, gives null: the caller treats null as a failed read.
'use strict';

const DAY = 86400;

/** raw integer ratio a / b as a Number, with 18 digits of precision, or null */
function ratio(a, b) {
  if (typeof a !== 'bigint' || typeof b !== 'bigint' || a <= 0n || b <= 0n) return null;
  const r = Number((a * 10n ** 18n) / b) / 1e18;
  return Number.isFinite(r) && r > 0 ? r : null;
}

/** percent per year, or null */
function annualized(convention, newer, older, days) {
  const r = ratio(newer, older);
  if (r == null || !Number.isFinite(days) || days <= 0) return null;
  let y;
  if (convention === 'simple') y = (r - 1) * (365 / days);
  else if (convention === 'apy') y = Math.pow(r, 365 / days) - 1;
  else return null;
  return Number.isFinite(y) ? y * 100 : null;
}

/** raw integer -> a decimal Number of tokens' price (raw / 10^decimals) */
function toNumber(raw, decimals) {
  if (typeof raw !== 'bigint' || raw <= 0n) return null;
  const whole = raw / 10n ** BigInt(decimals); const frac = raw % 10n ** BigInt(decimals);
  const n = Number(whole) + Number(frac) / 10 ** decimals;
  return Number.isFinite(n) ? n : null;
}

const round = (x, d) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const days = (ts1, ts0) => (ts1 - ts0) / DAY;

module.exports = { ratio, annualized, toNumber, round, days, DAY };

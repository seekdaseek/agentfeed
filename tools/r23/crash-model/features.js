// tools/r23/crash-model/features.js: the feature vector of the crash-risk score, built from ONE row of LaunchLedger's `pools` table.
// It reproduces /Volumes/D/launchledger-backtest/03_dataset.py (the Phase 0b dataset builder) column by column, in the model's own feature order, in float64.
// Inputs are the frozen t0 columns only (t0_liquidity_usd, t0_volume24h_usd, t0_price_usd, t0_fdv_usd, t0_txns24h, t0_ts, pool_created_ts) and the pool's
// name, dex, quote_mint and cohort_reason. Nothing read here can change after the pool joins the cohort (see ledger-score/README.md).
// A NULL or non-numeric column becomes NaN, exactly as pandas reads a NULL; the model routes NaN with the direction it learned (missing_go_to_left).
'use strict';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** the raw pools columns a feature vector reads (a reader selects these by name, so extra columns in the live table are harmless) */
const INPUT_COLUMNS = ['id', 'pool_address', 'base_mint', 'quote_mint', 'name', 'dex', 'pool_created_ts', 't0_liquidity_usd', 't0_volume24h_usd', 't0_price_usd', 't0_fdv_usd', 't0_txns24h', 't0_ts', 'cohort_reason'];

const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));
const clip = (x, lo, hi) => (x !== x ? NaN : Math.min(Math.max(x, lo), hi));   // pandas clip: NaN stays NaN
const log1p = (x) => (x !== x ? NaN : Math.log1p(x));
// pandas: np.log1p(num / den.where(den > 0)).clip(0, 1e4)
const lr = (n, d) => (d > 0 ? log1p(clip(n / d, 0, 1e4)) : NaN);

// Python's re `\s` and str.isspace() for a str: [\t\n\v\f\r], the four separators U+001C..U+001F, space, U+0085, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000.
// (JavaScript's \s differs: it adds U+FEFF and lacks U+001C..U+001F and U+0085, so it is not used.)
const isPySpace = (c) => (c >= 9 && c <= 13) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
const ND = /\p{Nd}/gu;            // Python's \d on a str: Unicode category Nd
const ND_START = /^\p{Nd}/u;
const isAsciiAlnum = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** the name features of one pool name (pandas: base = name.fillna("").str.split(" / ").str[0]); all lengths count code points like Python's len */
function nameFeatures(name) {
  const full = name === null || name === undefined ? '' : String(name);
  const base = full.split(' / ')[0];
  let len = 0, upper = 0, lower = 0, nonascii = 0, space = 0, punct = 0, hasUpper = false;
  for (const ch of base) {
    const c = ch.codePointAt(0);
    len++;
    if (c >= 65 && c <= 90) { upper++; hasUpper = true; }
    else if (c >= 97 && c <= 122) lower++;
    if (c > 127) nonascii++;
    if (isPySpace(c)) space++;
    if (c < 128 && !isAsciiAlnum(c) && !isPySpace(c)) punct++;
  }
  const digits = (base.match(ND) || []).length;
  let pairLen = 0; for (let i = 0; i < full.length; i++) { const c = full.charCodeAt(i); if (!(c >= 0xdc00 && c <= 0xdfff && i > 0 && full.charCodeAt(i - 1) >= 0xd800 && full.charCodeAt(i - 1) <= 0xdbff)) pairLen++; }   // code points, like Python's len
  return { name_len: len, name_digits: digits, name_upper: upper, name_lower: lower, name_nonascii: nonascii, name_space: space, name_punct: punct,
    name_allcaps: len > 0 && base === base.toUpperCase() && hasUpper ? 1 : 0, name_startdigit: ND_START.test(base) ? 1 : 0, pair_name_len: pairLen };
}

/**
 * The model's categories, as frozen in model.json: { dex_cats: [...], quote_cats: {mint: 'SOL'|'USDC'}, top_quote_other: [...mints], reasons: [...] }, and its tables: { hour_sin: [24], hour_cos: [24] }.
 * -> the function that turns a pools row into a Float64Array in `featureNames` order.
 */
function makeFeatureBuilder(featureNames, categories, tables) {
  // hour_sin and hour_cos come from a table of the 24 values numpy produced in the training script: hours h and 24-h are equal in exact arithmetic, numpy rounds them to
  // neighbouring doubles, the trees split between those neighbours, and Math.sin/Math.cos round some of them differently (found by the parity check: 1.8% of pools moved by up to 0.04)
  if (!tables || !Array.isArray(tables.hour_sin) || tables.hour_sin.length !== 24 || !Array.isArray(tables.hour_cos) || tables.hour_cos.length !== 24) throw new Error('crash-model: the model file has no 24-value hour_sin / hour_cos tables');
  const dexCats = categories.dex_cats, topQ = categories.top_quote_other, reasons = categories.reasons;
  const quoteName = categories.quote_cats || { [SOL]: 'SOL', [USDC]: 'USDC' };
  const n = featureNames.length;
  return function featuresFromPool(row) {
    const liq = num(row.t0_liquidity_usd), vol = num(row.t0_volume24h_usd), price = num(row.t0_price_usd), fdv = num(row.t0_fdv_usd), tx = num(row.t0_txns24h);
    const t0 = num(row.t0_ts), created = num(row.pool_created_ts);
    const ageH = (t0 - created) / 3600.0;
    const hour = Math.floor((((t0 % 86400) + 86400) % 86400) / 3600);
    const wday = (((Math.floor(t0 / 86400) + 3) % 7) + 7) % 7;      // 1970-01-01 was a Thursday; pandas day_of_week has Monday = 0
    const nm = nameFeatures(row.name);
    const dex = row.dex === undefined ? null : row.dex, quote = row.quote_mint === undefined ? null : row.quote_mint, reason = row.cohort_reason === undefined ? null : row.cohort_reason;
    const q = Object.prototype.hasOwnProperty.call(quoteName, quote) ? quoteName[quote] : null;
    const fixed = {
      log_liq: log1p(clip(liq, 0, Infinity)), log_vol: log1p(clip(vol, 0, Infinity)), log10_price: price > 0 ? Math.log10(price) : NaN, log_fdv: log1p(clip(fdv, 0, Infinity)), log_txns: log1p(clip(tx, 0, Infinity)),
      liq_na: liq !== liq ? 1 : 0, fdv_na: fdv !== fdv ? 1 : 0,
      age_h_clip: clip(ageH, -1, 24 * 30), log_age: log1p(clip(ageH, 0, Infinity)),
      hour, wday, hour_sin: tables.hour_sin[hour], hour_cos: tables.hour_cos[hour],
      liq_over_fdv: lr(liq, fdv), vol_over_liq: lr(vol, liq), txns_over_liq: lr(tx, liq),
      ...nm,
      dex_other: dexCats.includes(dex) ? 0 : 1, q_SOL: q === 'SOL' ? 1 : 0, q_USDC: q === 'USDC' ? 1 : 0,
      q_other: q === null && !topQ.includes(quote) ? 1 : 0, reason_other: reasons.includes(reason) ? 0 : 1,
    };
    for (let k = 0; k < 7; k++) fixed[`wd${k}`] = wday === k ? 1 : 0;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const name = featureNames[i];
      let v = fixed[name];
      if (!(name in fixed)) {
        if (name.startsWith('dex_')) v = dex === name.slice(4) ? 1 : 0;
        else if (name.startsWith('q_')) v = quote !== null && topQ.some((m) => m.slice(0, 6) === name.slice(2) && m === quote) ? 1 : 0;
        else if (name.startsWith('reason_')) v = reason === name.slice(7) ? 1 : 0;
        else throw new Error(`crash-model: the feature builder has no rule for feature ${name}`);
      }
      out[i] = v;
    }
    return out;
  };
}

const builders = new WeakMap();
/** featuresFromPool(row, ctx): ctx is a loaded model ({ feature_names, categories, tables }); the builder for a ctx is made once */
function featuresFromPool(row, ctx) {
  let b = builders.get(ctx);
  if (!b) { b = makeFeatureBuilder(ctx.feature_names, ctx.categories, ctx.tables); builders.set(ctx, b); }
  return b(row);
}

module.exports = { featuresFromPool, makeFeatureBuilder, nameFeatures, INPUT_COLUMNS, isPySpace };

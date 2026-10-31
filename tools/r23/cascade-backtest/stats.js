// tools/r23/cascade-backtest/stats.js: the seeded random generator, summary statistics, the percentile bootstrap and the baseline draw. Pure functions, no I/O.
// The generator is mulberry32 (a 32-bit integer generator, public domain): ~10 lines, and trivial to reproduce in another language, which is how the offline recompute
// (a Python script written from the csv, not from this file) checks the bootstrap interval and the baseline draw to the last digit.
'use strict';
const C = require('./config');

/** mulberry32: -> () => float in [0, 1) with 32 bits of resolution (the division by 2^32 is exact) */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function medianOf(sorted) {
  const k = sorted.length;
  return k % 2 ? sorted[(k - 1) / 2] : (sorted[k / 2 - 1] + sorted[k / 2]) / 2;
}

/**
 * Percentile bootstrap of the mean: B resamples of size n with replacement (index = floor(u * n), one draw per element, in order), the mean of each, sorted;
 * the interval is the elements at lo = round(alpha/2 * B) and B - 1 - lo (50 and 1949 for B = 2000, alpha = 0.05). Integers, not floor/ceil of a float product, which is one off at 0.975 * 2000.
 */
function bootstrapMeanInterval(values, seed, B = C.BOOTSTRAP_B, level = C.CI_LEVEL) {
  const n = values.length;
  const means = new Float64Array(B);
  // mulberry32 written out inline (the same sequence as mulberry32(seed): a test compares them): a call per draw returned a boxed double each time, 2,000 x n x 8 of them per request
  let a = seed >>> 0;
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      s += values[Math.floor(((t ^ (t >>> 14)) >>> 0) / 4294967296 * n)];
    }
    means[b] = s / n;
  }
  means.sort();
  const lo = Math.round(((1 - level) / 2) * B);
  return [means[lo], means[B - 1 - lo]];
}

/**
 * Summary of forward returns (fractions): n, mean, median, hit rate (share with a return above zero) and the bootstrap interval of the mean.
 * Fewer than MIN_N_FOR_INTERVAL observations: the interval is null (a bootstrap of 4 numbers is not an interval worth printing); none: every field is null.
 */
function summarize(returns, seed) {
  const n = returns.length;
  if (!n) return { n: 0, mean: null, median: null, hit_rate: null, ci: null };
  let sum = 0, hits = 0;
  for (let i = 0; i < n; i++) { sum += returns[i]; if (returns[i] > 0) hits++; }
  const sorted = Float64Array.from(returns).sort();
  return {
    n, mean: sum / n, median: medianOf(sorted), hit_rate: hits / n,
    ci: n >= C.MIN_N_FOR_INTERVAL ? bootstrapMeanInterval(Float64Array.from(returns), seed) : null,
  };
}

/** merge [a, b] intervals (inclusive, any order) into a sorted disjoint list */
function mergeIntervals(iv) {
  const s = iv.map((x) => [x[0], x[1]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) { if (x[1] > last[1]) last[1] = x[1]; } else out.push(x);
  }
  return out;
}

/** is t inside any interval of a merged sorted list? (binary search) */
function inside(merged, t) {
  let lo = 0, hi = merged.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < merged[mid][0]) hi = mid - 1;
    else if (t > merged[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * The baseline: `count` distinct grid times drawn uniformly at random (seeded) from the grid points firstIdx..lastIdx (grid time = idx * stepMs) that lie outside every
 * excluded interval. One generator draw per attempt, accepted or not; at most count * ATTEMPTS + 10000 attempts, so a period that is almost all event window returns fewer
 * than `count` times and says so (the caller reports times.length).
 */
function drawBaselineTimes({ count, firstIdx, lastIdx, stepMs, excluded, seed = C.SEED_BASELINE }) {
  const M = lastIdx - firstIdx + 1;
  const out = [];
  if (count <= 0 || M <= 0) return out;
  const rng = mulberry32(seed);
  const seen = new Set();
  const merged = mergeIntervals(excluded);
  const maxAttempts = count * C.BASELINE_ATTEMPTS_PER_TIME + 10000;
  for (let a = 0; a < maxAttempts && out.length < count; a++) {
    const idx = firstIdx + Math.floor(rng() * M);
    if (seen.has(idx)) continue;
    const t = idx * stepMs;
    if (inside(merged, t)) continue;
    seen.add(idx);
    out.push(t);
  }
  return out;
}

module.exports = { mulberry32, medianOf, bootstrapMeanInterval, summarize, mergeIntervals, inside, drawBaselineTimes };

// tools/r23/crash-model/metrics.js: the three small calculations the crash-risk score is judged by: ROC AUC (the rank-sum formula, ties get their average rank),
// a decile from cut points, and cut points from a list of scores. Pure functions, no I/O.
'use strict';

/**
 * ROC AUC of `scores` against 0/1 `labels`: the probability that a random positive outranks a random negative, ties counting half.
 * -> null when there is no positive or no negative (an AUC does not exist then).
 */
function rocAuc(scores, labels) {
  const n = scores.length;
  if (n !== labels.length) throw new Error('rocAuc: scores and labels differ in length');
  let pos = 0;
  for (let i = 0; i < n; i++) if (labels[i]) pos++;
  const neg = n - pos;
  if (pos === 0 || neg === 0) return null;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => scores[a] - scores[b] || a - b);
  let rankSumPos = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;               // ranks are 1-based; a tie group shares the mean of its ranks
    for (let k = i; k <= j; k++) if (labels[idx[k]]) rankSumPos += avg;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** decile 1..10 of a score: 1 + the number of cut points at or below it (cuts are the nine boundaries, ascending) */
function decileOf(score, cuts) {
  let lo = 0, hi = cuts.length;                // number of cuts <= score, by bisection
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cuts[mid] <= score) lo = mid + 1; else hi = mid; }
  return lo + 1;
}

/** the nine decile boundaries of a list of scores, linear interpolation between order statistics (numpy.quantile's default) */
function decileCuts(scores) {
  const v = Float64Array.from(scores).sort();
  const n = v.length;
  if (n < 10) return null;
  const cuts = [];
  for (let q = 1; q <= 9; q++) {
    const pos = (q / 10) * (n - 1), lo = Math.floor(pos), hi = Math.min(lo + 1, n - 1), t = pos - lo;
    cuts.push(t === 0 ? v[lo] : (t >= 0.5 ? v[hi] - (v[hi] - v[lo]) * (1 - t) : v[lo] + (v[hi] - v[lo]) * t));
  }
  return cuts;
}

module.exports = { rocAuc, decileOf, decileCuts };

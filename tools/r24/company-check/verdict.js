// tools/r24/company-check/verdict.js: the one verdict line of company-check (R24 item 5), built from templates over the flags. No model, no free text from a filing, no judgment word
// ("safe", "buy", "sell", "risky") and no prediction: the line says what was found in the documents read, and the facts behind it sit next to it with their sources.
//   "Going-concern language in the latest 10-K; delisting notice 8-K (Item 3.01) on 2026-03-14; filings current."
//   "No going-concern language and no delisting notice found in the filings read; filings current."
// The same inputs always give the same line; the test suite derives the expected line from the flags with an independent function.
'use strict';

const joinForms = (f) => (f.length === 2 ? `${f[0]} and ${f[1]}` : f[0]);

/**
 * @param {{ going_concern: (boolean|null), gc_forms: string[], gc_read: string[], alleviation: boolean,
 *           delisting: (boolean|null), delisting_date: (string|null), delisting_count: number,
 *           stale: (boolean|null), expected_period_end?: string, due_date?: string }} f
 */
function verdictLine(f) {
  const gc = f.going_concern; const de = f.delisting;
  const parts = [];
  if (gc === false && de === false) parts.push('No going-concern language and no delisting notice found in the filings read');
  else {
    if (gc === true) parts.push(`Going-concern language in the latest ${joinForms(f.gc_forms)}${f.alleviation ? ' (the document also says management\'s plans alleviate the doubt)' : ''}`);
    else if (gc === false) parts.push(`No going-concern language in the ${joinForms(f.gc_read)} read`);
    else parts.push('Going-concern language could not be checked');
    if (de === true) parts.push(`delisting notice 8-K (Item 3.01) on ${f.delisting_date}${f.delisting_count > 1 ? ` (${f.delisting_count} in the last 24 months)` : ''}`);
    else if (de === false) parts.push('no delisting notice 8-K (Item 3.01) in the last 24 months');
    else parts.push('Item 3.01 delisting notices could not be checked for the full 24 months');
  }
  if (f.stale === true) parts.push(`latest periodic report overdue (period ending ${f.expected_period_end}, due ${f.due_date})`);
  else if (f.stale === false) parts.push('filings current');
  else parts.push('filing currency not determined');
  const s = parts.join('; ');
  return `${s}.`;
}

module.exports = { verdictLine, joinForms };

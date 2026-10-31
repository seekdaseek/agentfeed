// tools/r23/claim-check/answer.js: the answer of claim-check, built from the model's proposal and the prepared sources (R23 T4). Pure: no network, no model, no clock.
// This is where the verdict is decided: a quote ships only if text.js verifyQuotes finds it word for word in a fetched source, and a verdict ships only with such a quote
// (INSUFFICIENT excepted). The functions of text.js are looked up on its module object at call time so a test can remove one check and show the same proposal would then ship.
'use strict';
const T = require('./text');
const S = require('./sources');
const WIKI_LICENSE = require('../../wiki').LICENSE;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const KIND_WORDS = { 'sec-filing': 'SEC filing', wikipedia: 'Wikipedia article', web: 'web page' };

function methodOf(prepared, failedCount, dropped, redacted) {
  const kinds = {}; for (const s of prepared) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  const list = Object.entries(kinds).map(([k, n]) => plural(n, KIND_WORDS[k])).join(', ');
  const cut = prepared.filter((s) => s.truncated);
  return [
    `Read ${plural(prepared.length, 'source')} (${list}).`,
    cut.length ? `${plural(cut.length, 'source')} too long to show whole: the passages sharing the most words and figures with the claim were shown, the rest was not read (chars_read against chars_total).` : 'Each source was shown whole.',
    redacted ? `${plural(redacted, 'line')} that read as an instruction to an AI model ${redacted === 1 ? 'was' : 'were'} removed before the model saw the text.` : null,
    `One language model call proposed a verdict and up to ${T.MAX_QUOTES} quotes. A verdict is kept only if at least one quote is found word for word (whitespace aside) in the fetched text; every other quote is dropped, and SUPPORTED also needs each figure of the claim in the kept quotes.`,
    dropped ? `${plural(dropped, 'proposed quote')} did not pass and ${dropped === 1 ? 'was' : 'were'} dropped.` : null,
    failedCount ? `${plural(failedCount, 'source')} could not be read (sources_failed); a source that is missing is not evidence either way.` : 'A source that cannot be read is not evidence either way.',
    kinds.wikipedia ? `Wikipedia text is available under ${WIKI_LICENSE.license} (${WIKI_LICENSE.license_url}); its authors are listed in each article's history, and text reused from here stays under the same licence.` : null,
    kinds['sec-filing'] ? 'Filing text is read from the public filings at sec.gov.' : null,
    kinds.web || kinds['sec-filing'] ? 'Page and filing text is fetched on your request and kept only in a short-lived cache of fetched text; it belongs to its publisher.' : null,
    'This reports what the sources say; it is not a probability and not advice.',
  ].filter(Boolean).join(' ');
}

const NOTE = {
  SUPPORTED: (q, s) => `The sources state this: ${plural(q, 'quote')} from ${plural(s, 'source')} found word for word in the fetched text. It reports what the sources say, not that they are right.`,
  CONTRADICTED: (q, s) => `The sources state something different: ${plural(q, 'quote')} from ${plural(s, 'source')} found word for word in the fetched text. It reports what the sources say, not that they are right.`,
  model: 'The sources read do not settle this claim.',
  noquote: (v) => `The model proposed ${v} but no proposed quote could be found word for word in the fetched text, so no verdict is given.`,
  figure: (v, f) => `The model proposed ${v}, but the figure ${f} in the claim is not in the verified quotes, so no verdict is given.`,
};

/**
 * Pure: the model's proposal + the prepared sources -> the answer. prepared: [{ index, url, final_url, kind, format, chars_total, chars_read, truncated, redacted, norm }].
 * The module-level functions are looked up at call time so a test can remove a check and show the same proposal would then ship.
 */
function assemble({ claim, parsed, prepared, failed, model, redacted = 0 }) {
  const v = T.verifyQuotes(parsed.quotes, prepared, claim);
  let verdict = 'INSUFFICIENT'; let note = NOTE.model; let quotes = [];
  if (parsed.verdict !== 'INSUFFICIENT') {
    if (!v.kept.length) note = NOTE.noquote(parsed.verdict);
    else {
      const gap = parsed.verdict === 'SUPPORTED' ? T.missingFigure(claim, v.kept) : null;
      if (gap) note = NOTE.figure(parsed.verdict, gap);
      else {
        verdict = parsed.verdict; quotes = v.kept;
        note = NOTE[verdict](quotes.length, new Set(quotes.map((q) => q.source.index)).size);
      }
    }
  }
  return {
    claim,
    verdict,
    confidence_note: note,
    quotes: quotes.map((q) => ({ text: q.text, url: q.source.final_url || q.source.url, source_kind: q.source.kind, locator: q.locator })),
    sources_read: prepared.map((s) => ({ url: s.url, ...(s.final_url && s.final_url !== s.url ? { final_url: s.final_url } : {}), kind: s.kind, format: s.format, ...(s.title ? { title: s.title } : {}), chars_total: s.chars_total, chars_read: s.chars_read, truncated: s.truncated })),
    sources_failed: failed.map(S.publicFailure),
    model,
    method: methodOf(prepared, failed.length, v.dropped.length, redacted),
  };
}


module.exports = { assemble, methodOf, NOTE, plural };

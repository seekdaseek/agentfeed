// tools/r24/company-check/going-concern.js: the going-concern phrase test of company-check (R24 item 5). Pure, deterministic, no network, no clock, no model.
//
// WHAT IS TESTED. In the visible text of a filing (tools/r23/claim-check/text.js htmlToText: one line per paragraph or table row), find every "substantial doubt" that has "going concern"
// within 400 characters in the same line. Each such place is a MENTION, and the sentence it sits in is judged by the rules below. A mention is AFFIRMATIVE when the sentence says the doubt
// exists ("These conditions raise substantial doubt about the Company's ability to continue as a going concern", "there is substantial doubt", "our auditors have expressed substantial doubt").
// It is NON-ASSERTING when the same words are used to deny it, to hedge it, or to describe the rule: "no substantial doubt", "did not identify conditions that raise substantial doubt",
// "if ... could raise substantial doubt", "whether there are conditions that raise substantial doubt" (the accounting standard), "substantial doubt ... was alleviated".
// The flag `found` is true when at least one mention is affirmative. The first affirmative sentence is quoted word for word (a substring of the text that was read).
//
// WHY THE EXTRA RULES. "substantial doubt" next to "going concern" is printed in the filings of healthy companies too, in a negation, a risk-factor hypothetical or a description of the
// standard. A bare phrase match would call them distressed. The rules are lists of words and are meant to be read: each is one regular expression below, with a reason, and every one
// has a known-positive and a known-negative sentence in test/r24-company-check-going-concern.test.js, and a mutation check that removing the rule changes the result.
//
// LIMITS (stated in the answer's `method`): the primary document of the filing is read, so language that sits only in an exhibit (an annual report attached as Exhibit 13) is not;
// a sentence that asserts the doubt in words none of the rules recognise is missed (found false); a sentence that is hedged in words the rules do not list is called affirmative.
'use strict';

const DOUBT = /substantial[\s ]+doubt/gi;
const GOING = /going[\s -]+concern/i;
const NEAR = 400;               // characters between the two phrases at most
const MAX_QUOTE = 600;
const MAX_SENTENCE = 1200;
const KEEP_AFFIRMATIVE = 3;
const MAX_LINE = 8000;                                         // a merged paragraph is cut off at this many characters
const ENDS_SENTENCE = /[.!?:;]["'”’)\]]*$/;

// sentence ends: . ! ? followed by space and a capital, quote, bracket or digit, unless the word before the dot is an abbreviation
const ABBREV = new Set(['inc', 'corp', 'co', 'ltd', 'no', 'nos', 'vs', 'etc', 'mr', 'ms', 'mrs', 'dr', 'st', 'jr', 'sr', 'fig', 'approx', 'u.s', 'e.g', 'i.e', 'al', 'cf', 'sec', 'ph', 'd', 'v']);
const AFTER_END = /^["'”’)\]]*\s+["'“‘(\[]*[A-Z0-9]/;
function isBoundary(line, i) {                    // line[i] is '.', '!' or '?'
  if (!AFTER_END.test(line.slice(i + 1, i + 12))) return false;
  if (line[i] !== '.') return true;
  const m = /([A-Za-z.]{1,6})$/.exec(line.slice(Math.max(0, i - 7), i));
  return !(m && ABBREV.has(m[1].toLowerCase()));
}
function sentenceStart(line, i) {                 // the start of the sentence that contains position i
  for (let k = i - 1; k > 0 && i - k < MAX_SENTENCE; k--) {
    const c = line[k];
    if ((c === '.' || c === '!' || c === '?') && isBoundary(line, k)) { let s = k + 1; while (s < line.length && /[\s"'”’)\]]/.test(line[s])) s++; return s; }
  }
  return Math.max(0, i - MAX_SENTENCE);
}
function sentenceEnd(line, i) {                   // just after the last character of the sentence that contains position i
  for (let k = i; k < line.length && k - i < MAX_SENTENCE; k++) {
    const c = line[k];
    if ((c === '.' || c === '!' || c === '?') && isBoundary(line, k)) { let e = k + 1; while (e < line.length && /["'”’)\]]/.test(line[e])) e++; return e; }
  }
  return Math.min(line.length, i + MAX_SENTENCE);
}

// ---- the rules that make a mention non-asserting (applied to the lower-cased sentence; `pre` is what precedes "substantial doubt", `post` what follows it) -----------------------
const NEG_NO = /\bno\s+(?:longer\s+)?(?:[a-z']+\s+){0,2}$/;                                            // "there is no substantial doubt", "no longer any substantial doubt"
const NEG_VERB = /\b(?:not|n't|never|neither|nor|cannot|without)\s+(?:(?![a-z']*(?:ed|ing)\b)[a-z',]+\s+){0,3}(?:raise|raises|raised|raising|cast|casts|create|creates|created|give|gives|gave|indicate|indicates|indicated|exist|exists|existed|result|results|lead|leads|cause|causes|express|expressed|present|presents)\s+(?:rise\s+to\s+)?(?:(?:a|an|any|the|some|significant|serious|real|further|such)\s+){0,2}$/; // "do not raise substantial doubt"
const NEG_FOUND = /\b(?:not|n't|never|without)\s+(?:[a-z',]+\s+){0,2}(?:identif|conclud|determin|believ|expect|anticipat|aware|find\b|found\b|conclusion)/; // "did not identify any conditions that raise ...", "do not believe there is ..."
const NEG_NONE = /\b(?:no|none of the)\s+(?:[a-z',]+\s+){0,7}?(?:identified|determined|concluded|noted|present|existed)\b/;     // "no conditions or events were identified that raise ..."
const POST_NEG = /^[^.;]{0,100}?\b(?:(?:does|do|did|is|are|was|were|has|have|had)\s+not\s+(?:[a-z']+\s+){0,2}(?:exist|exists|existed|present|remain|remains|arise|arisen|apparent)|no longer)\b/;                       // "substantial doubt does not exist"
const POST_RESOLVED = /^[^.;]{0,100}?\b(?:(?:has|have|had)\s+been|(?:was|were|is|are))\s+(?:alleviated|eliminated|removed|resolved|dispelled|overcome)\b/;                                                       // "... has been alleviated"
const RESOLVE = /\b(?:alleviat|eliminat|dispel|overcom|overcame|resolv|mitigat|remov|relieve|negate|negating)[a-z]*\s+(?:(?:the|this|such|any|that|our|its|a|an)\s+)*(?:[a-z']+\s+)?$/;       // "plans to alleviate substantial doubt", read at the end of what precedes the phrase (not "negative cash flows", not "eliminate new products")
const NOT_BEFORE_RESOLVE = /\b(?:not|n't|never|unable|insufficient|fail|fails|failed|cannot|unlikely)\b[^.;]{0,40}$/;  // "do not alleviate", "may not be sufficient to alleviate": the doubt stays
const NOT_ALLEVIATED = /\b(?:do|does|did|will|would|have|has|had|are|is)\s+not\s+(?:[a-z']+\s+){0,2}(?:alleviate|eliminate|dispel|overcome|mitigate|resolve|remove)\s+(?:the\s+|such\s+|this\s+)?$/;     // "plans do not alleviate substantial doubt": the doubt stands, so it is affirmative whatever else the clause says
const MODAL = /\b(?:may|might|could|would|should|can|cannot|were to)\b/;                                        // read only in the last clause before the phrase: "our auditors may express substantial doubt"
const COND_FIRST = /^\s*(?:and\s+|but\s+|or\s+|also\s+)?(?:if|unless|in the event|assuming|provided that)\b/;     // the last clause opens with a condition: "if there remains substantial doubt about ..."
const GENERIC = /\b(?:often|typically|frequently|commonly|generally|warnings)\b/;                                // describes companies in general, not this one
const WHETHER = /\bwhether\b/;                                                                        // "evaluate whether there are conditions or events that raise ...": the standard's own wording
const FUTURE = /\b(?:future|further|potential|possible)\s+$/;                                               // "any future substantial doubt"
const DEFINITION = /^[^.]{0,60}?\bexists?\s+(?:when|if|where|whenever)\b/;                                 // "Substantial doubt exists when conditions and events ... indicate ..."
const LEAD_IF = /^\W*(?:if|unless|should|in the event|even if|whether|assuming)\b/;                          // a sentence that opens with a condition
const HEADING = /^\W*Substantial Doubt\b/;                                                              // a Title Case heading ("Substantial Doubt about the Company's Ability to Continue as a Going Concern") says nothing

/** -> { asserts: boolean, why: string } for one sentence and the index of "substantial doubt" in it. The first rule that fits decides. */
function classify(sentence, at) {
  const s = sentence.toLowerCase().replace(/[’‘]/g, "'");
  const pre = s.slice(0, at); const post = s.slice(at + 16);
  if (HEADING.test(sentence.slice(at))) return { asserts: false, why: 'heading: a title, not a statement' };
  if (NEG_NO.test(pre)) return { asserts: false, why: 'negated: "no ... substantial doubt"' };
  if (NEG_VERB.test(pre)) return { asserts: false, why: 'negated: "not raise/exist ... substantial doubt"' };
  if (NEG_FOUND.test(pre)) return { asserts: false, why: 'negated: "did not identify / do not believe ..."' };
  if (NEG_NONE.test(pre)) return { asserts: false, why: 'negated: "no conditions or events were identified"' };
  if (POST_NEG.test(post)) return { asserts: false, why: 'negated after the phrase: "does not exist", "no longer"' };
  if (POST_RESOLVED.test(post)) return { asserts: false, why: 'resolved: the doubt "has been alleviated"' };
  if (NOT_ALLEVIATED.test(pre)) return { asserts: true, why: 'affirmative: "plans do not alleviate" the doubt' };
  { const m = RESOLVE.exec(pre); if (m && !NOT_BEFORE_RESOLVE.test(pre.slice(Math.max(0, m.index - 60), m.index))) return { asserts: false, why: 'resolved: alleviated, eliminated, removed or overcome' }; }
  if (FUTURE.test(pre)) return { asserts: false, why: 'hypothetical: "any future / potential substantial doubt"' };
  if (DEFINITION.test(post)) return { asserts: false, why: 'definition: "substantial doubt exists when ..."' };
  if (LEAD_IF.test(s)) return { asserts: false, why: 'conditional: the sentence opens with if / whether / unless' };
  if (WHETHER.test(pre)) return { asserts: false, why: 'asks whether: "evaluate whether there are conditions that raise ..."' };   // the standard's own wording; the clause may be far from the phrase
  const clause = pre.split(/[,;:()\u2014]/).pop();                         // the last clause before the phrase
  if (MODAL.test(clause)) return { asserts: false, why: 'hedged: may / might / could / would / should before the phrase' };
  if (COND_FIRST.test(clause)) return { asserts: false, why: 'conditional: the clause opens with if / unless' };
  if (GENERIC.test(clause)) return { asserts: false, why: 'generic: describes companies in general' };
  return { asserts: true, why: 'affirmative' };
}

const squash = (x) => x.replace(/[\s ]+/g, ' ').trim();
function quoteOf(line, a, b, at) {
  let from = a; let to = b;
  if (to - from > MAX_QUOTE) {
    from = Math.max(a, at - Math.floor(MAX_QUOTE / 2)); to = Math.min(b, from + MAX_QUOTE);
    const sp = line.indexOf(' ', from); if (from > a && sp >= 0 && sp < at) from = sp + 1;
    const ep = line.lastIndexOf(' ', to); if (to < b && ep > at) to = ep;
  }
  return line.slice(from, to).trim();
}

/**
 * The analyser, fed one line of visible text at a time (a stream: nothing but the paragraph being read is held). A line that does not end a sentence and is followed by a line that starts in
 * lower case is one paragraph (the page layout cut it); each paragraph is judged when the next one starts, or at finish().
 * @param {{trace?: object[]}} [opts]  `trace` receives every mention judged (tests and development only)
 */
function makeAnalyser(opts = {}) {
  let mentions = 0; let affirmative = 0; let nonAsserting = 0; let alleviation = 0; let quote = null; let truncated = false; let example = null;
  let kept = 0; let para = '';
  function judge(line) {
    if (line.length < 16) return;
    DOUBT.lastIndex = 0;
    let m;
    let lastEnd = -1;
    while ((m = DOUBT.exec(line)) !== null) {
      const p = m.index;
      const lo = Math.max(0, p - NEAR); const hi = Math.min(line.length, p + 16 + NEAR);
      if (!GOING.test(line.slice(lo, hi))) continue;
      if (p < lastEnd) continue;                                          // already inside a sentence that was judged
      const a = sentenceStart(line, p); const b = sentenceEnd(line, p + 16);
      lastEnd = b;
      const sentence = line.slice(a, b);
      mentions++;
      const c = classify(sentence, p - a);
      if (opts.trace) opts.trace.push({ asserts: c.asserts, why: c.why, sentence });
      if (c.asserts) {
        affirmative++;
        if (kept < KEEP_AFFIRMATIVE) { const q = quoteOf(line, a, b, p); kept++; if (quote === null) { quote = q; truncated = b - a > MAX_QUOTE; } }
      } else {
        nonAsserting++;
        if (c.why.startsWith('resolved')) alleviation++;
        if (example === null) example = { quote: quoteOf(line, a, b, p), why: c.why };
      }
    }
  }
  return {
    /** one line of visible text (no newline inside; empty lines are ignored) */
    line(l) {
      if (!l) return;
      if (para !== '' && para.length < MAX_LINE && !ENDS_SENTENCE.test(para.slice(-3)) && /[a-z]/.test(l[0])) { para += ` ${l}`; return; }
      if (para !== '') judge(para);
      para = l;
    },
    finish() {
      if (para !== '') judge(para);
      para = '';
      return { found: affirmative > 0, mentions, affirmative, non_asserting: nonAsserting, alleviation, quote: quote === null ? null : squash(quote), quote_truncated: truncated, non_asserting_example: example && { quote: squash(example.quote), why: example.why } };
    },
  };
}

/**
 * @param {string} text  the visible text of one filing (lines separated by \n)
 * @param {{trace?: object[]}} [opts]
 * @returns {{ found: boolean, mentions: number, affirmative: number, non_asserting: number, alleviation: number (non-asserting mentions that say the doubt is or was alleviated), quote: (string|null), quote_truncated: boolean, non_asserting_example: ({quote: string, why: string}|null) }}
 */
function analyse(text, opts = {}) {
  const a = makeAnalyser(opts);
  let pos = 0; const n = text.length;
  while (pos < n) {
    let eol = text.indexOf('\n', pos); if (eol < 0) eol = n;
    a.line(text.slice(pos, eol));
    pos = eol + 1;
  }
  return a.finish();
}

module.exports = { analyse, makeAnalyser, classify, sentenceStart, sentenceEnd, NEAR, MAX_QUOTE };

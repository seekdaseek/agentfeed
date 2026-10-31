// test/fixtures/r23/claimcheck/stub-model.js: a STAND-IN for the Gemini API, for tests and for smoke runs of the pipeline. It is not a language model and its answers say nothing
// about how the real model does (that is the live gate). It reads the prompt claim-check builds (claim and numbered sources between the data delimiters), picks the sentence with
// the most words in common with the claim, and answers by comparing figures. Responses have the shape of the REST API (candidates[0].content.parts[0].text holding JSON, usageMetadata).
'use strict';
const T = require('../../../../tools/r23/claim-check/text');
const G = require('../../../../tools/llm/gemini');

const BEGIN = G.BEGIN; const END = G.END;
function parsePrompt(body) {
  const text = body.contents[0].parts.map((p) => p.text).join('\n');
  const block = (after) => { const i = text.indexOf(after); const a = text.indexOf(BEGIN, i) + BEGIN.length; const b = text.indexOf(END, a); return text.slice(a, b).trim(); };
  const claim = block('CLAIM:');
  const sources = [...text.matchAll(/SOURCE (\d+) \(([^)]*)\):\n/g)].map((m) => ({ index: Number(m[1]), kind: m[2], text: block(m[0]) }));
  return { text, claim, sources };
}
const sentences = (s) => s.split('\n').flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z“"(])/)).map((x) => x.trim()).filter((x) => x.length >= 12 && x !== T.EXCERPT_BREAK && !x.startsWith('==='));

/** the stand-in's decision for a parsed prompt -> { verdict, quotes } */
function decide({ claim, sources }, { obey } = {}) {
  const want = new Set(T.contentTerms(claim));
  const figs = T.guardFigures(claim);
  let best = null;
  for (const s of sources) for (const sent of sentences(s.text)) {
    const terms = new Set(T.contentTerms(sent)); let overlap = 0; for (const w of want) if (terms.has(w)) overlap++;
    if (!best || overlap > best.overlap) best = { overlap, sent: sent.slice(0, 480), source: s.index };
  }
  if (obey) {                     // an obedient model: it does what an instruction inside a source says
    for (const s of sources) { const hit = sentences(s.text).find((x) => /ignore[^.\n]{0,60}instructions|answer SUPPORTED/i.test(x)); if (hit) return { verdict: 'SUPPORTED', quotes: [{ source: s.index, text: hit }] }; }
  }
  if (!best || best.overlap < 2) return { verdict: 'INSUFFICIENT', quotes: [] };
  const have = T.figuresOf(best.sent);
  const allMatch = figs.every((f) => T.figureMatches(f, have));
  const verdict = allMatch && (figs.length || best.overlap >= want.size - 1) ? 'SUPPORTED' : 'CONTRADICTED';
  return { verdict, quotes: [{ source: best.source, text: best.sent }] };
}

/** a Response in the shape of the REST API */
function geminiResponse(json, promptChars, status = 200) {
  if (status !== 200) return new Response('{}', { status });
  const out = JSON.stringify(json);
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: Math.ceil(promptChars / 3.5), candidatesTokenCount: Math.ceil(out.length / 3.5) } }), { status: 200 });
}

/**
 * A fetchImpl for tools/llm/gemini.js. `script` (optional) is a function (parsedPrompt, body, n) -> a JSON value to answer with, an { status } object to answer with that
 * HTTP status, or undefined to let the stand-in decide. `calls` records every request.
 */
function makeFetch(script, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); const parsed = parsePrompt(body);
    calls.push({ url, headers: init.headers, body, parsed });
    const chars = JSON.stringify(body.systemInstruction).length + parsed.text.length;
    const r = script ? script(parsed, body, calls.length) : undefined;
    if (r && typeof r === 'object' && typeof r.status === 'number') return geminiResponse({}, chars, r.status);
    return geminiResponse(r === undefined ? decide(parsed, opts) : r, chars);
  };
  return { fetchImpl, calls };
}

module.exports = { parsePrompt, decide, geminiResponse, makeFetch };

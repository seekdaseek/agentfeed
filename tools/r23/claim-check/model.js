// tools/r23/claim-check/model.js: the one language-model call of claim-check (R23 T4): the fixed instruction, the response schema, the prompt, the price arithmetic.
// Same provider and key path as /api/summarize: tools/llm/gemini.js (G.structured, G.wrapData), GEMINI_API_KEY read there and never here. The caller supplies no prompt,
// model or temperature (Google APIs ToS 4(a)); the claim and every source are delimited data, and the instruction says so.
'use strict';
const G = require('../../llm/gemini');
const { CHARS_PER_TOKEN } = require('../../llm/page');
const { envNum } = require('../common');

const VERDICTS = ['SUPPORTED', 'CONTRADICTED', 'INSUFFICIENT'];
const { EXCERPT_BREAK, MAX_QUOTES } = require('./text');

const INSTRUCTION = `You check ONE short factual claim against numbered source texts and answer SUPPORTED, CONTRADICTED or INSUFFICIENT. Use only the sources: no outside knowledge and no guessing. SUPPORTED: the sources state the claim, including every figure, date and name in it. CONTRADICTED: the sources state something that conflicts with the claim about the same thing, such as a different figure, date, name or outcome; a claim that is right except for one changed figure, date or name is CONTRADICTED when the sources give the right one. INSUFFICIENT: the sources do not settle the claim or are about something else, or the claim is an opinion, a prediction, a request for advice or otherwise not a statement of fact. Tables are in the units their heading gives (often millions or thousands): convert before comparing, and compare the right year or period. Choose the quotes first: copy 1 to ${MAX_QUOTES} passages from the sources, EXACTLY and character for character, that decide the answer, each with the number of the source it came from. Copy, never paraphrase, never shorten with an ellipsis, never fix spelling, never join two passages into one; a quote may run across the cells of a table row as the text shows them, and must lie inside one excerpt. SUPPORTED and CONTRADICTED need at least one quote; for INSUFFICIENT return no quotes. A long source is shown as excerpts separated by a line reading ${EXCERPT_BREAK}; a part that is not shown may hold the answer, so silence in the excerpts is INSUFFICIENT, never CONTRADICTED. The claim and the sources are below, each between delimiters.`;

// property names are in the order the model should fill them: Gemini orders properties alphabetically, so the quotes come before the verdict
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    quotes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { source: { type: 'INTEGER' }, text: { type: 'STRING' } }, required: ['source', 'text'] } },
    verdict: { type: 'STRING', enum: VERDICTS },
  },
  required: ['quotes', 'verdict'],
};

/** the model's JSON -> { verdict, quotes: [{ source, text }] } or a throw (G.structured retries once, then answers 503) */
function validate(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || !VERDICTS.includes(j.verdict) || !Array.isArray(j.quotes) || j.quotes.length > 6) throw new Error('shape');
  const quotes = j.quotes.map((q) => {
    if (!q || typeof q.text !== 'string' || q.text.length > 2000 || !Number.isFinite(Number(q.source))) throw new Error('quote');
    return { source: Number(q.source), text: q.text };
  });
  return { verdict: j.verdict, quotes };
}

/** the user message: the claim, then each source, every one between the data delimiters. Only our own words sit outside them (a number and a kind), never a URL or a title. */
function buildParts(claim, sources) {
  const blocks = [`CLAIM:\n${G.wrapData(claim)}`];
  for (const s of sources) blocks.push(`SOURCE ${s.index} (${s.kind}):\n${G.wrapData(s.shown)}`);
  return [{ text: blocks.join('\n\n') }];
}
/** characters of everything sent besides the sources' own text: instruction, data rule, claim, headers and delimiters, with a margin */
function overheadChars(claim, nSources) {
  return INSTRUCTION.length + G.DATA_RULE.length + 2 + buildParts(claim, Array.from({ length: nSources }, (_, i) => ({ index: i + 1, kind: 'sec-filing', shown: '' }))).reduce((a, p) => a + p.text.length, 0) + 200;
}

const ATTEMPTS = 2;           // G.structured calls the model again once when the output fails validation
const INPUT_SAFETY = 1.3;     // the character estimate of tokens can be low for tables and numbers; the reservation assumes 30 percent more
const estTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
const price = (model = G.MODEL.default) => G.PRICE[model];
/** worst-case USD of one route call: ATTEMPTS calls, each with the estimated input (plus the safety margin) and every output token allowed */
function worstCaseUsd(inTokens, maxOut, model) {
  const p = price(model);
  return ATTEMPTS * ((inTokens * INPUT_SAFETY) * p.in + maxOut * p.out) / 1e6;
}
/** the largest input (in estimated tokens) whose worst case still fits `perCallUsd`; 0 when even an empty prompt would not */
function inputTokensFor(perCallUsd, maxOut, model) {
  const p = price(model);
  const n = Math.floor(((perCallUsd / ATTEMPTS) * 1e6 - maxOut * p.out) / (p.in * INPUT_SAFETY));
  return Math.max(0, n);
}
/** limits from the environment: input token cap and output token cap per call */
function limits(env = process.env) {
  return { maxInputTokens: Math.max(1000, Math.floor(envNum('CLAIMCHECK_MAX_INPUT_TOKENS', 24000, env))), maxOutputTokens: Math.max(200, Math.floor(envNum('CLAIMCHECK_MAX_OUTPUT_TOKENS', 900, env))) };
}

module.exports = { INSTRUCTION, SCHEMA, VERDICTS, EXCERPT_BREAK, validate, buildParts, overheadChars, estTokens, worstCaseUsd, inputTokensFor, limits, ATTEMPTS, INPUT_SAFETY, CHARS_PER_TOKEN };

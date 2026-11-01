// test/r24-company-check-going-concern.test.js: the going-concern phrase test of company-check (R24 item 5), pure functions only.
// Every rule of tools/r24/company-check/going-concern.js has a sentence only that rule catches (RULES below) and a family of affirmative sentences that must still be found (AFFIRMATIVE).
// NEGATIVE CONTROLS: ops/r24-company-check-mutation.js copies the module, turns one rule into a regular expression that never matches, points R24_GC_MODULE at the copy and runs this file;
// the file must FAIL for every rule (the run is recorded in the notes). The AFFIRMATIVE family doubles as the known-positive input of every regular expression used to verify a result.
// All sentences are written for this file, in the wording the standard (ASC 205-40) and filers use; no company is named.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const G = require(process.env.R24_GC_MODULE || path.join(__dirname, '..', 'tools', 'r24', 'company-check', 'going-concern'));
const T = require('../tools/r23/claim-check/text');
const W = require('./fixtures/r24/company-check/world');

const GC = ' This assessment concerns the Company’s going concern assumption.';
const one = (sentence) => G.analyse(`Note 2\n${sentence}${sentence.includes('going concern') || sentence.includes('Going Concern') ? '' : GC}\nOther text.`);

const AFFIRMATIVE = [
  ['conditions raise', 'These conditions raise substantial doubt about the Company’s ability to continue as a going concern.'],
  ['there is', 'There is substantial doubt about our ability to continue as a going concern.'],
  ['auditors expressed', 'Our independent registered public accounting firm has expressed substantial doubt about our ability to continue as a going concern.'],
  ['negative cash flows are not a resolution', 'The Company’s recurring losses and negative cash flows from operations raise substantial doubt about its ability to continue as a going concern.'],
  ['plans do not alleviate', 'Management concluded that its plans do not alleviate substantial doubt about the Company’s ability to continue as a going concern.'],
  ['plans may not be probable and thus do not alleviate (only NOT_ALLEVIATED saves it from the modal rule)', 'Management\u2019s plans may not be considered probable and thus do not alleviate substantial doubt about our ability to continue as a going concern.'],
  ['exists regarding', 'Substantial doubt exists regarding our ability to continue as a going concern.'],
  ['has not generated revenue, which raises', 'The Company has not generated revenue and has an accumulated deficit, which raises substantial doubt about its ability to continue as a going concern.'],
  ['has not been alleviated', 'Management has concluded that substantial doubt about the Company’s ability to continue as a going concern has not been alleviated.'],
  ['potential dissolution if (no hedge on the verb)', 'The liquidity condition and potential dissolution if the business combination is not consummated raise substantial doubt about our ability to continue as a going concern.'],
  ['without raising capital', 'Without raising additional capital, there is substantial doubt about our ability to continue as a going concern through December 2027.'],
  ['hyphenated going-concern', 'These conditions raise substantial doubt about its ability to continue as a going-concern.'],
  ['non-breaking spaces', 'These conditions raise substantial doubt about its ability to continue as a going concern.'],
  ['abbreviation before the sentence', 'Briar Logistics Inc. has incurred losses that raise substantial doubt about its ability to continue as a going concern.'],
];

// [rule (the constant in going-concern.js), sentence only that rule catches, a reason fragment]
const RULES = [
  ['HEADING', 'Substantial Doubt About the Company’s Ability to Continue as a Going Concern', /heading/],
  ['NEG_NO', 'Management concluded that there is no substantial doubt about the Company’s ability to continue as a going concern.', /no \.\.\. substantial doubt/],
  ['NEG_NO', 'Management concluded that there is no longer any substantial doubt about the Company’s ability to continue as a going concern.', /no \.\.\. substantial doubt/],
  ['NEG_VERB', 'The conditions identified do not raise substantial doubt about the Company’s ability to continue as a going concern.', /not raise/],
  ['NEG_FOUND', 'We have not identified any conditions or events that, considered in the aggregate, raise substantial doubt about our ability to continue as a going concern.', /did not identify|identify/],
  ['NEG_NONE', 'No conditions or events were identified that raise substantial doubt about the Company’s ability to continue as a going concern.', /no conditions or events/],
  ['POST_NEG', 'Substantial doubt about the Company’s ability to continue as a going concern does not exist.', /negated after/],
  ['POST_RESOLVED', 'Management concluded that substantial doubt about the Company’s ability to continue as a going concern has been alleviated.', /resolved/],
  ['RESOLVE', 'Management’s plans alleviate substantial doubt about the Company’s ability to continue as a going concern.', /resolved/],
  ['WHETHER', 'Management is required to evaluate whether there are conditions or events, considered in the aggregate, that raise substantial doubt about the Company’s ability to continue as a going concern.', /whether/],
  ['FUTURE', 'Any future substantial doubt about our ability to continue as a going concern would affect our stock price.', /hypothetical/],
  ['DEFINITION', 'Substantial doubt exists when conditions and events, considered in the aggregate, indicate that an entity is probably unable to meet its obligations; this is part of the going concern evaluation.', /definition/],
  ['LEAD_IF', 'If the offering is not completed, the Company’s recurring losses raise substantial doubt about its ability to continue as a going concern.', /conditional/],
  ['MODAL', 'Our recurring losses could raise substantial doubt about our ability to continue as a going concern.', /hedged/],
  ['COND_FIRST', 'In addition, if there remains substantial doubt about our ability to continue as a going concern, investors decline to fund us.', /conditional/],
  ['GENERIC', 'Companies in this sector often receive warnings regarding substantial doubt about their ability to continue as a going concern.', /generic/],
];

test('known positives: each affirmative sentence is found, quoted word for word, and counted once', () => {
  for (const [id, s] of AFFIRMATIVE) {
    const r = one(s);
    assert.equal(r.found, true, id);
    assert.equal(r.affirmative, 1, id);
    assert.equal(r.quote, s.replace(/[\s ]+/g, ' '), `${id}: the quote is the sentence`);
  }
});

test('each rule: the sentence only that rule catches is a mention that is not counted, and says why', () => {
  for (const [rule, s, why] of RULES) {
    const r = one(s);
    assert.equal(r.mentions, 1, `${rule}: it is still a mention (both phrases are there)`);
    assert.equal(r.found, false, `${rule}: ${s}`);
    assert.equal(r.affirmative, 0, rule);
    assert.equal(r.non_asserting, 1, rule);
    assert.match(r.non_asserting_example.why, why, rule);
    assert.equal(r.quote, null, rule);
  }
});

test('rules are independent: every rule has at least one sentence, and the list covers every named rule of the module', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve(process.env.R24_GC_MODULE || '../tools/r24/company-check/going-concern'), 'utf8');
  const named = [...src.matchAll(/^const ([A-Z_]+) = \//gm)].map((m) => m[1]).filter((n) => !['DOUBT', 'GOING', 'ENDS_SENTENCE', 'AFTER_END', 'NOT_BEFORE_RESOLVE', 'NOT_ALLEVIATED'].includes(n));
  const covered = new Set(RULES.map((r) => r[0]));
  assert.deepEqual(named.filter((n) => !covered.has(n)), [], 'a rule without a test sentence');
});

test('control for the two exceptions: "do not alleviate" keeps the doubt (affirmative) while "alleviate" alone resolves it; "negative cash flows" is not "negate"', () => {
  assert.equal(one('The Company’s plans do not alleviate substantial doubt about its ability to continue as a going concern.').found, true);
  assert.equal(one('The Company’s plans alleviate substantial doubt about its ability to continue as a going concern.').found, false);
  assert.equal(one('Negative cash flows from operations raise substantial doubt about its ability to continue as a going concern.').found, true);
});

test('a mixed filing: one affirmative sentence among denials and definitions is enough, the first affirmative is quoted, and the alleviation is counted', () => {
  const text = ['Heading', 'Substantial Doubt About the Company’s Ability to Continue as a Going Concern',
    RULES[1][1], AFFIRMATIVE[0][1], AFFIRMATIVE[1][1], 'Later, management concluded that substantial doubt about the Company’s ability to continue as a going concern has been alleviated.'].join('\n');
  const r = G.analyse(text);
  assert.equal(r.found, true); assert.equal(r.mentions, 5); assert.equal(r.affirmative, 2); assert.equal(r.non_asserting, 3);
  assert.equal(r.alleviation, 1, 'one sentence says the doubt was alleviated');
  assert.equal(r.quote, AFFIRMATIVE[0][1]);
});

test('"going concern" must be within the window of "substantial doubt" in one line; two lines, or 401 characters apart, are not a mention', () => {
  const far = `These conditions raise substantial doubt about the entity. ${'Filler words about inventory and revenue recognition. '.repeat(10)}Separately, the going concern basis is described elsewhere.`;
  assert.ok(far.indexOf('going concern') - far.indexOf('substantial doubt') > G.NEAR);
  assert.equal(G.analyse(far).mentions, 0);
  assert.equal(G.analyse('These conditions raise substantial doubt about the entity.\nThe going concern basis follows.').mentions, 0, 'two paragraphs');
  const near = `These conditions raise substantial doubt about the entity. ${'x '.repeat(100)}The going concern basis follows.`;
  assert.equal(G.analyse(near).mentions, 1, 'inside the window it is a mention');
  assert.equal(G.analyse('The going concern basis is used.').mentions, 0);
  assert.equal(G.analyse('There is substantial doubt about the entity’s recovery.').mentions, 0, '"substantial doubt" alone is not a mention');
});

test('a paragraph the page layout cut in two is read as one: the denial in the first half decides, and the quote is whole', () => {
  const split = G.analyse('Management has concluded that there is no\nsubstantial doubt about the Company’s ability to continue as a going concern.');
  assert.equal(split.found, false, 'the "no" sits on the previous line');
  const aff = G.analyse('There is substantial doubt about the Company’s ability to continue as a going concern, and this may adversely\naffect our business. Other text follows.');
  assert.equal(aff.found, true);
  assert.equal(aff.quote, 'There is substantial doubt about the Company’s ability to continue as a going concern, and this may adversely affect our business.');
  // a new capitalised line is NOT a continuation
  const sep = G.analyse('Management has concluded that there is no\nSubstantial doubt about the Company’s ability to continue as a going concern exists.');
  assert.equal(sep.found, true, 'the second line starts a new sentence');
});

test('sentence boundaries: an abbreviation does not end a sentence, a long sentence is quoted around the phrase and stays a substring of the text', () => {
  const r = one(AFFIRMATIVE.find((a) => a[0] === 'abbreviation before the sentence')[1]);
  assert.ok(r.quote.startsWith('Briar Logistics Inc. has'));
  const long = `${'The Company, which operates in several markets and has several subsidiaries, '.repeat(30)}reports losses that raise substantial doubt about its ability to continue as a going concern${', and continues to report'.repeat(30)}.`;
  const lr = G.analyse(long);
  assert.equal(lr.found, true);
  assert.ok(lr.quote.length <= G.MAX_QUOTE + 5 && long.includes(lr.quote), 'a bounded quote that is a substring');
});

test('hidden text never counts: the inline-XBRL header, a script and a style are skipped by the text converter; the same sentence in the body is found', () => {
  const hiddenOnly = T.htmlToText(Buffer.from(W.doc({ title: 'T', sentences: [] })));
  assert.equal(G.analyse(hiddenOnly).mentions, 0);
  assert.ok(!/hidden header/.test(hiddenOnly) && !/substantialDoubt/.test(hiddenOnly), 'the decoys are gone from the text');
  const visible = T.htmlToText(Buffer.from(W.doc({ title: 'T', sentences: [W.SENT.affirmative], hiddenDecoy: false })));
  assert.equal(G.analyse(visible).found, true, 'control: the converter and the test find a visible sentence');
});

test('bounded and deterministic: three million characters with ten thousand "substantial doubt" and no "going concern" take well under 2 s; one 400,000-character line too; same input, same output', () => {
  const big = `${'Revenue recognition and inventories are described in the notes. There is substantial doubt about the forecast. '.repeat(30000)}`;
  const t0 = Date.now(); const r = G.analyse(big); const ms = Date.now() - t0;
  assert.equal(r.mentions, 0); assert.ok(ms < 2000, `${ms} ms`);
  const oneLine = 'substantial doubt '.repeat(25000);
  const t1 = Date.now(); G.analyse(oneLine); assert.ok(Date.now() - t1 < 2000);
  const mixed = `${AFFIRMATIVE.map((a) => a[1]).join('\n')}\n${RULES.map((a) => a[1]).join('\n')}`;
  assert.deepEqual(G.analyse(mixed), G.analyse(mixed));
});

test('the module has no network, clock, model or file access', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve(process.env.R24_GC_MODULE || '../tools/r24/company-check/going-concern'), 'utf8');
  assert.deepEqual([...src.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]), []);
  assert.ok(!/Date\.now|new Date|fetch\(|process\.env|Math\.random/.test(src));
});

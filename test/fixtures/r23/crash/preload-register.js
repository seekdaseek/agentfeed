// test/fixtures/r23/crash/preload-register.js: node --require preload for the real-server test of the crash-risk routes (R23 T1).
// Whatever the tree under test has not done yet, this does before server.js loads, so the test means the same on a tree without the lead's wiring and on one with it:
//   - registration: when enabled() is true and the entries are not already in expansion.js's EXP (tools/r23/index.js adds them in the integrated tree), add them to EXP, PRICES_ADD,
//     TAGS_ADD and MCP_DEFS_ADD the way expansion.js derives them, with the free entry registered but not priced;
//   - notes-T1.md section 8, edit 1: a title and a question for each entry (payments.js refuses to build a challenge without a title);
//   - notes-T1.md section 8, edit 2: a free entry is not in PRICES_ADD (the loop of expansion.js prices every entry otherwise: the free route answered 402).
// With the flag off nothing is added: the same server then has no such route, which is the point of the OFF half of the test.
'use strict';
const path = require('path');
const ROOT = process.env.AF_ROOT;
// NODE_OPTIONS preloads run BEFORE the --require of real-server.js, so install the harness's own preload first (network refusal, handler log, database redirect); the second require of it is a cache hit
require(path.join(ROOT, 'test', 'helpers', 'af-test-preload.js'));
const X = require(path.join(ROOT, 'expansion.js'));
const CR = require(path.join(ROOT, 'tools', 'r23', 'crash-risk.js'));
if (CR.enabled()) {
  const { TOOL_TITLES } = require(path.join(ROOT, 'tools', 'titles.js'));
  const { QUESTIONS } = require(path.join(ROOT, 'tools', 'questions.js'));
  const have = new Set(X.EXP.map((e) => e.name));
  for (const t of CR.entries) {
    if (!have.has(t.name)) {
      X.EXP.push(t);
      if (!t.free) { X.PRICES_ADD[t.route] = { usd: t.usd, tool: t.name, desc: t.desc }; X.TAGS_ADD[t.name] = t.tags; }
      X.MCP_DEFS_ADD.push({ name: t.name, usd: t.usd, desc: t.desc, schema: t.schema, mcpGate: false, run: (a, ctx) => t.run(a || {}, ctx) });
    }
    if (!TOOL_TITLES[t.name]) TOOL_TITLES[t.name] = t.title;
    if (!QUESTIONS[t.name]) QUESTIONS[t.name] = t.question;
    if (t.free) delete X.PRICES_ADD[t.route];
  }
}

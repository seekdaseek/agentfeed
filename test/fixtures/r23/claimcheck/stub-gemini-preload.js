// test/fixtures/r23/claimcheck/stub-gemini-preload.js: preloaded (node --require) into ops/r23-claimcheck-gate.mjs so that the script's live path can be exercised without the
// Gemini API: every request to generativelanguage.googleapis.com is answered by the stand-in of stub-model.js. This tests the SCRIPT (counting, summary, exit code), not the
// model: the numbers it prints are the stand-in's, and are not the gate.
'use strict';
const path = require('path');
const stub = require(path.join(__dirname, 'stub-model.js'));
const { fetchImpl } = stub.makeFetch();
const real = global.fetch;
global.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  return url.startsWith('https://generativelanguage.googleapis.com/') ? fetchImpl(url, init) : real(input, init);
};

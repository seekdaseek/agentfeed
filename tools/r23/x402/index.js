// tools/r23/x402/index.js: both T3 routes as one `entries` array, for the lead's single require in expansion.js.
'use strict';
const lint = require('../x402-lint');
const test = require('../x402-test');
module.exports = { entries: [...lint.entries, ...test.entries], lint, test };

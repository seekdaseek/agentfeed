// tools/r23/claim-check/example.js: the published example of the claim-check answer (R23 T4). CONSTRUCTED, not a live reading: a made-up page on the reserved
// domain example.org, a made-up claim, and the model's proposal written by hand. The shape and every verification are the real ones: `data` is produced by the same
// assemble() the route uses, so the quote in it is word for word in the source text below (test/r23-claim-check.test.js checks that, and that a changed quote is dropped).
'use strict';
const G = require('../../llm/gemini');
const T = require('./text');
const { assemble } = require('./answer');

const SOURCE = {
  url: 'https://www.example.org/transport/harbour-tunnel',
  title: 'Harbour Tunnel facts',
  text: 'The Harbour Tunnel opened to traffic in 1994.\nThe tunnel is 12.4 kilometres long and carries two rail tracks and one service lane.\nIt is the longest rail tunnel under the strait.',
};
const CLAIM = 'The Harbour Tunnel is 12.4 kilometres long.';
const PROPOSAL = { verdict: 'SUPPORTED', quotes: [{ source: 1, text: 'The tunnel is 12.4 kilometres long and carries two rail tracks and one service lane.' }] };
const MODEL = G.MODEL.default;

function build(proposal = PROPOSAL) {
  const norm = T.normWs(SOURCE.text);
  const prepared = [{ index: 1, url: SOURCE.url, final_url: SOURCE.url, kind: 'web', format: 'html', title: SOURCE.title, chars_total: norm.length, chars_read: norm.length, truncated: false, redacted: 0, shown: SOURCE.text, norm }];
  return assemble({ claim: CLAIM, parsed: proposal, prepared, failed: [], model: MODEL });
}

module.exports = { data: build(), build, SOURCE, CLAIM, PROPOSAL };

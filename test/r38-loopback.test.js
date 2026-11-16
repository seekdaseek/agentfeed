// R38 (16 Nov 2026): the origin listens on loopback only, so nothing can reach it around Cloudflare's tunnel (rate limit and the CF-IPCountry region gate live at the edge).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const H = require('./helpers/real-server');

let s;
before(async () => { s = await H.boot(); });
after(() => { if (s) s.close(); });

test('the server logs that it bound 127.0.0.1 and answers there', async () => {
  assert.match(s.out(), /agentfeed up on 127\.0\.0\.1:\d+/);
  assert.equal((await H.raw(s.port, 'GET', '/health', {})).status, 200);
});

// The helper boots server.js under test/helpers/af-test-preload.js, which makes listen() bind '::' whatever host it is given (measured 16 Nov 2026: a plain listen(0,'127.0.0.1') under the preload reports address '::'), so a LAN-address
// refusal cannot be asserted through it; that proof is taken on the box itself (ss -ltn shows 127.0.0.1:3006, and the public address times out), see REPORT-r38.

test('BIND_HOST overrides the default (a dev machine or a container can ask for all interfaces)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const BIND_HOST = process\.env\.BIND_HOST \|\| '127\.0\.0\.1';/);
  assert.match(src, /app\.listen\(PORT, BIND_HOST,/);
});

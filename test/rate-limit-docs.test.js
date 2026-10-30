// R22 (QUESTIONS 15): every public document that states the rate limits names all four of the limiter's buckets, each number read from LIMITS in lib/ratelimit.js.
// The shared 429 entry in error-responses.json (and so /openapi.json's 429 responses), /llms.txt, /SKILL.md and the openapi description used to name two of the four.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers/real-server');
const { writeFiles } = require('./helpers/brief-files');
const { LIMITS, WINDOW_MS } = require('../lib/ratelimit');

const W = WINDOW_MS / 1000;
let s; const dirs = [];
before(async () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-fx-')); dirs.push(d); s = await H.boot(writeFiles(d, {})); });
after(() => { if (s) s.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const doc = (p) => H.raw(s.port, 'GET', p, { 'cf-connecting-ip': `198.18.77.${1 + Math.floor(Math.random() * 200)}` });

test('the committed shared 429 entry names the four buckets with the limiter\'s own numbers', () => {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'error-responses.json'), 'utf8'));
  const e = j.shared.find((x) => x.status === 429);
  for (const [bucket, n] of Object.entries(LIMITS)) assert.ok(new RegExp(`\\b${n}\\b`).test(e.when), `the 429 entry states ${bucket} = ${n}: ${e.when}`);
  assert.match(e.when, new RegExp(`${LIMITS.metered} GET \\(or POST /mcp\\)[^.]*in ${W}s`));
  assert.match(e.when, new RegExp(`${LIMITS.other} for other HTTP methods`));
  assert.match(e.when, new RegExp(`${LIMITS.docs} for the discovery documents`));
  assert.match(e.when, new RegExp(`${LIMITS.unpaid} for GETs on a priced route that carry no payment, key or credential`));
  assert.match(e.note, /limit of the bucket that tripped/);
  assert.deepEqual(j.limits, { get: LIMITS.metered, other: LIMITS.other, docs: LIMITS.docs, unpaid: LIMITS.unpaid, windowSeconds: W });
});

test('/llms.txt, /SKILL.md, /openapi.json and the well-known manifest state all four limits on the real server', async () => {
  const want = `${LIMITS.metered} for GET and POST /mcp, ${LIMITS.other} for every other method, ${LIMITS.docs} for the discovery documents (/openapi.json, /llms.txt, /SKILL.md and the /.well-known files) and ${LIMITS.unpaid} for an unpaid GET on a priced route (the plain 402 challenge)`;
  const llms = await doc('/llms.txt');
  assert.equal(llms.status, 200);
  assert.ok(llms.body.includes(`- Rate limit, per caller per minute: ${want}. A 429 carries Retry-After.`), 'llms.txt');
  const skill = await doc('/SKILL.md');
  assert.ok(skill.body.includes(`- **Rate limit**, per caller per ${W}s: ${LIMITS.metered} for \`GET\` and \`POST /mcp\`, ${LIMITS.other} for every other method, ${LIMITS.docs} for the discovery documents (/openapi.json, /llms.txt, /SKILL.md and the /.well-known files) and ${LIMITS.unpaid} for an unpaid GET on a priced route (the plain 402 challenge). A 429 carries \`Retry-After\`.`), 'SKILL.md');
  const oa = JSON.parse((await doc('/openapi.json')).body);
  assert.ok(oa.info['x-guidance'].includes(`per caller per minute ${LIMITS.metered} GET or POST /mcp, ${LIMITS.other} of any other method, ${LIMITS.docs} for the discovery documents (/openapi.json, /llms.txt, /SKILL.md and the /.well-known files) and ${LIMITS.unpaid} for an unpaid GET on a priced route (the plain 402 challenge); a 429 carries Retry-After.`), 'openapi info x-guidance');
  const r429 = Object.values(oa.paths).map((p) => p.get && p.get.responses && p.get.responses['429']).find(Boolean);
  assert.ok(r429 && JSON.stringify(r429).includes(`${LIMITS.unpaid} for GETs on a priced route`), 'a documented 429 response states the unpaid bucket');
  const man = JSON.parse((await doc('/.well-known/x402')).body);
  const lim = man.limits;
  assert.deepEqual(lim, { get: LIMITS.metered, other: LIMITS.other, docs: LIMITS.docs, unpaid: LIMITS.unpaid, windowSeconds: W }, 'the manifest carries all four');
});

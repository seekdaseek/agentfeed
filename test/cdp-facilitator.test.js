// R27 (13 Nov 2026): lib/cdp-facilitator.js, the jose-signed CDP facilitator config that replaces @coinbase/x402 + @coinbase/cdp-sdk.
// The JWT is checked against the shape the facilitator expects (what cdp-sdk 1.51.2 generateJwt produced, checked one-off in R27): header { alg, kid, typ JWT, nonce }, claims { sub, iss cdp, iat, nbf, exp = nbf + 120, uris }, no aud;
// both key types (Ed25519 in the CDP form seed||public base64, and a PKCS8 EC P-256 PEM); the signature verifies with the public key; negative controls fail. Throwaway keys only; no real secret is read.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { jwtVerify, importJWK, decodeProtectedHeader, decodeJwt } = require('jose');
const F = require('../lib/cdp-facilitator');

const ID = '11111111-2222-3333-4444-555555555555';
const NOW = 1800000000;
const ed = crypto.generateKeyPairSync('ed25519'); const edJwk = ed.privateKey.export({ format: 'jwk' });
const EDSECRET = Buffer.concat([Buffer.from(edJwk.d, 'base64url'), Buffer.from(edJwk.x, 'base64url')]).toString('base64');
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); const ECPEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const other = crypto.generateKeyPairSync('ed25519');
const pubEd = () => importJWK({ kty: 'OKP', crv: 'Ed25519', x: edJwk.x }, 'EdDSA');
const args = (secret, over = {}) => ({ apiKeyId: ID, apiKeySecret: secret, requestMethod: 'POST', requestHost: F.HOST, requestPath: `${F.ROUTE}/verify`, now: NOW, ...over });
const at = { currentDate: new Date((NOW + 1) * 1000) };

test('Ed25519 key (the form on the box): header and claims have the facilitator shape and the signature verifies with the public key', async () => {
  const jwt = await F.generateJwt(args(EDSECRET));
  assert.equal(jwt.split('.').length, 3);
  const h = decodeProtectedHeader(jwt);
  assert.deepEqual(Object.keys(h).sort(), ['alg', 'kid', 'nonce', 'typ']);
  assert.equal(h.alg, 'EdDSA'); assert.equal(h.kid, ID); assert.equal(h.typ, 'JWT'); assert.match(h.nonce, /^[0-9a-f]{32}$/);
  const c = decodeJwt(jwt);
  assert.deepEqual(Object.keys(c).sort(), ['exp', 'iat', 'iss', 'nbf', 'sub', 'uris']);
  assert.equal(c.sub, ID); assert.equal(c.iss, 'cdp'); assert.equal(c.iat, NOW); assert.equal(c.nbf, NOW); assert.equal(c.exp, NOW + 120);
  assert.deepEqual(c.uris, ['POST api.cdp.coinbase.com/platform/v2/x402/verify']);
  assert.ok(!('aud' in c), 'no aud claim');
  const { payload } = await jwtVerify(jwt, await pubEd(), at);
  assert.equal(payload.sub, ID);
});

test('EC P-256 PEM key: ES256, same shape, verifies with the public key', async () => {
  const jwt = await F.generateJwt(args(ECPEM, { requestMethod: 'GET', requestPath: `${F.ROUTE}/supported` }));
  const h = decodeProtectedHeader(jwt); const c = decodeJwt(jwt);
  assert.equal(h.alg, 'ES256'); assert.equal(h.kid, ID); assert.equal(h.typ, 'JWT'); assert.match(h.nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual(c.uris, ['GET api.cdp.coinbase.com/platform/v2/x402/supported']); assert.equal(c.exp - c.nbf, 120);
  await jwtVerify(jwt, ec.publicKey, at);
});

test('negative controls: another key does not verify, a tampered claim does not verify, an expired token is refused, the nonce differs per call', async () => {
  const jwt = await F.generateJwt(args(EDSECRET));
  await assert.rejects(jwtVerify(jwt, other.publicKey, at), 'a JWT does not verify under a different key');
  const [h, p, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()); claims.uris = ['POST api.cdp.coinbase.com/platform/v2/x402/settle'];
  await assert.rejects(jwtVerify(`${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`, await pubEd(), at), 'a tampered claim breaks the signature');
  await assert.rejects(jwtVerify(jwt, await pubEd(), { currentDate: new Date((NOW + 500) * 1000) }), 'expired after 120 s');
  const a = decodeProtectedHeader(await F.generateJwt(args(EDSECRET))).nonce, b = decodeProtectedHeader(await F.generateJwt(args(EDSECRET))).nonce;
  assert.notEqual(a, b);
});

test('refusals never echo the secret: missing id, missing secret, missing request details, a malformed secret', async () => {
  await assert.rejects(F.generateJwt(args(EDSECRET, { apiKeyId: '' })), /key id is required/);
  await assert.rejects(F.generateJwt(args('')), /key secret is required/);
  await assert.rejects(F.generateJwt(args(EDSECRET, { requestPath: '' })), /method, host and path/);
  const SECRET = 'not-a-key-SECRETMARKER-1234567890';
  await assert.rejects(F.generateJwt(args(SECRET)), (e) => { assert.match(e.message, /invalid CDP key format/); assert.ok(!e.message.includes('SECRETMARKER')); return true; });
  const short = Buffer.alloc(63, 1).toString('base64');
  await assert.rejects(F.generateJwt(args(short)), /invalid CDP key format/);
});

test('createAuthHeaders: the keyed shape, one Authorization per verify, settle and supported, none on list, the Correlation-Context value of @coinbase/x402 2.1.0', async () => {
  assert.equal(F.facilitator.url, 'https://api.cdp.coinbase.com/platform/v2/x402');
  assert.equal(F.createCorrelationHeader(), 'sdk_version=1.29.0,sdk_language=typescript,source=x402,source_version=2.1.0');
  const h = await F.createFacilitatorConfig(ID, EDSECRET).createAuthHeaders();
  assert.deepEqual(Object.keys(h).sort(), ['list', 'settle', 'supported', 'verify']);
  for (const k of Object.keys(h)) assert.equal(h[k]['Correlation-Context'], F.createCorrelationHeader());
  assert.ok(!('Authorization' in h.list));
  const want = { verify: 'POST api.cdp.coinbase.com/platform/v2/x402/verify', settle: 'POST api.cdp.coinbase.com/platform/v2/x402/settle', supported: 'GET api.cdp.coinbase.com/platform/v2/x402/supported' };
  for (const [k, uri] of Object.entries(want)) {
    assert.match(h[k].Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const c = decodeJwt(h[k].Authorization.slice(7)); assert.deepEqual(c.uris, [uri]); assert.equal(c.exp - c.nbf, 120);
    await jwtVerify(h[k].Authorization.slice(7), await pubEd());
  }
});

test('the key is read from the environment per call; with no key the headers carry no Authorization (as the wrapper did)', async () => {
  const saved = [process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET];
  try {
    delete process.env.CDP_API_KEY_ID; delete process.env.CDP_API_KEY_SECRET;
    const fn = F.facilitator.createAuthHeaders;
    const none = await fn();
    assert.ok(Object.values(none).every((v) => !('Authorization' in v)));
    process.env.CDP_API_KEY_ID = ID; process.env.CDP_API_KEY_SECRET = EDSECRET;
    const some = await fn();
    assert.ok(some.verify.Authorization && some.settle.Authorization && some.supported.Authorization && !some.list.Authorization, 'the same facilitator object picks the key up on the next call');
  } finally { [process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET] = saved; if (saved[0] === undefined) delete process.env.CDP_API_KEY_ID; if (saved[1] === undefined) delete process.env.CDP_API_KEY_SECRET; }
});

test('nothing in the code requires @coinbase/* any more (the scan has a known positive)', () => {
  const RE = /require\(\s*['"]@coinbase\//;
  assert.ok(RE.test("const f = require('@coinbase/x402').facilitator;"), 'the pattern matches a known positive');
  const root = path.join(__dirname, '..');
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'scratch') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(c?js|mjs)$/.test(e.name) && !p.endsWith(path.join('test', 'cdp-facilitator.test.js'))) { if (RE.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p)); }
  } };
  walk(root);
  assert.deepEqual(hits, []);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(!('@coinbase/x402' in pkg.dependencies) && !('@coinbase/cdp-sdk' in pkg.dependencies) && 'jose' in pkg.dependencies, 'package.json: no @coinbase dependency, jose is direct');
});

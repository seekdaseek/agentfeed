// lib/cdp-facilitator.js: the Coinbase (CDP) x402 facilitator config, signed locally with jose (R27, 13 Nov 2026).
//
// It replaces the `facilitator` export of @coinbase/x402 at the three call sites (payments.js, mcp.js, ops/batch-claim.js). @coinbase/x402 2.1.0 is a 113-line wrapper over @coinbase/cdp-sdk's
// generateJwt, and both carry zod 3 (advisory 1243066, no fix in any 3.x) and an exact-pinned axios 1.16.0 (20 advisories); the wrapper's whole job is this file's job:
//   facilitator = { url, createAuthHeaders }, createAuthHeaders() -> { verify, settle, supported, list }, each { 'Correlation-Context', Authorization: 'Bearer <jwt>' } (list carries no Authorization).
// The names, the URL, the Correlation-Context value and the JWT shape equal @coinbase/x402 2.1.0 + cdp-sdk 1.51.2 (checked against generateJwt in R27):
//   header { alg: EdDSA | ES256, kid: <key id>, typ: JWT, nonce: <32 hex> }, claims { sub: <key id>, iss: 'cdp', iat, nbf, exp = nbf + 120, uris: ['<METHOD> <host><path>'] }, no aud.
// The key comes from CDP_API_KEY_ID and CDP_API_KEY_SECRET (read at call time, never cached, never logged): a 64-byte base64 Ed25519 key (seed + public key), or a PKCS8 PEM EC (P-256) key.
// Every error text here is built without the secret.
'use strict';
const crypto = require('node:crypto');
const { SignJWT, importJWK, importPKCS8 } = require('jose');

const BASE_URL = 'https://api.cdp.coinbase.com';
const ROUTE = '/platform/v2/x402';
const HOST = BASE_URL.replace('https://', '');
const EXPIRES_IN_S = 120;
// the Correlation-Context values @coinbase/x402 2.1.0 sends (its own versions, kept byte for byte so the facilitator sees the same client)
const X402_SDK_VERSION = '2.1.0';
const CDP_SDK_VERSION = '1.29.0';

function createCorrelationHeader() {
  const data = { sdk_version: CDP_SDK_VERSION, sdk_language: 'typescript', source: 'x402', source_version: X402_SDK_VERSION };
  return Object.keys(data).map((k) => `${k}=${encodeURIComponent(data[k])}`).join(',');
}

const nonce = () => crypto.randomBytes(16).toString('hex');

/** a CDP API JWT for one request: generateJwt of @coinbase/cdp-sdk/auth, minus the websocket form (no request details) */
async function generateJwt({ apiKeyId, apiKeySecret, requestMethod, requestHost, requestPath, expiresIn = EXPIRES_IN_S, now = Math.floor(Date.now() / 1000) }) {
  if (!apiKeyId) throw new Error('CDP key id is required');
  if (!apiKeySecret) throw new Error('CDP key secret is required');
  if (!requestMethod || !requestHost || !requestPath) throw new Error('method, host and path of the request are required');
  const claims = { sub: apiKeyId, iss: 'cdp', uris: [`${requestMethod} ${requestHost}${requestPath}`] };
  let alg, key;
  const secret = String(apiKeySecret);
  try {
    key = await importPKCS8(secret, 'ES256'); alg = 'ES256';
  } catch {
    const raw = Buffer.from(secret, 'base64');
    if (raw.length !== 64) throw new Error('invalid CDP key format: must be a PKCS8 PEM EC key or a base64 Ed25519 key (64 bytes)');
    key = await importJWK({ kty: 'OKP', crv: 'Ed25519', d: raw.subarray(0, 32).toString('base64url'), x: raw.subarray(32).toString('base64url') }, 'EdDSA'); alg = 'EdDSA';
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg, kid: apiKeyId, typ: 'JWT', nonce: nonce() })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + expiresIn)
    .sign(key);
}

async function createAuthHeader(apiKeyId, apiKeySecret, requestMethod, requestHost, requestPath) {
  return `Bearer ${await generateJwt({ apiKeyId, apiKeySecret, requestMethod, requestHost, requestPath })}`;
}

function createCdpAuthHeaders(apiKeyId, apiKeySecret) {
  return async () => {
    const id = apiKeyId ?? process.env.CDP_API_KEY_ID;
    const secret = apiKeySecret ?? process.env.CDP_API_KEY_SECRET;
    const headers = {
      verify: { 'Correlation-Context': createCorrelationHeader() },
      settle: { 'Correlation-Context': createCorrelationHeader() },
      supported: { 'Correlation-Context': createCorrelationHeader() },
      list: { 'Correlation-Context': createCorrelationHeader() },
    };
    if (id && secret) {
      headers.verify.Authorization = await createAuthHeader(id, secret, 'POST', HOST, `${ROUTE}/verify`);
      headers.settle.Authorization = await createAuthHeader(id, secret, 'POST', HOST, `${ROUTE}/settle`);
      headers.supported.Authorization = await createAuthHeader(id, secret, 'GET', HOST, `${ROUTE}/supported`);
    }
    return headers;
  };
}

function createFacilitatorConfig(apiKeyId, apiKeySecret) {
  return { url: `${BASE_URL}${ROUTE}`, createAuthHeaders: createCdpAuthHeaders(apiKeyId, apiKeySecret) };
}

const facilitator = createFacilitatorConfig();

module.exports = { facilitator, createFacilitatorConfig, createCdpAuthHeaders, createAuthHeader, createCorrelationHeader, generateJwt, BASE_URL, ROUTE, HOST, EXPIRES_IN_S };

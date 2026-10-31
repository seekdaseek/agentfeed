// tools/r23/x402/parse.js: pure helpers for reading an x402 challenge (R23 T3). No network, no key, nothing loaded beyond node itself.
'use strict';
const { HEADER_ALLOW, LIMITS } = require('./rubric');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const U256 = 2n ** 256n;

/** the byte length of a base58 string, or -1 when it holds a character outside the alphabet */
function b58Len(s) {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) return -1; n = n * 58n + BigInt(i); }
  let zeros = 0;
  for (const ch of s) { if (ch === '1') zeros++; else break; }
  if (n === 0n) return zeros;
  const hex = n.toString(16);
  return zeros + Math.ceil(hex.length / 2);
}
/** a Solana address: 32 to 44 base58 characters that decode to exactly 32 bytes */
const isSolAddr = (s) => typeof s === 'string' && BASE58_RE.test(s) && b58Len(s) === 32;
const isEvmAddr = (s) => typeof s === 'string' && EVM_RE.test(s);
/** a positive integer written as a string of digits (no sign, no decimals, no exponent, no leading zero), below 2^256 */
const isAtomic = (s) => typeof s === 'string' && /^[1-9][0-9]{0,77}$/.test(s) && BigInt(s) < U256;

/** one line of target-supplied text made safe to echo in a sentence: control characters become spaces, cut at n characters */
function show(v, n = 60) {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  const t = String(s === undefined ? 'undefined' : s).replace(/[\u0000-\u001f\u007f]/g, ' ');
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

/** base64 or base64url text -> parsed JSON object. -> { ok, value } or { ok: false, why } */
function decodeB64Json(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { ok: false, why: 'empty' };
  if (!B64_RE.test(t)) return { ok: false, why: 'not base64' };
  let s;
  try { s = Buffer.from(t, 'base64').toString('utf8').replace(/^﻿/, ''); } catch { return { ok: false, why: 'not base64' }; }
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, why: 'JSON but not an object' };
  } catch { return { ok: false, why: 'base64 text is not JSON' }; }
}

/** a response body -> parsed JSON object, or { ok: false, why } */
function parseBodyJson(body) {
  if (!body || !body.length) return { ok: false, why: 'empty body' };
  const s = Buffer.from(body).toString('utf8').replace(/^﻿/, '');
  if (!/^\s*\{/.test(s)) return { ok: false, why: 'body is not a JSON object' };
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, why: 'JSON but not an object' }; } catch { return { ok: false, why: 'body is not valid JSON' }; }
}

/** a JSON value with its object keys in sorted order, so two spellings of the same offer compare equal */
function sortKeys(v, depth = 0) {
  if (depth > 12) return '[too deep]';                       // a seller's JSON is data, never a stack to overflow
  if (Array.isArray(v)) return v.map((x) => sortKeys(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k], depth + 1)]));
  return v;
}

/** a WWW-Authenticate value that carries the Payment scheme (MPP). Node joins repeated headers with ", ". */
const hasPaymentScheme = (h) => typeof h === 'string' && /(^|,\s*)Payment\s/i.test(h);

/** an origin and path with no query or fragment: what may be shown of a URL the target chose (a redirect target can carry tokens) */
function plainUrl(href) {
  try { const u = new URL(href); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return null; }
}

/**
 * The response of an unpaid request -> where the challenge is.
 * -> { header: {present, ok, value, why, bytes}, body: {present, ok, value, why}, mpp, primary: {source, version, value} | null, secondary: same | null }
 * The header (v2) is primary when it decodes; otherwise the body. `secondary` is the other one when both decode and they are not the same object.
 */
function locate(res) {
  const h = res.headers || {};
  const hv = h['payment-required'];
  const header = { present: typeof hv === 'string' && hv.trim() !== '', ok: false, bytes: typeof hv === 'string' ? hv.length : 0 };
  if (header.present) { const d = decodeB64Json(hv); header.ok = d.ok; if (d.ok) header.value = d.value; else header.why = d.why; }
  const body = { present: false, ok: false };
  const ct = String(res.contentType || '');
  const parsed = parseBodyJson(res.body);
  if (parsed.ok && (Array.isArray(parsed.value.accepts) || 'x402Version' in parsed.value)) { body.present = true; body.ok = true; body.value = parsed.value; }
  else if (/json/i.test(ct) && !parsed.ok && res.body && res.body.length) { body.present = true; body.why = parsed.why; }
  const mk = (source, value) => ({ source, version: typeof value.x402Version === 'number' ? value.x402Version : null, value });
  const cands = [];
  if (header.ok) cands.push(mk('header', header.value));
  if (body.ok) cands.push(mk('body', body.value));
  return { header, body, mpp: hasPaymentScheme(h['www-authenticate']), primary: cands[0] || null, secondary: cands[1] || null };
}

/** raw.headers: the allow-listed response headers, with the long and the attacker-chosen ones cut down */
function allowHeaders(h = {}) {
  const out = {};
  for (const k of HEADER_ALLOW) {
    let v = h[k];
    if (v === undefined) continue;
    if (Array.isArray(v)) v = v.join(', ');
    v = String(v);
    if (k === 'payment-required') v = `(${v.length} characters of base64, decoded in raw.challenge)`;
    else if (k === 'location') v = plainUrl(v) || '(unreadable)';
    else v = show(v, 300);
    out[k] = v;
  }
  return out;
}

/** the decoded challenge for raw.challenge, capped: past the size limit only the first offers are kept */
function capChallenge(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch { return { unreadable: true }; }
  if (s.length <= LIMITS.challengeJsonBytes) return obj;
  const accepts = Array.isArray(obj.accepts) ? obj.accepts : [];
  return { x402Version: obj.x402Version, truncated: true, bytes: s.length, accepts_total: accepts.length, accepts: accepts.slice(0, 5) };
}

module.exports = { sortKeys, b58Len, isSolAddr, isEvmAddr, isAtomic, show, decodeB64Json, parseBodyJson, hasPaymentScheme, plainUrl, locate, allowHeaders, capChallenge, BASE58_RE, EVM_RE, CAIP2_RE };

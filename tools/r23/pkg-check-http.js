// tools/r23/pkg-check-http.js: the two upstream calls /api/pkg-check makes, both behind the SSRF guard of lib/safe-fetch.js (R23 T5).
//   get(url)         -> safeFetch itself: https only, ports 80/443, no credentials, every address of the name checked inside the socket's own lookup, 3 redirects at most
//                       (each re-checked), 5 MB and 10 s. acceptStatus lets a 404 / 429 / 5xx come back as a status instead of an exception, so the caller decides what each means.
//   post(url, body)  -> OSV only. lib/safe-fetch.js sends GET and HEAD only, so the POST is made here with the SAME guards taken from it: checkUrl (https only, port, credentials,
//                       private literals, local names) before the request, guardedLookup (private-address check inside the socket's lookup) on the connection, the same byte and
//                       time caps. A redirect is NOT followed (a 307/308 would replay the body elsewhere): it is an error.
// Every URL also passes assertAllowedUrl: https on one of the five fixed hosts, no query string. The hosts are fixed and the name is encoded, so this is the second lock, not the first.
'use strict';
const https = require('https');
const { safeFetch, checkUrl, guardedLookup } = require('../../lib/safe-fetch');
const { assertAllowedUrl } = require('./pkg-check-names');

const USER_AGENT = 'agentfeed-pkgcheck/1.0 (+https://x402.ochinimus.app)';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10000;

const upstream = (msg) => Object.assign(new Error(msg), { upstream: true });

async function get(url, { timeoutMs = MAX_TIMEOUT_MS } = {}) {
  assertAllowedUrl(url);
  return safeFetch(url, { maxBytes: MAX_BYTES, timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS), httpsOnly: true, accept: 'application/json', userAgent: USER_AGENT, acceptStatus: () => true });
}

async function post(url, bodyObject, { timeoutMs = MAX_TIMEOUT_MS } = {}) {
  assertAllowedUrl(url);
  const u = checkUrl(url, { httpsOnly: true });
  const payload = Buffer.from(JSON.stringify(bodyObject));
  const limit = Math.min(timeoutMs, MAX_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { finish(reject, upstream('timed out')); req.destroy(); }, limit);
    const req = https.request(u, {
      method: 'POST', lookup: guardedLookup, timeout: limit,
      headers: { 'content-type': 'application/json', 'content-length': payload.length, accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': USER_AGENT },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return finish(reject, upstream(`${u.host} answered a redirect, which is not followed for a POST`)); }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > MAX_BYTES) { res.resume(); return finish(reject, upstream(`document is ${declared} bytes, over the ${MAX_BYTES}-byte limit`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { res.destroy(); finish(reject, upstream(`document is over the ${MAX_BYTES}-byte limit`)); } else chunks.push(c);
      });
      res.on('end', () => finish(resolve, { url: u.href, status: res.statusCode, contentType: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => finish(reject, upstream(`read failed: ${e.message}`)));
    });
    req.on('timeout', () => { finish(reject, upstream('timed out')); req.destroy(); });
    req.on('error', (e) => finish(reject, upstream(e.code === 'EPRIVATE' ? e.message : `could not reach ${u.host}: ${e.code || e.message}`)));
    req.end(payload);
  });
}

/** the production dependencies; tests pass fakes with the same two signatures */
const defaultDeps = () => ({ get, post, now: Date.now });

module.exports = { get, post, defaultDeps, USER_AGENT, MAX_BYTES, MAX_TIMEOUT_MS };

// lib/safe-fetch.js — fetch a caller-supplied URL without letting it reach the box (R5 B1).
//
// http and https only, ports 80 and 443 only; every hostname is resolved and refused if ANY of
// its addresses is private, loopback, link-local, CGNAT, multicast, reserved or cloud metadata
// (169.254.169.254, fd00:ec2::254), and the check runs inside the socket's own DNS lookup, so a
// rebinding answer cannot slip between the check and the connect. Redirects are followed by
// hand, at most 3, each one re-checked. 10 s for the whole fetch, a byte cap per call, and the
// content type must be one the caller accepts.
'use strict';
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });

function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}
// IPv6 -> eight 16-bit groups. The URL parser rewrites [::ffff:127.0.0.1] as [::ffff:7f00:1], and
// node connects to an IP literal without a DNS lookup, so a string match on the dotted form let
// mapped loopback and metadata addresses through (found in R5 review). Compare numbers instead.
function v6Groups(ip) {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) { const [a, b, c, d] = tail[1].split('.').map(Number); s = s.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16); }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : []; const t = rest != null && rest !== '' ? rest.split(':') : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const g = [...h, ...Array(fill).fill('0'), ...t].map((x) => parseInt(x, 16));
  return g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null;
}
const v4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
function isPrivate(ip) {
  if (net.isIPv4(ip)) return v4Private(ip);
  const g = v6Groups(ip);
  if (!g) return true; // unparseable: refuse
  const zero = (n) => g.slice(0, n).every((x) => x === 0);
  if (zero(8) || (zero(7) && g[7] === 1)) return true;                  // :: and ::1
  if (zero(5) && g[5] === 0xffff) return v4Private(v4Of(g[6], g[7]));  // ::ffff:a.b.c.d mapped
  if (zero(6)) return true;                                             // ::a.b.c.d compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;                    // 64:ff9b::/32 NAT64, embeds IPv4
  if (g[0] === 0x2002) return true;                                     // 6to4, embeds IPv4
  if (g[0] === 0x2001 && g[1] === 0) return true;                       // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;                   // documentation
  if (g[0] === 0x100 && zero(4)) return true;                           // discard 100::/64
  if ((g[0] & 0xfe00) === 0xfc00) return true;                          // fc00::/7 unique local (incl. fd00:ec2::254)
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return true;                          // multicast
  return false;
}
function guardedLookup(host, opts, cb) {
  dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const blocked = addrs.find((a) => isPrivate(a.address));
    if (blocked) return cb(Object.assign(new Error(`refused: ${host} resolves to a private or reserved address`), { code: 'EPRIVATE' }));
    const pick = addrs.find((a) => a.family === 4) || addrs[0];
    if (opts && opts.all) return cb(null, [pick]);
    cb(null, pick.address, pick.family);
  });
}

function checkUrl(raw, { httpsOnly = false } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw bad(httpsOnly ? 'url must be an absolute https URL' : 'url must be an absolute http or https URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('only http and https URLs are fetched');
  if (httpsOnly && u.protocol !== 'https:') throw bad('only https URLs are fetched');
  if (u.port && u.port !== '80' && u.port !== '443') throw bad('only ports 80 and 443 are fetched');
  if (u.username || u.password) throw bad('URLs with credentials are refused');
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(h) && isPrivate(h)) throw bad('private, loopback and reserved addresses are refused');
  if (/^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(h)) throw bad('local hostnames are refused');
  return u;
}

function once(u, { userAgent, accept, deadline, method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, lookup: guardedLookup, headers: { ...headers, 'user-agent': userAgent, accept, 'accept-encoding': 'identity' },
      timeout: Math.max(1, deadline - Date.now()) }, (res) => resolve(res));
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/**
 * -> { url, status, contentType, headers, body } ; throws bad_request or 503 errors
 * R23 options, every one defaulting to the old behaviour: `httpsOnly` (an http URL, or a redirect to one, is refused), `method` ('GET' or 'HEAD'; a HEAD answer has an
 * empty body), `headers` (extra request headers; user-agent, accept and accept-encoding stay ours), and `acceptStatus(code) -> bool` (a 4xx or 5xx answer for which it
 * returns true is RETURNED with its headers and body instead of thrown, which is how the x402 lint reads a 402). The port, address, redirect, time and size rules apply to all.
 */
async function safeFetch(raw, { maxBytes, accept = '*/*', okTypes, timeoutMs = 10000, maxRedirects = 3, userAgent, httpsOnly = false, method = 'GET', headers = {}, acceptStatus } = {}) {
  let u = checkUrl(raw, { httpsOnly });
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; ; hop++) {
    let res;
    try { res = await once(u, { userAgent, accept, deadline, method, headers }); } catch (e) {
      if (e.code === 'EPRIVATE') throw bad(e.message);
      if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') throw bad(`${u.hostname} does not resolve`);
      throw unavailable(`could not fetch ${u.host}: ${e.code || e.message}`);
    }
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw unavailable(`more than ${maxRedirects} redirects`);
      u = checkUrl(new URL(res.headers.location, u).href, { httpsOnly });
      continue;
    }
    // the URL is the caller's input: a 4xx from it is a bad URL (400), a 5xx is the target down (503); neither bills
    const returned = res.statusCode >= 400 && typeof acceptStatus === 'function' && acceptStatus(res.statusCode);
    if (res.statusCode >= 400 && !returned) { res.resume(); throw (res.statusCode < 500 ? bad : unavailable)(`${u.host} answered HTTP ${res.statusCode}`); }
    const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (method === 'HEAD') { res.resume(); return { url: u.href, status: res.statusCode, contentType: type, headers: res.headers, body: Buffer.alloc(0) }; }
    if (!returned && okTypes && !okTypes.includes(type)) { res.resume(); throw bad(`content type ${type || 'missing'} is not ${okTypes.join(' or ')}`); }
    const len = Number(res.headers['content-length'] || 0);
    if (len > maxBytes) { res.resume(); throw bad(`document is ${len} bytes, over the ${maxBytes}-byte limit`); }
    const chunks = []; let size = 0;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { res.destroy(); reject(unavailable('timed out reading the document')); }, Math.max(1, deadline - Date.now()));
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { clearTimeout(t); res.destroy(); reject(bad(`document is over the ${maxBytes}-byte limit`)); } else chunks.push(c); });
      res.on('end', () => { clearTimeout(t); resolve(); });
      res.on('error', (e) => { clearTimeout(t); reject(unavailable(`read failed: ${e.message}`)); });
    });
    return { url: u.href, status: res.statusCode, contentType: type, headers: res.headers, body: Buffer.concat(chunks) };
  }
}

module.exports = { safeFetch, isPrivate, checkUrl, guardedLookup };

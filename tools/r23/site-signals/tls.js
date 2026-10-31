// tools/r23/site-signals/tls.js: read the TLS certificate of one host (R23 T6).
// One handshake to port 443 through lib/safe-fetch.js's guardedLookup (the socket's own DNS lookup refuses a private, loopback, link-local or metadata address, so the
// check cannot be aimed at the box). rejectUnauthorized is false ONLY so that the certificate of a site with a bad one can be read and reported (authorized: false and
// the reason); nothing is ever written to the socket, so no HTTP request goes over it, and it is destroyed the moment the certificate is read.
'use strict';
const tls = require('tls');
const net = require('net');
const { guardedLookup } = require('../../../lib/safe-fetch');

const DAY = 86400e3;
const TLS_TIMEOUT_MS = 6000;
const SAN_CAP = 20;
const CHAIN_CAP = 10;
const one = (x) => (Array.isArray(x) ? x[0] : x);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** "DNS:a.example, DNS:b.example, IP Address:1.2.3.4" -> ["a.example", "b.example", "IP Address:1.2.3.4"] */
function splitSans(s) {
  if (!s) return [];
  return String(s).split(/,\s*(?=(?:DNS|IP Address|email|URI|othername|Registered ID):)/).map((x) => x.trim()).filter(Boolean).map((x) => (x.startsWith('DNS:') ? x.slice(4) : x));
}

/** the certificates Node could link from the leaf upward (the root may come from Node's own store, not from the server), stopping at a self-signed one or a repeat */
function chainOf(leaf) {
  const out = []; const seen = new Set();
  let cur = leaf; let rooted = false;
  while (cur && out.length < CHAIN_CAP) {
    const fp = cur.fingerprint256 || `#${out.length}`;
    if (seen.has(fp)) break;
    seen.add(fp); out.push(cur);
    const next = cur.issuerCertificate;
    if (!next || next === cur || (next.fingerprint256 && next.fingerprint256 === cur.fingerprint256)) { rooted = Boolean(next); break; }
    cur = next;
  }
  return { certs: out, rooted };
}

/** pure: Node's detailed peer certificate and the socket's facts -> the `tls` section */
function describeCert({ cert, protocol, cipher, authorized, authorizationError, now = Date.now() }) {
  const subj = cert.subject || {}; const iss = cert.issuer || {};
  const from = Date.parse(cert.valid_from); const to = Date.parse(cert.valid_to);
  const sans = splitSans(cert.subjectaltname);
  const { certs, rooted } = chainOf(cert);
  return {
    ok: true,
    protocol: protocol || null,
    cipher: (cipher && cipher.name) || null,
    authorized: authorized === true,
    authorization_error: authorized === true ? null : String(authorizationError || 'unknown').slice(0, 100),
    issuer: { organization: one(iss.O) || null, common_name: one(iss.CN) || null, country: one(iss.C) || null },
    subject: { common_name: one(subj.CN) || null },
    sans: { count: sans.length, names: sans.slice(0, SAN_CAP), truncated: sans.length > SAN_CAP },
    valid_from: iso(from),
    valid_to: iso(to),
    age_days: Number.isFinite(from) ? Math.floor((now - from) / DAY) : null,
    days_left: Number.isFinite(to) ? Math.floor((to - now) / DAY) : null,
    expired: Number.isFinite(to) ? to < now : null,
    chain: { length: certs.length, subjects: certs.slice(0, 6).map((c) => one((c.subject || {}).CN) || one((c.subject || {}).O) || null), ends_in_self_signed_root: rooted, self_signed: certs.length === 1 && rooted },
    key: { type: cert.asn1Curve ? 'EC' : cert.modulus ? 'RSA' : null, bits: cert.bits == null ? null : Number(cert.bits), curve: cert.nistCurve || cert.asn1Curve || null },
    serial_number: cert.serialNumber || null,
    fingerprint_sha256: cert.fingerprint256 || null,
  };
}

/**
 * -> the `tls` section: describeCert(...) or { ok: false, reason }. `_code` (EPRIVATE and friends) is for the caller and is removed before the answer is sent.
 * opts: connect (tls.connect), lookup (guardedLookup), port (443; a test server listens elsewhere), timeoutMs, now.
 */
function probeTls(host, opts = {}) {
  const { connect = tls.connect, lookup = guardedLookup, port = 443, timeoutMs = TLS_TIMEOUT_MS, now = Date.now } = opts;
  return new Promise((resolve) => {
    let done = false; let sock = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { if (sock) sock.destroy(); } catch { /* already closed */ } resolve(v); };
    const timer = setTimeout(() => finish({ ok: false, reason: 'TLS handshake timed out', _code: 'ETIMEDOUT' }), timeoutMs);
    const fail = (e) => {
      const code = e && e.code;
      if (code === 'EPRIVATE') return finish({ ok: false, reason: 'refused: the host resolves to a private or reserved address', _code: 'EPRIVATE' });
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return finish({ ok: false, reason: 'the host name does not resolve', _code: code });
      return finish({ ok: false, reason: `TLS handshake failed (${String(code || (e && e.message) || 'error').slice(0, 80)})`, _code: code || 'ERR' });
    };
    try {
      const o = { host, port, lookup, rejectUnauthorized: false, timeout: timeoutMs };
      if (!net.isIP(host)) o.servername = host;
      sock = connect(o, () => {
        try {
          const cert = sock.getPeerCertificate(true);
          if (!cert || !cert.valid_to) return finish({ ok: false, reason: 'the server presented no certificate', _code: 'NOCERT' });
          finish(describeCert({ cert, protocol: sock.getProtocol(), cipher: sock.getCipher(), authorized: sock.authorized, authorizationError: sock.authorizationError, now: now() }));
        } catch (e) { fail(e); }
      });
      sock.on('error', fail);
      sock.on('timeout', () => finish({ ok: false, reason: 'TLS handshake timed out', _code: 'ETIMEDOUT' }));
    } catch (e) { fail(e); }
  });
}

module.exports = { probeTls, describeCert, splitSans, chainOf, TLS_TIMEOUT_MS };

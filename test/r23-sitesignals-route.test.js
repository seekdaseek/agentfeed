// R23 T6, /api/site-signals: the route logic, offline. Every refusal on the url (http, credentials, port, private IP literal, a name that resolves to a private address through a
// stubbed dns.lookup, a redirect to a private address, more than 3 redirects, oversize, timeout), the partial-answer rules (a dead section says why while the others answer, and a site
// that cannot be reached at all is a 503 "Not charged", never a charged empty answer), a self-signed certificate on a real local TLS server, the concurrency and section limits, and the
// route entry's text. No test reaches the network: the real safe-fetch is driven through a stubbed https.request and dns.lookup, TLS through a local server and an injected lookup.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tlsLib = require('tls');
const https = require('https');
const dnsLib = require('dns');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');
const SSM = require('../tools/r23/site-signals');
// R23_SITESIGNALS_RDAP is read when the module loads; create(env) builds either state. SS is the ON state, which is what this file's tests were written against (and which must stay
// unchanged); OFF is the shipped state (the default: the variable unset).
const SS = { ...SSM, ...SSM.create({ R23_SITESIGNALS_RDAP: 'on' }) };
const OFF = { ...SSM, ...SSM.create({}) };
const { probeTls, describeCert } = require('../tools/r23/site-signals/tls');
const { describeDns } = require('../tools/r23/site-signals/dns');
const { describeDomain } = require('../tools/r23/site-signals/rdap');
const { RUBRIC } = require('../tools/r23/site-signals/rubric');
const EX = require('../tools/r23/site-signals/example');

const GOOD = 'https://www.example.com/';
const kind = async (p) => { try { await p; return 'no error'; } catch (e) { return e.kind === 'bad_request' ? 'bad_request' : e.status === 503 ? 'unavailable' : `other: ${e.message}`; } };

/** a complete set of fakes that answer like a healthy site, recording every call; `over` replaces any of them */
function fakes(over = {}) {
  const calls = [];
  const d = {
    now: () => EX.NOW,
    lookup: async (host) => { calls.push(['lookup', host]); return [{ address: '93.184.216.34', family: 4 }]; },
    probeTls: async (host) => { calls.push(['tls', host]); return describeCert({ cert: EX.CERT, ...EX.SOCKET, now: EX.NOW }); },
    fetchPage: async (url) => { calls.push(['page', url]); return { url, status: 200, contentType: 'text/html', headers: EX.HEADERS, body: Buffer.from(EX.HTML) }; },
    dnsSignals: async (host) => { calls.push(['dns', host]); return describeDns(EX.DNS_RAW); },
    rdap: { lookup: async (zone) => { calls.push(['rdap', zone]); return describeDomain(EX.RDAP, zone, { server: 'rdap.registry.example', now: EX.NOW }); } },
    ...over,
  };
  return { d, calls };
}
const none = (calls) => assert.deepEqual(calls, [], `no lookup, handshake, fetch, DNS or registry call was made (${JSON.stringify(calls)})`);

// ======================================================================================================== the url
test('url: a good URL is accepted (known positive); case, trailing dot, path and query do not change the host; an internationalised name is its ASCII form', () => {
  assert.equal(SS.parseSiteUrl(GOOD).hostname, 'www.example.com');
  assert.equal(SS.parseSiteUrl('HTTPS://WWW.Example.COM/Path?q=1#f').hostname, 'www.example.com');
  assert.equal(SS.parseSiteUrl('https://www.example.com.:443/x').hostname, 'www.example.com.');
  assert.equal(SS.parseSiteUrl('https://bücher.example.de/').hostname, 'xn--bcher-kva.example.de');
});

test('url: every refusal is a 400 (bad_request) thrown before ANY lookup, handshake, fetch, DNS or registry call', async () => {
  const refused = {
    'missing': undefined, 'empty': '', 'blank': '   ', 'two values': ['https://a.example.com/', 'https://b.example.com/'],
    'http': 'http://www.example.com/', 'ftp': 'ftp://www.example.com/', 'file': 'file:///etc/passwd', 'javascript': 'javascript:alert(1)', 'no scheme': 'www.example.com', 'not a URL': 'https://',
    'credentials': 'https://user:pw@www.example.com/', 'user only': 'https://user@www.example.com/',
    'port 8443': 'https://www.example.com:8443/', 'port 80 on https': 'https://www.example.com:80/', 'port 22': 'https://www.example.com:22/',
    'loopback': 'https://127.0.0.1/', '10/8': 'https://10.0.0.1/', '192.168/16': 'https://192.168.1.1/', '172.16/12': 'https://172.16.5.5/', 'metadata': 'https://169.254.169.254/latest/meta-data/',
    'CGNAT': 'https://100.64.0.1/', 'any': 'https://0.0.0.0/', 'decimal loopback': 'https://2130706433/', 'hex loopback': 'https://0x7f.1/', 'ipv6 loopback': 'https://[::1]/',
    'ipv4-mapped loopback': 'https://[::ffff:127.0.0.1]/', 'ipv6 unique local': 'https://[fd00:ec2::254]/',
    'public ipv4 literal': 'https://93.184.216.34/', 'public ipv6 literal': 'https://[2606:4700:4700::1111]/',
    'localhost': 'https://localhost/', '.local': 'https://printer.local/', '.internal': 'https://db.internal/', 'metadata name': 'https://metadata.google.internal/', 'single label': 'https://intranet/',
    'bad last label': 'https://host.1a/', 'unknown single label': 'https://corpweb/', 'unknown single label 2': 'https://wiki/', '.test': 'https://site.test/', '.example': 'https://site.example/', '.onion': 'https://abcdefghij.onion/', '.arpa': 'https://1.0.0.127.in-addr.arpa/', 'numeric TLD': 'https://host.123/',
    'too long': `https://www.example.com/${'a'.repeat(2100)}`,
  };
  const { d, calls } = fakes();
  const wrong = [];
  for (const [what, url] of Object.entries(refused)) if (await kind(SS.getSiteSignals({ url }, d)) !== 'bad_request') wrong.push(what);
  assert.deepEqual(wrong, []);
  none(calls);
  // negative control: take away the https-only option and the same http URL is accepted by the lib check (the option is what refuses it)
  assert.equal(require('../lib/safe-fetch').checkUrl('http://www.example.com/', {}).protocol, 'http:');
  // and the route's own port rule is the only thing that refuses :80 on https (the lib allows 80 and 443)
  assert.equal(require('../lib/safe-fetch').checkUrl('https://www.example.com:80/', { httpsOnly: true }).port, '80');
});

test('url: a host name that resolves to a private address is a 400 and nothing else runs; ANY private address among several is enough (control: a public answer proceeds)', async () => {
  for (const addrs of [[{ address: '10.1.2.3', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.9', family: 4 }], [{ address: '::1', family: 6 }], [{ address: 'fd00:ec2::254', family: 6 }], [{ address: '169.254.169.254', family: 4 }]]) {
    const { d, calls } = fakes({ lookup: async (h) => { calls.push(['lookup', h]); return addrs; } });
    assert.equal(await kind(SS.getSiteSignals({ url: GOOD }, d)), 'bad_request', JSON.stringify(addrs));
    assert.deepEqual(calls, [['lookup', 'www.example.com']], 'only the lookup ran');
  }
  const ok = fakes();
  const r = await SS.getSiteSignals({ url: GOOD }, ok.d);
  assert.equal(r.tls.ok, true);
  assert.deepEqual(ok.calls.map((c) => c[0]).sort(), ['dns', 'lookup', 'page', 'rdap', 'tls']);
});

test('url: a host that does not resolve is a 503 "Not charged" with Retry-After and nothing else runs, never a charged empty answer; so are a failing resolver and an empty answer', async () => {
  for (const [what, make] of [
    ['ENOTFOUND', () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))],
    ['ENODATA', () => Promise.reject(Object.assign(new Error('x'), { code: 'ENODATA' }))],
    ['EAI_AGAIN', () => Promise.reject(Object.assign(new Error('x'), { code: 'EAI_AGAIN' }))],
    ['no code', () => Promise.reject(new Error('resolver down'))],
    ['empty list', () => Promise.resolve([])],
  ]) {
    const { d, calls } = fakes({ lookup: async (h) => { calls.push(['lookup', h]); return make(); } });
    let err = null;
    try { await SS.getSiteSignals({ url: GOOD }, d); } catch (e) { err = e; }
    assert.ok(err, what);
    assert.equal(err.status, 503, what);
    assert.notEqual(err.kind, 'bad_request');
    assert.match(err.message, /Not charged\.$/, what);
    assert.ok(err.retryAfter >= 1, what);
    assert.deepEqual(calls, [['lookup', 'www.example.com']], `${what}: only the lookup ran`);
  }
});

// ======================================================================================================== the answer and its partial forms
test('answer: a healthy site gives every section, in order, with fetched_at and method; the url is reported without its query or fragment', async () => {
  const { d } = fakes();
  const r = await SS.getSiteSignals({ url: 'https://www.example.com/p?token=SECRET#frag' }, d);
  assert.deepEqual(Object.keys(r), ['url', 'host', 'page', 'tls', 'domain', 'dns', 'headers', 'stack', 'links', 'fetched_at', 'method']);
  assert.equal(r.url, 'https://www.example.com/p');
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  for (const s of ['page', 'tls', 'domain', 'dns', 'headers', 'links']) assert.equal(r[s].ok, true, s);
  assert.ok(Array.isArray(r.stack) && r.stack.length > 0);
  assert.equal(r.fetched_at, new Date(EX.NOW).toISOString());
  assert.equal(r.method, SS.METHOD);
  assert.equal(JSON.stringify(r).includes('_code'), false, 'no internal field leaks');
  // the example is the same builders over the same fixtures: for the example host the live path and the constructed example agree
  const clean = await SS.getSiteSignals({ url: GOOD }, fakes().d);
  assert.deepEqual(JSON.parse(JSON.stringify(clean)), JSON.parse(JSON.stringify(SS.buildExample())));
});

test('answer: TLS fails while the page works -> 200 with tls ok: false and a reason, the other sections answer', async () => {
  const { d } = fakes({ probeTls: async () => ({ ok: false, reason: 'TLS handshake failed (ECONNRESET)', _code: 'ECONNRESET' }) });
  const r = await SS.getSiteSignals({ url: GOOD }, d);
  assert.deepEqual(r.tls, { ok: false, reason: 'TLS handshake failed (ECONNRESET)' });
  assert.equal(r.page.ok, true);
  assert.equal(r.headers.ok, true);
  assert.ok(r.dns.ok && r.domain.ok);
});

test('answer: the page fails while TLS works -> 200 with page, headers and links ok: false (stack empty) and the reason; TLS, DNS and registry answer', async () => {
  const { d } = fakes({ fetchPage: async () => { throw Object.assign(new Error('could not fetch www.example.com: ECONNRESET'), { status: 503 }); } });
  const r = await SS.getSiteSignals({ url: GOOD }, d);
  assert.equal(r.page.ok, false);
  assert.match(r.page.reason, /ECONNRESET/);
  assert.equal(r.headers.ok, false);
  assert.equal(r.links.ok, false);
  assert.deepEqual(r.stack, []);
  assert.equal(r.tls.ok, true);
  assert.ok(r.dns.ok && r.domain.ok);
});

test('answer: TLS and the page both fail -> 503 "Not charged" naming both reasons; DNS and registry results do not make a charged answer', async () => {
  const { d } = fakes({ probeTls: async () => ({ ok: false, reason: 'TLS handshake failed (ECONNREFUSED)', _code: 'ECONNREFUSED' }), fetchPage: async () => { throw new Error('could not fetch www.example.com: ECONNREFUSED'); } });
  let err = null;
  try { await SS.getSiteSignals({ url: GOOD }, d); } catch (e) { err = e; }
  assert.equal(err.status, 503);
  assert.match(err.message, /could not reach www\.example\.com .*TLS handshake failed \(ECONNREFUSED\).*page: could not fetch/);
  assert.match(err.message, /Not charged\.$/);
  // control: either one alone is an answer
  const onlyTls = fakes({ fetchPage: d.fetchPage });
  assert.equal((await SS.getSiteSignals({ url: GOOD }, onlyTls.d)).tls.ok, true);
});

test('answer: DNS failing, DNS throwing, a TLD without RDAP and a non-HTML response each degrade only their own sections', async () => {
  const dnsDown = await SS.getSiteSignals({ url: GOOD }, fakes({ dnsSignals: async () => ({ ok: false, reason: 'DNS queries failed (A www.example.com: ETIMEOUT)' }) }).d);
  assert.equal(dnsDown.dns.ok, false);
  assert.equal(dnsDown.domain.ok, true, 'the registry is asked for the last two labels');
  assert.equal(dnsDown.tls.ok && dnsDown.page.ok, true);
  const dnsBoom = await SS.getSiteSignals({ url: GOOD }, fakes({ dnsSignals: async () => { throw new Error('resolver exploded'); } }).d);
  assert.equal(dnsBoom.dns.ok, false);
  assert.match(dnsBoom.dns.reason, /resolver exploded/);
  assert.equal(dnsBoom.domain.ok, false);
  assert.equal(dnsBoom.domain.registration, null);
  assert.equal(dnsBoom.tls.ok, true);
  const noRdap = await SS.getSiteSignals({ url: GOOD }, fakes({ rdap: { lookup: async (z) => require('../tools/r23/site-signals/rdap').emptyDomain(z, 'no RDAP service is listed for .io in the IANA bootstrap') } }).d);
  assert.equal(noRdap.domain.ok, false);
  assert.match(noRdap.domain.reason, /\.io/);
  assert.equal(noRdap.domain.registration, null);
  assert.equal(noRdap.tls.ok && noRdap.dns.ok && noRdap.headers.ok, true);
  const json = await SS.getSiteSignals({ url: GOOD }, fakes({ fetchPage: async (url) => ({ url, status: 200, contentType: 'application/json', headers: { server: 'nginx/1.25.3', 'content-type': 'application/json' }, body: Buffer.from('{"a":1}') }) }).d);
  assert.equal(json.page.html, false);
  assert.equal(json.links.ok, false);
  assert.match(json.links.reason, /not HTML/);
  assert.equal(json.stack[0].name, 'nginx', 'the stack still reads the headers');
  assert.equal(json.headers.ok, true);
});

test('answer: an HTTP error status is a page that was reached (graded and reported with its status), a redirect to another host says so, and no query reaches the answer', async () => {
  const r403 = await SS.getSiteSignals({ url: GOOD }, fakes({ fetchPage: async (url) => ({ url, status: 403, contentType: 'text/html', headers: { server: 'cloudflare', 'cf-ray': 'x' }, body: Buffer.from('<html>blocked</html>') }) }).d);
  assert.equal(r403.page.status, 403);
  assert.equal(r403.page.ok, true);
  assert.equal(r403.headers.ok, true);
  assert.ok(r403.stack.some((s) => s.name === 'Cloudflare'));
  const moved = await SS.getSiteSignals({ url: GOOD }, fakes({ fetchPage: async () => ({ url: 'https://other.example.org/landing?session=SECRET2', status: 200, contentType: 'text/html', headers: EX.HEADERS, body: Buffer.from(EX.HTML) }) }).d);
  assert.equal(moved.page.redirected, true);
  assert.equal(moved.page.host_changed, true);
  assert.equal(moved.page.final_url, 'https://other.example.org/landing');
  assert.ok(!JSON.stringify(moved).includes('SECRET2'));
  const same = await SS.getSiteSignals({ url: GOOD }, fakes().d);
  assert.deepEqual([same.page.redirected, same.page.host_changed], [false, false], 'control');
});

test('answer: the host turning private after the up-front check (rebinding) is a 400; a redirect to a private host is a partial answer whose page says it was refused', async () => {
  const hostPriv = fakes({ probeTls: async () => ({ ok: false, reason: 'refused: the host resolves to a private or reserved address', _code: 'EPRIVATE' }) });
  assert.equal(await kind(SS.getSiteSignals({ url: GOOD }, hostPriv.d)), 'bad_request');
  const pagePriv = fakes({ fetchPage: async () => { throw Object.assign(new Error('refused: www.example.com resolves to a private or reserved address'), { kind: 'bad_request' }); } });
  assert.equal(await kind(SS.getSiteSignals({ url: GOOD }, pagePriv.d)), 'bad_request');
  const redirPriv = fakes({ fetchPage: async () => { throw Object.assign(new Error('refused: internal.victim.example resolves to a private or reserved address'), { kind: 'bad_request' }); } });
  const r = await SS.getSiteSignals({ url: GOOD }, redirPriv.d);
  assert.equal(r.page.ok, false);
  assert.match(r.page.reason, /refused: internal\.victim\.example/);
  assert.equal(r.tls.ok, true);
});

test('analysePage: html is recognised by type, or by the first bytes when the type is missing; an unreadable page degrades to a page failure rather than an exception', async () => {
  const mk = (contentType, body) => SS.analysePage({ url: GOOD, status: 200, contentType, headers: {}, body: Buffer.from(body) }, 'www.example.com', GOOD);
  assert.equal(mk('text/html', '<p>x</p>').page.html, true);
  assert.equal(mk('application/xhtml+xml', '<p>x</p>').page.html, true);
  assert.equal(mk('', '<!DOCTYPE html><html></html>').page.html, true);
  assert.equal(mk('', 'plain text').page.html, false);
  assert.equal(mk('text/plain', '<html>').page.html, false);
  assert.equal(mk('text/html', '').page.bytes, 0);
  const r = await SS.getSiteSignals({ url: GOOD }, fakes({ fetchPage: async () => ({ url: GOOD, status: 200, contentType: 'text/html', headers: {}, body: null }) }).d);
  assert.equal(r.page.ok, false);
  assert.match(r.page.reason, /could not be read/);
  assert.equal(r.tls.ok, true);
});

// ======================================================================================================== the page fetch through the real safe-fetch (stubbed transport)
const realRequest = https.request;
const realLookup = dnsLib.lookup;
function fakeRes(status, headers = {}, body = '') {
  const r = body instanceof Readable ? body : Readable.from(body === '' ? [] : [Buffer.from(body)]);
  r.statusCode = status; r.headers = headers;
  return r;
}
/** replace https.request: script(url, opts) -> fake response | Error | 'real' (hand the request to the real https.request, whose lookup is guardedLookup) | 'timeout' */
function stubHttps(script) {
  const calls = [];
  https.request = (u, opts, cb) => {
    const href = String(u.href || u);
    calls.push(href);
    const out = script(new URL(href), opts, calls.length);
    if (out === 'real') return realRequest(u, opts, cb);
    const req = new EventEmitter();
    req.destroy = (e) => req.emit('error', e);
    req.end = () => setImmediate(() => { if (out === 'timeout') req.emit('timeout'); else if (out instanceof Error) req.emit('error', out); else cb(out); });
    return req;
  };
  return { calls, restore() { https.request = realRequest; } };
}
function stubDnsLookup(map) {
  const seen = [];
  dnsLib.lookup = (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    seen.push(host);
    const a = map[host];
    if (!a) return cb(Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
    cb(null, a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
  return { seen, restore() { dnsLib.lookup = realLookup; } };
}
/** the route with every dependency faked EXCEPT the page fetch, which is the real safe-fetch */
const withRealFetch = () => { const { d } = fakes(); delete d.fetchPage; return d; };
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', server: 'nginx' };

test('page fetch, real safe-fetch: control, a healthy page is read (headers, status, final url)', async () => {
  const net1 = stubHttps(() => fakeRes(200, HTML_HEADERS, EX.HTML));
  try {
    const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
    assert.equal(r.page.ok, true);
    assert.equal(r.page.status, 200);
    assert.deepEqual(net1.calls, [GOOD]);
    assert.ok(r.links.emails.length === 1);
  } finally { net1.restore(); }
});

test('page fetch, real safe-fetch: a redirect to plain http is refused (https only) and the http URL is never requested; a redirect to https is followed (control)', async () => {
  const bad1 = stubHttps((u) => (u.protocol === 'https:' && u.pathname === '/' ? fakeRes(301, { location: 'http://www.example.com/insecure' }) : fakeRes(200, HTML_HEADERS, '<p>x</p>')));
  try {
    const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
    assert.equal(r.page.ok, false);
    assert.match(r.page.reason, /only https URLs are fetched/);
    assert.deepEqual(bad1.calls, [GOOD], 'the insecure target was not requested');
    assert.equal(r.tls.ok, true);
  } finally { bad1.restore(); }
  const good = stubHttps((u) => (u.pathname === '/' ? fakeRes(301, { location: '/moved' }) : fakeRes(200, HTML_HEADERS, '<p>x</p>')));
  try {
    const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
    assert.equal(r.page.ok, true);
    assert.equal(r.page.final_url, 'https://www.example.com/moved');
    assert.equal(r.page.redirected, true);
    assert.equal(good.calls.length, 2);
  } finally { good.restore(); }
});

test('page fetch, real safe-fetch: a redirect to a private IP literal is refused before any request to it', async () => {
  for (const target of ['https://127.0.0.1/admin', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://10.0.0.5:443/', 'https://localhost/']) {
    const s = stubHttps((u) => (u.pathname === '/' ? fakeRes(302, { location: target }) : fakeRes(200, HTML_HEADERS, 'SHOULD NOT BE REACHED')));
    try {
      const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
      assert.equal(r.page.ok, false, target);
      assert.match(r.page.reason, /private|local/i, target);
      assert.deepEqual(s.calls, [GOOD], `${target}: only the first request was made`);
    } finally { s.restore(); }
  }
});

test('page fetch, real safe-fetch: a redirect to a NAME that resolves to a private address is refused by the socket\'s own lookup (stubbed dns.lookup), and no connection is opened to it', async () => {
  const dnsStub = stubDnsLookup({ 'www.example.com': ['93.184.216.34'], 'internal.victim.example': ['10.0.0.5'], 'mixed.victim.example': ['93.184.216.34', '192.168.1.10'] });
  for (const host of ['internal.victim.example', 'mixed.victim.example']) {
    const s = stubHttps((u) => (u.hostname === 'www.example.com' ? fakeRes(302, { location: `https://${host}/x` }) : 'real'));
    try {
      const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
      assert.equal(r.page.ok, false, host);
      assert.match(r.page.reason, new RegExp(`refused: ${host.replace(/\./g, '\\.')} resolves to a private or reserved address`));
      assert.ok(dnsStub.seen.includes(host), 'the guard looked the name up');
    } finally { s.restore(); }
  }
  // control: the same redirect to a name that resolves to a PUBLIC address is followed (the guard is what refused the others)
  const s2 = stubHttps((u) => (u.hostname === 'www.example.com' ? fakeRes(302, { location: 'https://other.victim.example/x' }) : fakeRes(200, HTML_HEADERS, '<p>x</p>')));
  try { assert.equal((await SS.getSiteSignals({ url: GOOD }, withRealFetch())).page.ok, true); } finally { s2.restore(); dnsStub.restore(); }
});

test('page fetch, real safe-fetch: more than 3 redirects is refused; exactly 3 is followed (control)', async () => {
  const loop = stubHttps((u, _o, n) => fakeRes(302, { location: `/hop${n}` }));
  try {
    const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
    assert.equal(r.page.ok, false);
    assert.match(r.page.reason, /more than 3 redirects/);
    assert.equal(loop.calls.length, 4, 'the first request and three redirects, then it stopped');
  } finally { loop.restore(); }
  const three = stubHttps((u, _o, n) => (n <= 3 ? fakeRes(302, { location: `/hop${n}` }) : fakeRes(200, HTML_HEADERS, '<p>x</p>')));
  try {
    const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
    assert.equal(r.page.ok, true);
    assert.equal(three.calls.length, 4);
  } finally { three.restore(); }
});

test('page fetch, real safe-fetch: a document over 5 MB is refused by its declared length and by its streamed length (control: just under is read)', async () => {
  const declared = stubHttps(() => fakeRes(200, { ...HTML_HEADERS, 'content-length': String(SS.MAX_BYTES + 1) }, '<p>x</p>'));
  try {
    const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
    assert.equal(r.page.ok, false);
    assert.match(r.page.reason, /over the 5242880-byte limit/);
    assert.equal(r.tls.ok, true);
  } finally { declared.restore(); }
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const streamed = stubHttps(() => fakeRes(200, HTML_HEADERS, Readable.from(Array.from({ length: 6 }, () => chunk))));
  try {
    const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
    assert.equal(r.page.ok, false);
    assert.match(r.page.reason, /over the 5242880-byte limit/);
  } finally { streamed.restore(); }
  const under = stubHttps(() => fakeRes(200, HTML_HEADERS, Readable.from(Array.from({ length: 4 }, () => chunk))));
  try {
    const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
    assert.equal(r.page.ok, true);
    assert.equal(r.page.bytes, 4 * 1024 * 1024);
  } finally { under.restore(); }
});

test('page fetch, real safe-fetch: a socket timeout and a refused connection are page failures with a reason (TLS still answers); if TLS fails too it is a 503', async () => {
  for (const [what, out, want] of [['timeout', 'timeout', /ETIMEDOUT/], ['refused', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), /ECONNREFUSED/]]) {
    const s = stubHttps(() => out);
    try {
      const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
      assert.equal(r.page.ok, false, what);
      assert.match(r.page.reason, want, what);
      assert.equal(r.tls.ok, true);
      const d2 = withRealFetch(); d2.probeTls = async () => ({ ok: false, reason: 'TLS handshake timed out', _code: 'ETIMEDOUT' });
      assert.equal(await kind(SS.getSiteSignals({ url: GOOD }, d2)), 'unavailable', `${what} + TLS down`);
    } finally { s.restore(); }
  }
});

test('page fetch, real safe-fetch: 4xx and 5xx responses are returned with their headers and status (the old behaviour threw), not turned into failures', async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const s = stubHttps(() => fakeRes(status, { ...HTML_HEADERS, 'x-content-type-options': 'nosniff' }, '<p>x</p>'));
    try {
      const r = await SS.getSiteSignals({ url: GOOD }, withRealFetch());
      assert.equal(r.page.ok, true, String(status));
      assert.equal(r.page.status, status);
      assert.equal(r.headers.findings.find((f) => f.id === 'nosniff').level, 'full');
    } finally { s.restore(); }
  }
});

// ======================================================================================================== the section clock and the concurrency limit
test('sections: a hanging section is cut at its limit and the others answer; everything hanging is a 503 within the limit', async () => {
  const hang = () => new Promise(() => {});
  const t0 = Date.now();
  const tlsHang = await SS.getSiteSignals({ url: GOOD }, { ...fakes().d, probeTls: hang, sectionMs: 60 });
  assert.equal(tlsHang.tls.ok, false);
  assert.match(tlsHang.tls.reason, /timed out/);
  assert.equal(tlsHang.page.ok, true);
  const dnsHang = await SS.getSiteSignals({ url: GOOD }, { ...fakes().d, dnsSignals: hang, sectionMs: 60 });
  assert.equal(dnsHang.dns.ok, false);
  assert.equal(dnsHang.domain.ok, false);
  assert.equal(dnsHang.tls.ok, true);
  const pageHang = await SS.getSiteSignals({ url: GOOD }, { ...fakes().d, fetchPage: hang, sectionMs: 60 });
  assert.equal(pageHang.page.ok, false);
  assert.match(pageHang.page.reason, /timed out/);
  assert.equal(await kind(SS.getSiteSignals({ url: GOOD }, { ...fakes().d, probeTls: hang, fetchPage: hang, sectionMs: 60 })), 'unavailable');
  assert.ok(Date.now() - t0 < 3000);
});

test('concurrency: past R23_SITESIGNALS_CONCURRENCY a call is a 503 "Not charged" at once (no lookup), the counter returns to zero after every call, success or failure', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = fakes({ fetchPage: async (url) => { await gate; return { url, status: 200, contentType: 'text/html', headers: EX.HEADERS, body: Buffer.from(EX.HTML) }; } });
  const env = { R23_SITESIGNALS_CONCURRENCY: '1' };
  const first = SS.getSiteSignals({ url: GOOD }, { ...slow.d, env });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(SS._inflight(), 1);
  const second = fakes();
  let err = null;
  try { await SS.getSiteSignals({ url: GOOD }, { ...second.d, env }); } catch (e) { err = e; }
  assert.equal(err.status, 503);
  assert.match(err.message, /too many site checks/);
  assert.match(err.message, /Not charged\.$/);
  none(second.calls);
  release();
  assert.equal((await first).page.ok, true);
  assert.equal(SS._inflight(), 0);
  assert.equal((await SS.getSiteSignals({ url: GOOD }, { ...fakes().d, env })).tls.ok, true, 'control: with the slot free the call runs');
  await kind(SS.getSiteSignals({ url: 'http://www.example.com/' }, fakes().d));
  await kind(SS.getSiteSignals({ url: GOOD }, fakes({ lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } }).d));
  assert.equal(SS._inflight(), 0, 'a refusal or a 503 gives its slot back');
});

// ======================================================================================================== TLS against a real local server
let tmp; let key; let crt;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitesignals-tls-'));
  key = path.join(tmp, 'k.pem'); crt = path.join(tmp, 'c.pem');
  // a throw-away self-signed certificate for CN=localhost, generated for this run and deleted after it
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-subj', '/CN=localhost/O=Fixture Self Signed', '-days', '30'], { stdio: 'ignore' });
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

function tlsServer(extra = {}) {
  const stats = { connections: 0, secure: 0, bytes: 0 };
  const srv = tlsLib.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt), ...extra }, (c) => { stats.secure++; c.on('data', (b) => { stats.bytes += b.length; }); c.on('error', () => {}); });
  srv.on('connection', () => { stats.connections++; });
  srv.on('tlsClientError', () => {});
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, stats, close: () => new Promise((x) => srv.close(x)) })));
}
const loopbackLookup = (_host, opts, cb) => (opts && opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('tls, real handshake against a self-signed server: the certificate is read and reported unauthorised, nothing is ever sent over the socket, and the connection is dropped', async () => {
  const s = await tlsServer({ maxVersion: 'TLSv1.2' });       // TLS 1.2: the server has finished its side of the handshake before the client\'s secureConnect, so "no bytes" is a real observation
  try {
    const t = await probeTls('localhost', { port: s.port, lookup: loopbackLookup, timeoutMs: 3000 });
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(t.authorized, false);
    assert.equal(t.authorization_error, 'DEPTH_ZERO_SELF_SIGNED_CERT');
    assert.equal(t.subject.common_name, 'localhost');
    assert.equal(t.issuer.common_name, 'localhost');
    assert.equal(t.issuer.organization, 'Fixture Self Signed');
    assert.deepEqual([t.chain.length, t.chain.self_signed], [1, true]);
    assert.equal(t.key.type, 'RSA');
    assert.equal(t.key.bits, 2048);
    assert.equal(t.protocol, 'TLSv1.2');
    assert.ok(t.cipher);
    assert.ok(t.days_left >= 29 && t.days_left <= 30, String(t.days_left));
    assert.equal(t.expired, false);
    await settle();
    assert.equal(s.stats.secure, 1, 'one completed handshake');
    assert.equal(s.stats.bytes, 0, 'not one byte of application data was sent: no HTTP request over that socket');
    // the observation is real: a client that DOES write after the handshake is counted by the same server
    await new Promise((resolve) => { const c = tlsLib.connect({ host: '127.0.0.1', port: s.port, rejectUnauthorized: false }, () => { c.write('GET / HTTP/1.1\r\n\r\n'); setTimeout(() => { c.destroy(); resolve(); }, 100); }); c.on('error', resolve); });
    assert.ok(s.stats.bytes > 0, 'control: the server counts bytes that are sent');
  } finally { await s.close(); }
});

test('tls: the default lookup is the guard, so a name that resolves to loopback is refused before any connection; a refusal to connect, a non-TLS server and a silent server are failures with reasons', async () => {
  const s = await tlsServer();
  try {
    const refused = await probeTls('localhost', { port: s.port, timeoutMs: 2000 });      // default lookup: guardedLookup (refuses 127.0.0.1)
    assert.equal(refused.ok, false);
    assert.equal(refused._code, 'EPRIVATE');
    assert.match(refused.reason, /private or reserved/);
    await settle();
    assert.equal(s.stats.connections, 0, 'no TCP connection was opened to the loopback server');
    // known-positive control for that assertion: with the loopback lookup injected, the same server DOES see a connection
    await probeTls('localhost', { port: s.port, lookup: loopbackLookup, timeoutMs: 3000 });
    await settle();
    assert.equal(s.stats.connections, 1);
  } finally { await s.close(); }
  // nothing listening
  const free = await new Promise((r) => { const x = net.createServer(); x.listen(0, '127.0.0.1', () => { const p = x.address().port; x.close(() => r(p)); }); });
  const closed = await probeTls('localhost', { port: free, lookup: loopbackLookup, timeoutMs: 2000 });
  assert.equal(closed.ok, false);
  assert.match(closed.reason, /TLS handshake failed \(ECONNREFUSED\)/);
  // a server that is not TLS (answers plain text then closes)
  const plain = net.createServer((c) => { c.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  const notTls = await probeTls('localhost', { port: plain.address().port, lookup: loopbackLookup, timeoutMs: 2000 });
  assert.equal(notTls.ok, false);
  assert.match(notTls.reason, /TLS handshake failed/);
  plain.close();
  // a server that accepts the connection and never speaks: the handshake times out
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  const quiet = await probeTls('localhost', { port: silent.address().port, lookup: loopbackLookup, timeoutMs: 200 });
  assert.equal(quiet.ok, false);
  assert.match(quiet.reason, /timed out/);
  assert.ok(Date.now() - t0 < 2000);
  silent.close();
});

test('tls: a handshake that never completes is cut by the probe\'s own timer even when the socket never reports idleness (a slow drip would defeat the socket timeout)', async () => {
  const sock = new EventEmitter();
  let destroyed = 0;
  sock.destroy = () => { destroyed++; };
  const t0 = Date.now();
  const r = await probeTls('www.example.com', { connect: () => sock, timeoutMs: 80 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/);
  assert.equal(r._code, 'ETIMEDOUT');
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(destroyed, 1);
});

test('tls, fake socket: no write is ever made, the socket is destroyed once, the server name is set for a host name and left out for an address; "no certificate" and a throw inside the handshake callback are failures', async () => {
  const mkSock = (certObj) => {
    const sock = new EventEmitter();
    sock.writes = 0; sock.destroys = 0;
    sock.write = () => { sock.writes++; return true; }; sock.end = () => { sock.writes++; };
    sock.destroy = () => { sock.destroys++; };
    sock.getPeerCertificate = () => certObj; sock.getProtocol = () => 'TLSv1.3'; sock.getCipher = () => ({ name: 'TLS_AES_256_GCM_SHA384' }); sock.authorized = true; sock.authorizationError = null;
    return sock;
  };
  let opts = null; let sock = null;
  const connect = (o, cb) => { opts = o; sock = mkSock(EX.CERT); setImmediate(cb); return sock; };
  const t = await probeTls('www.example.com', { connect, now: () => EX.NOW });
  assert.equal(t.ok, true);
  assert.equal(sock.writes, 0);
  assert.equal(sock.destroys, 1);
  assert.equal(opts.servername, 'www.example.com');
  assert.equal(opts.port, 443, 'the default port is 443');
  assert.equal(opts.rejectUnauthorized, false);
  assert.equal(typeof opts.lookup, 'function');
  assert.equal(opts.lookup, require('../lib/safe-fetch').guardedLookup, 'the default lookup is lib/safe-fetch guardedLookup');
  await probeTls('203.0.113.7', { connect, now: () => EX.NOW });
  assert.equal('servername' in opts, false, 'no server name for an IP address');
  const noCert = await probeTls('www.example.com', { connect: (o, cb) => { sock = mkSock({}); setImmediate(cb); return sock; } });
  assert.equal(noCert.ok, false);
  assert.match(noCert.reason, /no certificate/);
  const boom = await probeTls('www.example.com', { connect: (o, cb) => { sock = mkSock(EX.CERT); sock.getProtocol = () => { throw new Error('socket exploded'); }; setImmediate(cb); return sock; } });
  assert.equal(boom.ok, false);
  assert.match(boom.reason, /socket exploded/);
  const throws = await probeTls('www.example.com', { connect: () => { throw new Error('cannot start'); } });
  assert.equal(throws.ok, false);
  // the check itself: a probe that DID write would be caught by the same assertion (negative control for the 'no write' check)
  const writer = (o, cb) => { sock = mkSock(EX.CERT); setImmediate(() => { sock.write('GET / HTTP/1.1\r\n\r\n'); cb(); }); return sock; };
  await probeTls('www.example.com', { connect: writer, now: () => EX.NOW });
  assert.equal(sock.writes, 1, 'the counter does count a write');
});

test('route over the self-signed server: the answer carries the certificate as unauthorised while the page, which needs a valid certificate, fails with its reason; the TLS probe is called with the host only (never a port)', async () => {
  const s = await tlsServer();
  try {
    const seen = [];
    const { d } = fakes({ probeTls: (host, o) => { seen.push(Object.keys(o).sort()); return probeTls(host, { ...o, port: s.port, lookup: loopbackLookup, timeoutMs: 3000 }); },
      fetchPage: async () => { throw Object.assign(new Error('could not fetch www.example.com: DEPTH_ZERO_SELF_SIGNED_CERT'), { status: 503 }); } });
    const r = await SS.getSiteSignals({ url: 'https://localhost.example.com/' }, d);
    assert.equal(r.tls.ok, true);
    assert.equal(r.tls.authorized, false);
    assert.equal(r.tls.authorization_error, 'DEPTH_ZERO_SELF_SIGNED_CERT');
    assert.equal(r.page.ok, false);
    assert.match(r.page.reason, /SELF_SIGNED/);
    assert.deepEqual(seen, [['now']], 'the route passes the clock and nothing else');
  } finally { await s.close(); }
});

// ======================================================================================================== the route entry and its text
const CUSTOMER_TEXT = () => {
  const e = SS.entries[0];
  const refusals = [];
  return [e.desc, e.title, e.question, ...Object.values(e.schema).map((z) => z.description), JSON.stringify(e.example), SS.METHOD, ...refusals];
};

test('entry: the shape the lead wires into expansion.js', () => {
  assert.equal(SS.entries.length, 1);
  const e = SS.entries[0];
  assert.deepEqual(Object.keys(e).sort(), ['desc', 'example', 'name', 'question', 'route', 'run', 'schema', 'tags', 'title', 'usd']);
  assert.equal(e.name, 'get_site_signals');
  assert.equal(e.route, 'GET /api/site-signals');
  assert.equal(e.usd, 0.02);
  assert.ok(!e.route.includes(':'), 'no path parameter');
  assert.deepEqual(Object.keys(e.schema), ['url']);
  assert.ok(e.desc.startsWith('Use when an agent needs'));
  assert.ok(e.desc.length >= 180 && e.desc.length <= 255, `desc is ${e.desc.length} characters`);
  assert.match(e.desc, /503/);
  assert.match(e.desc, /not charged/);
  assert.ok(e.desc.includes(`over ${RUBRIC.rules.length} checks`), 'the count in the text is the rubric\'s own');
  assert.ok(e.tags.length >= 3 && e.tags.every((t) => t === t.toLowerCase() && /^[a-z0-9-]+$/.test(t)));
  assert.ok(e.title.length <= 40);
  assert.ok(e.question.endsWith('?') && !e.question.slice(0, -1).includes('?'));
  assert.equal(typeof e.run, 'function');
  assert.equal(e.schema.url.safeParse('https://www.example.com/').success, true);
  assert.equal(e.schema.url.safeParse(undefined).success, false);
  assert.deepEqual(JSON.parse(JSON.stringify(e.example)), e.example, 'the example is plain JSON');
});

test('entry: customer-facing text carries no verdict word, advice, "since <date>", promise, or person\'s name; the example holds no registrant data', async () => {
  const forbidden = /\b(safe|unsafe|trusted|untrusted|trustworthy|scam\w*|phish\w*|fraud\w*|legit\w*|malicious|rug\w*|guarantee\w*|buy|sell|hold|invest\w*|trade|trading)\b|since\s+(?:\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
  const texts = CUSTOMER_TEXT();
  // every refusal a caller can see
  const msgs = [];
  for (const url of ['http://a.example.com/', 'https://u:p@a.example.com/', 'https://a.example.com:81/', 'https://127.0.0.1/', 'https://a.example.com.test/', '']) { try { SS.parseSiteUrl(url); } catch (e) { msgs.push(e.message); } }
  for (const code of ['ENOTFOUND', 'EAI_AGAIN']) { try { await SS.getSiteSignals({ url: GOOD }, fakes({ lookup: async () => { throw Object.assign(new Error('x'), { code }); } }).d); } catch (e) { msgs.push(e.message); } }
  try { await SS.getSiteSignals({ url: GOOD }, fakes({ probeTls: async () => ({ ok: false, reason: 'TLS handshake timed out' }), fetchPage: async () => { throw new Error('could not fetch x: ETIMEDOUT'); } }).d); } catch (e) { msgs.push(e.message); }
  assert.ok(msgs.length >= 8);
  const bad = [...texts, ...msgs].filter((t) => forbidden.test(String(t)));
  assert.deepEqual(bad.map((t) => String(t).slice(0, 80)), []);
  // control: the pattern does match the words it is meant to catch
  for (const w of ['this site is safe', 'a trusted site', 'looks like a scam', 'phishing page', 'a rug pull', 'guaranteed', 'you should buy', 'registered since 2001', 'sell it']) assert.match(w, forbidden, w);
  const ex = JSON.stringify(SS.entries[0].example);
  assert.ok(!/registrant|Private Person|contact/i.test(ex.replace(/contact and social/i, '')) || !ex.includes('registrant'), 'no registrant record in the example');
});

// ======================================================================================================== registration data is a switch, default off
const BANNED_OFF = /\b(rdap|whois|registrar|registrant|registration|registered|expiry|domain[ _-]age|days_to_expiry)\b/i;

test('switch: registration data is on only when R23_SITESIGNALS_RDAP is exactly "on"; every other value, and no value, is off', () => {
  for (const v of ['on']) assert.equal(SSM.create({ R23_SITESIGNALS_RDAP: v }).rdapEnabled, true, v);
  for (const v of [undefined, '', 'off', 'ON', 'On', 'true', '1', ' on', 'on ', 'yes', 'enabled', 'rdap']) assert.equal(SSM.create(v === undefined ? {} : { R23_SITESIGNALS_RDAP: v }).rdapEnabled, false, JSON.stringify(v));
  assert.equal(SSM.rdapOn(undefined), false);
  assert.equal(SSM.rdapOn({ R23_SITESIGNALS_RDAP: 'on' }), true);
  // the module's own exports are the state of the environment it was loaded in (the test process has no such variable)
  assert.equal(SSM.rdapEnabled, process.env.R23_SITESIGNALS_RDAP === 'on');
});

test('off: the answer has no domain section, and not one request goes to IANA or a registry through the real default path; the same input with the switch ON does request (negative control)', async () => {
  const iana = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'r23', 'sitesignals', 'bootstrap.json'), 'utf8'));
  const script = (u) => (u.hostname === 'data.iana.org' ? fakeRes(200, { 'content-type': 'application/json' }, JSON.stringify(iana))
    : u.hostname === 'rdap.registry.example' ? fakeRes(200, { 'content-type': 'application/rdap+json' }, JSON.stringify(EX.RDAP)) : fakeRes(404, {}, ''));
  const noRdapDep = () => { const { d } = fakes(); delete d.rdap; return d; };          // the real, un-injected registry client
  const seenFetch = [];
  const realFetch = global.fetch;
  global.fetch = async (...a) => { seenFetch.push(String(a[0])); throw new Error('no fetch here'); };
  const off = stubHttps(script);
  try {
    const r = await OFF.getSiteSignals({ url: GOOD }, noRdapDep());
    assert.equal('domain' in r, false);
    assert.deepEqual(Object.keys(r), ['url', 'host', 'page', 'tls', 'dns', 'headers', 'stack', 'links', 'fetched_at', 'method']);
    assert.deepEqual(off.calls, [], 'no request of any kind');
    assert.deepEqual(seenFetch, []);
    // the registry client refuses on its own too, whatever calls it
    assert.equal((await require('../tools/r23/site-signals/rdap').makeRdap({ env: {} }).lookup('example.com')).ok, false);
    assert.deepEqual(off.calls, []);
  } finally { off.restore(); }
  const on = stubHttps(script);
  try {
    const r = await SSM.create({ R23_SITESIGNALS_RDAP: 'on' }).getSiteSignals({ url: GOOD }, noRdapDep());
    assert.equal(r.domain.ok, true, JSON.stringify(r.domain));
    assert.deepEqual(on.calls, ['https://data.iana.org/rdap/dns.json', 'https://rdap.registry.example/com/v1/domain/example.com'], 'the same input asks IANA and the registry');
  } finally { on.restore(); global.fetch = realFetch; }
});

test('off: nothing is asked of the registry client even when one is injected, and a dead DNS section still leaves no domain key', async () => {
  const { d, calls } = fakes();
  const r = await OFF.getSiteSignals({ url: GOOD }, d);
  assert.equal(calls.filter((c) => c[0] === 'rdap').length, 0);
  assert.equal('domain' in r, false);
  const dnsDown = fakes({ dnsSignals: async () => ({ ok: false, reason: 'DNS queries failed (A www.example.com: ETIMEOUT)' }) });
  const r2 = await OFF.getSiteSignals({ url: GOOD }, dnsDown.d);
  assert.equal('domain' in r2, false);
  assert.equal(dnsDown.calls.filter((c) => c[0] === 'rdap').length, 0);
  const dnsHang = await OFF.getSiteSignals({ url: GOOD }, { ...fakes().d, dnsSignals: () => new Promise(() => {}), sectionMs: 50 });
  assert.equal('domain' in dnsHang, false);
  assert.match(dnsHang.dns.reason, /DNS lookups timed out/);
  assert.doesNotMatch(dnsHang.dns.reason, BANNED_OFF);
  // control: ON, the same calls do ask the registry client
  const on = fakes();
  await SS.getSiteSignals({ url: GOOD }, on.d);
  assert.equal(on.calls.filter((c) => c[0] === 'rdap').length, 1);
});

test('off: the route entry, its question and tags, the method string, the example and an answer carry none of the registration words; the ON text does (known-positive check of the pattern) and is unchanged', async () => {
  const texts = (m) => { const e = m.entries[0]; return [e.desc, e.title, e.question, e.tags.join(' '), ...Object.values(e.schema).map((z) => z.description), JSON.stringify(e.example), m.METHOD]; };
  const off = texts(OFF);
  assert.deepEqual(off.filter((t) => BANNED_OFF.test(t)), [], 'off text');
  const ans = await OFF.getSiteSignals({ url: GOOD }, fakes().d);
  assert.doesNotMatch(JSON.stringify(ans), BANNED_OFF);
  assert.deepEqual(Object.keys(OFF.entries[0].example), ['url', 'host', 'page', 'tls', 'dns', 'headers', 'stack', 'links', 'fetched_at', 'method']);
  const e = OFF.entries[0];
  assert.ok(e.desc.startsWith('Use when an agent needs'));
  assert.ok(e.desc.length >= 180 && e.desc.length <= 255, `off desc is ${e.desc.length} characters`);
  assert.match(e.desc, /503/);
  assert.match(e.desc, /not charged/);
  assert.ok(e.desc.includes(`over ${RUBRIC.rules.length} checks`));
  assert.ok(e.question.endsWith('?') && !e.question.slice(0, -1).includes('?'));
  assert.ok(e.tags.length >= 3 && e.tags.every((t) => /^[a-z0-9-]+$/.test(t)));
  // known positive: the same pattern DOES match the ON text, field by field where the state differs
  const on = texts(SS);
  assert.ok(BANNED_OFF.test(on[0]) && BANNED_OFF.test(on[2]) && BANNED_OFF.test(on[3]) && BANNED_OFF.test(on[5]) && BANNED_OFF.test(on[6]), 'desc, question, tags, example and method of the ON state all match');
  // the ON state is what it was: the text pinned here is the text shipped before the switch existed
  assert.equal(SS.entries[0].desc, `Use when an agent needs the technical facts of one website. Returns its TLS certificate, domain age and expiry, DNS records, a security-header grade over ${RUBRIC.rules.length} checks, tech stack and social links. A bad URL (400) or unreachable site (503) is not charged.`);
  assert.equal(SS.entries[0].question, "What do one website's TLS certificate, domain registration, DNS records, security headers, technology markers and contact links show?");
  assert.deepEqual(SS.entries[0].tags, ['website', 'tls', 'certificate', 'dns', 'rdap', 'domain-age', 'security-headers', 'tech-stack', 'infrastructure']);
  assert.match(SS.METHOD, /name-server, mail, text and CAA records from its registered domain\. Domain: RDAP from the registry the IANA bootstrap lists for the TLD\. Page: one GET/);
  assert.deepEqual(Object.keys(SS.entries[0].example), ['url', 'host', 'page', 'tls', 'domain', 'dns', 'headers', 'stack', 'links', 'fetched_at', 'method']);
  // the two states differ ONLY by the registration words: the shared text is the same
  assert.equal(OFF.entries[0].name, SS.entries[0].name);
  assert.equal(OFF.entries[0].usd, SS.entries[0].usd);
  assert.deepEqual(OFF.entries[0].schema.url.description, SS.entries[0].schema.url.description);
  assert.deepEqual(SS.entries[0].example.tls, OFF.entries[0].example.tls);
  assert.deepEqual(SS.entries[0].example.dns, OFF.entries[0].example.dns);
});

test('off: the shipped (default) module is off, and every refusal and partial rule of the route is the same in both states', async () => {
  assert.equal(SSM.rdapEnabled, false, 'the test process has no R23_SITESIGNALS_RDAP, so the module exports are the OFF state');
  assert.equal('domain' in SSM.entries[0].example, false);
  for (const M of [OFF, SS]) {
    assert.equal(await kind(M.getSiteSignals({ url: 'http://www.example.com/' }, fakes().d)), 'bad_request');
    assert.equal(await kind(M.getSiteSignals({ url: GOOD }, fakes({ lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } }).d)), 'unavailable');
    assert.equal(await kind(M.getSiteSignals({ url: GOOD }, fakes({ probeTls: async () => ({ ok: false, reason: 'x' }), fetchPage: async () => { throw new Error('y'); } }).d)), 'unavailable');
    const partial = await M.getSiteSignals({ url: GOOD }, fakes({ probeTls: async () => ({ ok: false, reason: 'TLS handshake failed (ECONNRESET)', _code: 'ECONNRESET' }) }).d);
    assert.equal(partial.tls.ok, false);
    assert.equal(partial.page.ok, true);
  }
});

test('entry: run() is the route handler: it returns the answer, and a bad URL is the same 400 (bad_request) the wrapper maps', async () => {
  const e = SS.entries[0];
  assert.equal(await kind(e.run({})), 'bad_request');
  assert.equal(await kind(e.run({ url: 'http://x.example.com/' })), 'bad_request');
  assert.equal(await kind(e.run(undefined)), 'bad_request');
});

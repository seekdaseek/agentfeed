// test/fixtures/r23/sitesignals/preload.cjs: preloaded (NODE_OPTIONS=--require) into the REAL server.js that test/helpers/real-server.js boots, for test/r23-sitesignals-real-server.test.js.
// The route is the real one: expansion.js mounts tools/r23/index.js, titles, questions and the Bazaar entry are the repo's, and the module runs with its REAL dependencies (its own DNS
// client, TLS probe, safe-fetch and registry client). This file mounts NOTHING and registers NOTHING. It only stubs the transports underneath that module, and only for the hosts
// of the fixtures; any other host reaches the harness's own preload (test/helpers/af-test-preload.js), which refuses it and writes it to $AF_NET_LOG:
//   dns.lookup          (the module's up-front resolution AND lib/safe-fetch's guardedLookup, which the stubbed sockets still call, so a private answer is refused there too)
//   tls.connect         (the module's certificate probe: a fake socket that records any write)
//   https.request       (lib/safe-fetch: the page fetch, and the two registry URLs below)
//   dns.promises.Resolver  (the module's A, AAAA, CNAME, NS, MX, TXT and CAA queries)
// Fixture hosts (exact names):
//   ok.example.com           healthy site                         -> 200
//   nocert.example.com       the TLS handshake is reset, the page works -> 200, partial
//   gone.example.com         does not resolve (ENOTFOUND)         -> 503 Not charged
//   down.example.com         resolves; TLS and the page both refuse the connection -> 503 Not charged
//   private.example.com      resolves to 10.9.8.7                 -> 400
// Registry (only if the route's switch is on): exactly https://data.iana.org/rdap/dns.json and https://rdap.registry.example/com/v1/domain/example.com.
// Everything the stubs see is appended to $SS_STUB_LOG: LOOKUP <host>, TLS <host>, TLSWRITE <host> (never expected), PAGE <url>, RDAP <url>.
// This file is loaded before AND after the harness preload depending on how node orders -r, so the stubs are installed on setImmediate, after both have run.
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const ROOT = process.env.AF_ROOT;
const LOG = process.env.SS_STUB_LOG;
const NET_LOG = process.env.AF_NET_LOG;
const note = (file, line) => { if (file) { try { fs.appendFileSync(file, `${line}\n`); } catch { /* best effort */ } } };

const HOSTS = { 'ok.example.com': 'ok', 'nocert.example.com': 'nocert', 'gone.example.com': 'gone', 'down.example.com': 'down', 'private.example.com': 'private' };
const scenario = (h) => HOSTS[String(h || '').toLowerCase()];

function install() {
  const dns = require('dns');
  const tls = require('tls');
  const https = require('https');
  const EX = require(path.join(ROOT, 'tools', 'r23', 'site-signals', 'example'));

  // ---- dns.lookup
  const realLookup = dns.lookup;
  dns.lookup = function (host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const sc = scenario(host);
    if (!sc) return realLookup.apply(this, arguments);                      // a real host: the harness refuses it and logs it
    note(LOG, `LOOKUP ${host}`);
    setImmediate(() => {
      if (sc === 'gone') return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
      const address = sc === 'private' ? '10.9.8.7' : '93.184.216.34';
      return opts && opts.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4);
    });
    return undefined;
  };
  // what a real socket does first: resolve through the caller's own lookup (lib/safe-fetch's guardedLookup), so its private-address refusal runs
  const resolveVia = (o, host, done) => (typeof o.lookup === 'function' ? o.lookup(host, { all: true }, (err) => done(err)) : done(null));

  // ---- tls.connect
  const realConnect = tls.connect;
  tls.connect = function (o, cb) {
    const host = o && o.host;
    const sc = scenario(host);
    if (!sc) return realConnect.apply(this, arguments);
    note(LOG, `TLS ${host}`);
    const sock = new EventEmitter();
    sock.authorized = EX.SOCKET.authorized; sock.authorizationError = EX.SOCKET.authorizationError;
    sock.getPeerCertificate = () => EX.CERT;
    sock.getProtocol = () => EX.SOCKET.protocol;
    sock.getCipher = () => EX.SOCKET.cipher;
    sock.write = () => { note(LOG, `TLSWRITE ${host}`); return true; };
    sock.end = sock.write;
    sock.destroy = () => {};
    setImmediate(() => resolveVia(o, host, (err) => {
      if (err) return sock.emit('error', err);
      if (sc === 'nocert') return sock.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      if (sc === 'down') return sock.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      return cb.call(sock);
    }));
    return sock;
  };

  // ---- https.request (the page fetch and the two registry URLs)
  const BOOTSTRAP = JSON.stringify({ version: '1.0', services: [[['com'], ['https://rdap.registry.example/com/v1/']]] });
  const REGISTRY = {
    'https://data.iana.org/rdap/dns.json': { type: 'application/json', body: BOOTSTRAP },
    'https://rdap.registry.example/com/v1/domain/example.com': { type: 'application/rdap+json', body: JSON.stringify(EX.RDAP) },
  };
  const realRequest = https.request;
  https.request = function (u, opts, cb) {
    const url = u instanceof URL ? u : new URL(typeof u === 'string' ? u : u.href || `https://${u.host}${u.path || '/'}`);
    const reg = REGISTRY[url.href];
    const sc = scenario(url.hostname);
    if (!reg && !sc) return realRequest.apply(this, arguments);              // a real host: the harness refuses it
    const req = new EventEmitter();
    req.destroy = (e) => { if (e) setImmediate(() => req.emit('error', e)); };
    req.setTimeout = () => req;
    req.end = () => {
      note(LOG, reg ? `RDAP ${url.href}` : `PAGE ${url.href}`);
      // the registry URLs are answered by exact URL (the RDAP client's transport); a page host is resolved through the caller's own lookup first, as a real socket would
      (reg ? (o, h, done) => done(null) : resolveVia)(opts || {}, url.hostname, (err) => {
        if (err) return setImmediate(() => req.emit('error', err));
        if (!reg && sc === 'down') return setImmediate(() => req.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })));
        const body = reg ? reg.body : EX.HTML;
        const res = Readable.from([Buffer.from(body)]);
        res.statusCode = 200;
        res.headers = reg ? { 'content-type': reg.type } : { ...EX.HEADERS, 'content-type': 'text/html; charset=utf-8' };
        return setImmediate(() => cb(res));
      });
    };
    return req;
  };

  // ---- dns.promises.Resolver (the module's record queries): only the fixture names are answered, anything else is refused and logged like the harness does
  const RealResolver = dns.promises.Resolver;
  const nothing = () => { throw Object.assign(new Error('queryX ENODATA'), { code: 'ENODATA' }); };
  const D = EX.DNS_RAW;
  const answer = {
    resolveNs: (n) => (n === 'example.com' ? D.ns : nothing()),
    resolve4: (n) => (scenario(n) ? D.a : nothing()),
    resolve6: (n) => (scenario(n) ? D.aaaa : nothing()),
    resolveCname: () => nothing(),
    resolveMx: (n) => (n === 'example.com' ? D.mx : nothing()),
    resolveTxt: (n) => (n === 'example.com' ? D.txt : n === '_dmarc.example.com' ? D.dmarcTxt : nothing()),
    resolveCaa: (n) => (n === 'example.com' ? D.caaZone : nothing()),
  };
  class StubResolver extends RealResolver {}
  for (const [method, fn] of Object.entries(answer)) {
    StubResolver.prototype[method] = async function (name) {
      const n = String(name).toLowerCase();
      if (!(scenario(n) || n === 'example.com' || n === '_dmarc.example.com')) {
        note(NET_LOG, n);
        throw Object.assign(new Error(`af-test-preload: lookup of ${n} refused`), { code: 'ECONNREFUSED' });
      }
      note(LOG, `DNS ${method} ${n}`);
      return fn(n);
    };
  }
  dns.promises.Resolver = StubResolver;
}

// after server.js has loaded and the harness preload has patched the same functions: wrap what is there
setImmediate(install);

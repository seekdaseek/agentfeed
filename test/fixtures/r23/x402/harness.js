// test/fixtures/r23/x402/harness.js: run lib/safe-fetch.js for REAL against a local server (R23 T3 tests, 31 Oct 2026).
// The real guard refuses loopback, so a local mock cannot be reached directly (by design). This harness keeps every line of the guard and moves only the last step:
//   - dns.lookup answers a *.test name with a public-looking address (203.0.113.9), or with 10.1.2.3 for a name that starts with "rebind", so guardedLookup runs for real on it;
//   - net.Socket.prototype.connect wraps the lookup the guard installed: AFTER the guard has approved the address, the connection goes to 127.0.0.1 and the mock port instead.
// The guard decides exactly as in production (a private answer is refused before any connection); only an address it approved is redirected to the mock.
// tlsServer() makes a throwaway self-signed certificate with the openssl command line in a temp directory at run time (nothing is committed), for the https-only paid path.
'use strict';
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FAKE_PUBLIC = '203.0.113.9';

function install() {
  const target = { http: 0, https: 0 };
  const realLookup = dns.lookup; const realConnect = net.Socket.prototype.connect;
  dns.lookup = function (host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (/\.test$/.test(host)) {
      const ip = /^rebind/.test(host) ? '10.1.2.3' : FAKE_PUBLIC;
      return opts && opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4);
    }
    return realLookup.call(dns, host, opts, cb);
  };
  net.Socket.prototype.connect = function (...args) {
    // node hands connect() either the options object or the normalised [options, callback] array; the options are changed in place
    const o = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (o && typeof o === 'object' && typeof o.host === 'string' && o.host.endsWith('.test') && typeof o.lookup === 'function') {
      const guard = o.lookup; const port = Number(o.port) === 443 ? target.https : target.http;
      o.port = port;
      o.lookup = (host, lo, cb) => guard(host, lo, (err, addr, fam) => {
        if (err) return cb(err);
        if (Array.isArray(addr)) return cb(null, addr.map((a) => ({ ...a, address: '127.0.0.1', family: 4 })));
        return cb(null, '127.0.0.1', fam || 4);
      });
    }
    return realConnect.apply(this, args);
  };
  return {
    target,
    restore() { dns.lookup = realLookup; net.Socket.prototype.connect = realConnect; },
  };
}

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function stop(server) { return new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => resolve()); }); }

/** a plain http server for the port-80 side; handler(req, res) */
async function httpServer(h, ctx) { const s = http.createServer(h); ctx.target.http = await listen(s); return s; }

/** an https server for the port-443 side with a throwaway certificate, trusted by https.globalAgent for the run. -> server or null when openssl is missing */
async function tlsServer(h, ctx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402tls-'));
  const key = path.join(dir, 'k.pem'); const crt = path.join(dir, 'c.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=seller.test', '-addext', 'subjectAltName=DNS:seller.test,DNS:elsewhere.test'], { encoding: 'utf8' });
  if (r.status !== 0) { fs.rmSync(dir, { recursive: true, force: true }); return null; }
  const cert = fs.readFileSync(crt);
  const s = https.createServer({ key: fs.readFileSync(key), cert }, h);
  fs.rmSync(dir, { recursive: true, force: true });
  ctx.target.https = await listen(s);
  const prev = https.globalAgent.options.ca;
  https.globalAgent.options.ca = [cert];
  s.restoreCa = () => { if (prev === undefined) delete https.globalAgent.options.ca; else https.globalAgent.options.ca = prev; };
  return s;
}

/** turn a seller script (fixtures/seller.js) into a node request handler: the script sees (URL, { method, headers }) and answers { status, headers, body } or an Error */
function handlerFor(script, scheme) {
  return async (req, res) => {
    const host = req.headers.host || 'seller.test';
    const u = new URL(`${scheme}://${host}${req.url}`);
    const out = await script(u, { method: req.method, headers: req.headers });
    if (out instanceof Error) { req.socket.destroy(); return; }
    const chunks = []; for await (const c of out) chunks.push(c);
    res.writeHead(out.statusCode, out.headers); res.end(req.method === 'HEAD' ? undefined : Buffer.concat(chunks));
  };
}

module.exports = { install, httpServer, tlsServer, stop, handlerFor, FAKE_PUBLIC };

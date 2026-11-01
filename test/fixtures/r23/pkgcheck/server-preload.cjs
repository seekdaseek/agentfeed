// test/fixtures/r23/pkgcheck/server-preload.cjs: preloaded (NODE_OPTIONS=--require) into the REAL server.js that test/helpers/real-server.js boots, for test/r23-pkgcheck-real-server.test.js.
// The route is the repo's own: expansion.js -> tools/r24/index.js -> tools/r23/pkg-check.js, with its REAL dependencies (lib/safe-fetch.js, the OSV POST helper, the bundled lists). This file
// mounts NOTHING and registers NOTHING (no EXP, PRICES_ADD, TAGS_ADD, MCP_DEFS_ADD, titles or questions). It only puts the fake upstream of world.js behind a stubbed https.request, and only
// for the five hosts the tool calls:
//   registry.npmjs.org, api.npmjs.org, pypi.org, pypistats.org, api.osv.dev
// Any other host reaches the harness's own preload (test/helpers/af-test-preload.js), which refuses the connection and writes the host to $AF_NET_LOG. The stub does not depend on the
// order the two preloads run in: the harness patches sockets, DNS and fetch; this patches the https.request property.
// Every upstream call the tool makes is appended to $AF_PKG_LOG: `GET <url>` and `POST <url> <name>@<version>`.
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const ROOT = process.env.AF_ROOT;
const LOG = process.env.AF_PKG_LOG;
const log = (line) => { if (LOG) { try { fs.appendFileSync(LOG, `${line}\n`); } catch { /* best effort */ } } };
const HOSTS = new Set(['registry.npmjs.org', 'api.npmjs.org', 'pypi.org', 'pypistats.org', 'api.osv.dev']);

function install() {
  const W = require(path.join(ROOT, 'test', 'fixtures', 'r23', 'pkgcheck', 'world'));
  const down = { status: 503, body: {} };
  const world = W.makeWorld({
    extraGet: { 'https://registry.npmjs.org/example-osvdown': 'npm-widget.json' },
    getOverrides: { 'https://registry.npmjs.org/example-down': down, 'https://registry.npmjs.org/example-down/latest': down },
    osvOverride: (body) => (body.package.name === 'example-osvdown' ? { status: 500, body: {} } : undefined),
  });
  const https = require('https');
  const realRequest = https.request;
  const fakeRes = (r) => {
    const res = Readable.from(r.body.length ? [r.body] : []);
    res.statusCode = r.status;
    res.headers = { 'content-type': r.contentType || 'application/json', ...Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v])) };
    return res;
  };
  const stub = (u, opts, cb) => {
    const url = new URL(typeof u === 'string' ? u : u.href);
    const method = (opts && opts.method) || 'GET';
    const req = new EventEmitter();
    let payload = Buffer.alloc(0);
    let destroyed = false;
    const go = async () => {
      try {
        let r;
        if (method === 'POST') {
          const body = JSON.parse(payload.toString('utf8'));
          log(`POST ${url.href} ${body.package.name}@${body.version}`);
          r = await world.deps.post(url.href, body, {});
        } else {
          log(`GET ${url.href}`);
          r = await world.deps.get(url.href, {});
        }
        if (!destroyed && cb) cb(fakeRes(r));
      } catch (e) { if (!destroyed) req.emit('error', e); }
    };
    req.write = (chunk) => { payload = Buffer.concat([payload, Buffer.from(chunk)]); return true; };
    req.end = (chunk) => { if (chunk) req.write(chunk); setImmediate(go); return req; };
    req.destroy = (e) => { destroyed = true; if (e) req.emit('error', e); return req; };
    req.setTimeout = () => req;
    return req;
  };
  // only the five hosts are answered by the stub; any other request goes where it always went (and is refused by the harness's own preload)
  https.request = function (u) {
    let host = null;
    try { host = typeof u === 'string' ? new URL(u).hostname : (u && (u.hostname || u.host)) || null; } catch { host = null; }
    return host && HOSTS.has(String(host).toLowerCase()) ? stub.apply(this, arguments) : realRequest.apply(this, arguments);
  };
}

install();

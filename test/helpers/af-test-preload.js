// test/helpers/af-test-preload.js: preloaded (node --require) into the REAL server.js that test/helpers/real-server.js boots.
//   1. refuses every outbound connection that is not loopback and appends the attempt to $AF_NET_LOG (so a test can assert that an unpaid
//      request started no upstream work, which on the box is paid-for work: the page fetch before a Gemini call, an RPC read);
//   2. redirects a read-only database the box has under /opt and a dev machine does not to an empty scratch file, so server.js boots unmodified;
//   3. appends the tool name to $AF_HANDLER_LOG every time a route handler mounted behind lib/tool.js runs, a counter that does not depend on
//      the calls table or on the status the client saw.
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');
const Module = require('module');

const NET_LOG = process.env.AF_NET_LOG;
const HANDLER_LOG = process.env.AF_HANDLER_LOG;
const ROOT = process.env.AF_ROOT;
const note = (file, line) => { if (file) { try { fs.appendFileSync(file, line + '\n'); } catch { /* best effort */ } } };
const isLocal = (h) => !h || h === '127.0.0.1' || h === 'localhost' || h === '::1';

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let opts = args[0];
  let host;
  if (Array.isArray(opts)) opts = opts[0];
  if (typeof opts === 'object' && opts) host = opts.host || (opts.path ? 'unix' : undefined);
  else if (typeof opts === 'number') host = typeof args[1] === 'string' ? args[1] : '127.0.0.1';
  else if (typeof opts === 'string') host = 'unix';
  if (host !== 'unix' && !isLocal(host)) {
    note(NET_LOG, String(host));
    const s = this;
    process.nextTick(() => s.destroy(new Error(`af-test-preload: outbound to ${host} refused`)));
    return s;
  }
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (host, opts, cb) {
  if (typeof opts === 'function') cb = opts;
  if (isLocal(host)) return cb(null, '127.0.0.1', 4);
  note(NET_LOG, String(host));
  return cb(new Error(`af-test-preload: lookup of ${host} refused`));
};
void origLookup;
const origFetch = global.fetch;
global.fetch = async function (input, init) {
  const u = new URL(typeof input === 'string' ? input : input.url);
  if (!isLocal(u.hostname)) { note(NET_LOG, u.hostname); throw new TypeError('af-test-preload: fetch to ' + u.hostname + ' refused'); }
  return origFetch(input, init);
};

// A stray rejection from a handler (an upstream refused here, an empty scratch table) must not end the child: the tests assert on what ran,
// not on the process surviving. (Production keeps node's default.) Logged to stderr so the test output shows it.
process.on('unhandledRejection', (e) => { process.stderr.write(`[af-test-preload] unhandled rejection: ${e && e.message}\n`); });

const origLoad = Module._load;
let wrappedDb = null;
const TOOL_JS = ROOT ? path.join(ROOT, 'lib', 'tool.js') : null;
Module._load = function (request, parent) {
  const m = origLoad.apply(this, arguments);
  if (request === 'better-sqlite3' && !process.env.AF_NO_DB_REDIRECT) {   // R36: AF_NO_DB_REDIRECT=1 leaves a missing must-exist database missing, to prove the server boots without it
    if (!wrappedDb) {
      const Orig = m;
      wrappedDb = function Database(file, opts) {
        if (typeof file === 'string' && file !== ':memory:' && opts && opts.fileMustExist && !fs.existsSync(file)) {
          const alt = path.join(process.cwd(), 'redir-' + file.replace(/[^A-Za-z0-9.]/g, '_'));
          if (!fs.existsSync(alt)) { const d = new Orig(alt); d.close(); }
          const d = new Orig(alt, opts);
          const prep = d.prepare.bind(d);
          d.prepare = (sql) => { try { return prep(sql); } catch (e) { const fail = () => { throw e; }; return new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : fail) }); } };
          return d;
        }
        return new Orig(file, opts);
      };
      Object.setPrototypeOf(wrappedDb, Orig);
      wrappedDb.prototype = Orig.prototype;
    }
    return wrappedDb;
  }
  if (TOOL_JS && typeof request === 'string' && request.endsWith('tool') && m && typeof m.makeTool === 'function' && !m.__handlerCounted) {
    let file = null;
    try { file = Module._resolveFilename(request, parent); } catch { /* not ours */ }
    if (file === TOOL_JS) {
      const mk = m.makeTool;
      m.makeTool = (deps) => {
        const r = mk(deps);
        const t = r.tool;
        r.tool = (name, price, handler) => t(name, price, (...a) => { note(HANDLER_LOG, name); return handler(...a); });
        return r;
      };
      m.__handlerCounted = true;
    }
  }
  return m;
};

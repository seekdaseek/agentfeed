// test/helpers/box-dbs-scratch.js: `require` this FIRST in a test file that loads server code in-process (expansion.js, tools/overhang.js, ...) on a machine that is not the box.
//
// Some tool modules open a read-only database the box has under /opt (tools/overhang.js: /opt/overhang/overhang.db, new Database(path, { readonly, fileMustExist })) at require time.
// On the box the file exists; on a dev machine it does not, and the require throws "Cannot open database because the directory does not exist", so every test file that loads expansion.js
// died before its first test (R35, 14 Nov 2026: 21 of the 23 failures a clean checkout showed on the Mac; the R27 suite had been run on the box).
// This is the same redirect test/helpers/af-test-preload.js gives the child servers: a database that must exist and does not is replaced, for this process only, by an empty scratch file in
// a temp directory, and a statement the empty file cannot prepare (no such table) fails when it is USED, not when it is prepared at require time. A database that exists is opened as it is.
// Nothing under /opt is read or written, and the real tables are never faked: a test that needs rows still has to build them.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

if (!Module._load.__afBoxDbsScratch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-box-dbs-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
  const origLoad = Module._load;
  let wrapped = null;
  const load = function (request) {
    const m = origLoad.apply(this, arguments);
    if (request !== 'better-sqlite3') return m;
    if (!wrapped) {
      const Orig = m;
      wrapped = function Database(file, opts) {
        if (typeof file === 'string' && file !== ':memory:' && opts && opts.fileMustExist && !fs.existsSync(file)) {
          const alt = path.join(dir, 'redir-' + file.replace(/[^A-Za-z0-9.]/g, '_'));
          if (!fs.existsSync(alt)) { const d = new Orig(alt); d.close(); }
          const d = new Orig(alt, opts);
          const prep = d.prepare.bind(d);
          d.prepare = (sql) => { try { return prep(sql); } catch (e) { const fail = () => { throw e; }; return new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : fail) }); } };
          return d;
        }
        return new Orig(file, opts);
      };
      Object.setPrototypeOf(wrapped, Orig);
      wrapped.prototype = Orig.prototype;
    }
    return wrapped;
  };
  load.__afBoxDbsScratch = true;
  Module._load = load;
}

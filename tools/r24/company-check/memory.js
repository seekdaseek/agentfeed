// tools/r24/company-check/memory.js: bounding the garbage of a large streamed read (R24 item 5, v3). A filing is read in chunks that are new Buffers; each one is garbage as soon as it has been scanned, but V8 collects
// them late (it waits for tens of MB of "external" memory), so reading a 13 MB annual report left about 15 MB of resident memory behind that a collection would have freed. readFiling() therefore asks for a
// collection every COLLECT_EVERY bytes of ONE document (a document under that size never does). The collection function is global.gc when the process has it (node --expose-gc), else one obtained from V8
// once (v8.setFlagsFromString('--expose-gc') and vm.runInNewContext('gc')); R24_COMPANYCHECK_NO_GC=1 turns the whole thing off. A full collection costs a few ms on a small heap and more on a big one, which is
// why it is tied to big documents only (measured: a 12.8 MB report, 3 collections, resident growth 16.4 MB without, 8.3 MB with).
'use strict';

const COLLECT_EVERY = 4 * 1024 * 1024;
let fn = null; let tried = false;
/** -> a function that runs a full garbage collection, or null when none can be had or the environment turns it off */
function collector(env = process.env) {
  if (env.R24_COMPANYCHECK_NO_GC === '1') return null;
  if (typeof global.gc === 'function') return global.gc;
  if (!tried) {
    tried = true;
    try { require('v8').setFlagsFromString('--expose-gc'); const g = require('vm').runInNewContext('gc'); fn = typeof g === 'function' ? g : null; } catch { fn = null; }
  }
  return fn;
}

/** a tally for one document: tally(bytes) runs the collection every COLLECT_EVERY bytes; `collect` can be injected (tests, the gate runner) */
function perDocument(collect) {
  let seen = 0; let last = 0; let runs = 0;
  return {
    add(n) {
      seen += n;
      if (seen - last >= COLLECT_EVERY) { last = seen; const c = collect === undefined ? collector() : collect; if (typeof c === 'function') { c(); runs++; } }
    },
    get runs() { return runs; },
  };
}

module.exports = { COLLECT_EVERY, collector, perDocument };

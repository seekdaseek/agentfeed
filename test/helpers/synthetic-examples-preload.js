// test/helpers/synthetic-examples-preload.js: preloaded (NODE_OPTIONS=--require) into a REAL server.js child so that its bazaar-examples.json has the three briefs
// marked static + synthetic, whatever the checked-in file holds. The checked-in examples became live readings when the briefs were recaptured on the box, and the
// server's /api/sample caption (server.js: `captured`) must still say "generated" for an entry that is synthetic; this is how that branch is reached.
'use strict';
const Module = require('module');
const BRIEF_ROUTES = ['GET /api/morning-brief', 'GET /api/move-alert', 'GET /api/anomaly-flag'];
const load = Module._load;
Module._load = function (request) {
  const m = load.apply(this, arguments);
  if (typeof request === 'string' && request.endsWith('bazaar-examples.json') && m && m.routes) {
    const copy = JSON.parse(JSON.stringify(m));
    for (const k of BRIEF_ROUTES) if (copy.routes[k]) { copy.routes[k].static = true; copy.routes[k].synthetic = true; }
    return copy;
  }
  return m;
};

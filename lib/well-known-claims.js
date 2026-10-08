// lib/well-known-claims.js — domain-claim files for the directories that list us.
//
//   /.well-known/402index-verify.txt   402index.io: the verification_hash from
//                                      POST /api/v1/claim (never the raw token,
//                                      which is the ongoing edit credential)
//   /.well-known/nohumans-claim        nohumans.directory: one listing's
//                                      challenge token at a time
//
// The values are plain files in WELL_KNOWN_DIR (default ./well-known, gitignored),
// read per request, so writing or rotating one needs no restart and no .env edit.
// A missing, empty or malformed file answers 404: the routes are inert until a
// claim is in progress. Mounted with the other free discovery routes, above the
// payment layer, so a claim check can never be answered with a 402.
'use strict';
const fs = require('fs');
const path = require('path');

const FILES = {
  '/.well-known/402index-verify.txt': '402index-verify.txt',
  '/.well-known/nohumans-claim': 'nohumans-claim',
};

function mountWellKnownClaims(app, dir = process.env.WELL_KNOWN_DIR || path.join(__dirname, '..', 'well-known')) {
  for (const [route, file] of Object.entries(FILES)) {
    app.get(route, (_req, res) => {
      let v = '';
      try { v = fs.readFileSync(path.join(dir, file), 'utf8').trim(); } catch { v = ''; }
      // Both directories hand out short tokens (402index: a 64-hex hash); 402index
      // rejects anything over 1 KB. Anything else is not a claim value.
      if (!v || v.length > 512 || /\s/.test(v)) return res.status(404).type('text/plain').send('not found');
      // A stale value fails the claim, and Cloudflare stretches max-age.
      res.set('Cache-Control', 'no-store');
      res.type('text/plain').send(v);
    });
  }
}

module.exports = { mountWellKnownClaims, FILES };

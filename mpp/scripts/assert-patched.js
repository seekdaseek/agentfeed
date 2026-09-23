#!/usr/bin/env node
// Assert that the installed @solana/mpp carries the preflightCommitment patch.
//
// Why this exists, separately from patch-package's postinstall:
//
// patch-package only runs on `npm install`. This module ships a nested
// node_modules, and a deploy that COPIES that directory to the server never
// runs a lifecycle script — so the patch would silently be whatever was in the
// copied tree. Without the fix, every pull-mode payment fails with "Blockhash
// not found" whenever the client answers the challenge faster than finality
// (~12s), which is essentially always.
//
// So the check runs twice: here (install / deploy gate, exit code) and again
// from mpp/index.js at boot, which refuses to start the payment layer rather
// than serve challenges that cannot be paid.
//
// Deploy step: run `npm run verify-patch` inside /opt/agentfeed/mpp BEFORE
// setting MPP_ENABLED=true.

const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.join(
  __dirname,
  '..',
  'node_modules',
  '@solana',
  'mpp',
  'dist',
  'server',
  'Charge.js',
);

// The exact params list broadcastTransaction must send. `skipPreflight: false`
// is part of the assertion on purpose: the fix must not have been "achieved" by
// disabling preflight.
const REQUIRED = "params: [base64Tx, { encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false }],";
const UNPATCHED = "params: [base64Tx, { encoding: 'base64', skipPreflight: false }],";

function check() {
  if (!fs.existsSync(TARGET)) {
    return { ok: false, reason: `@solana/mpp is not installed at ${TARGET}` };
  }
  const source = fs.readFileSync(TARGET, 'utf8');
  if (source.includes(REQUIRED)) return { ok: true };
  if (source.includes(UNPATCHED)) {
    return {
      ok: false,
      reason:
        'UNPATCHED: broadcastTransaction still sends sendTransaction without preflightCommitment.\n' +
        '  Preflight then runs against the finalized bank while the challenge blockhash is\n' +
        '  minted at confirmed, so every payment made inside the ~12s finality window is\n' +
        '  rejected with "Blockhash not found".\n' +
        '  Fix: run `npm ci` (or `npx patch-package --error-on-fail`) in this directory.',
    };
  }
  return {
    ok: false,
    reason:
      'DRIFTED: neither the patched nor the known-unpatched sendTransaction params were\n' +
      '  found in the installed @solana/mpp. The dependency changed shape; re-verify the\n' +
      '  fix against the new source and regenerate patches/@solana+mpp+0.7.0.patch.\n' +
      '  Refusing to guess.',
  };
}

module.exports = { check, REQUIRED, TARGET, UNPATCHED };

if (require.main === module) {
  const result = check();
  if (result.ok) {
    console.log('[mpp] patch verified: sendTransaction sends preflightCommitment:"confirmed"');
    process.exit(0);
  }
  console.error('[mpp] PATCH ASSERTION FAILED\n  ' + result.reason);
  process.exit(1);
}

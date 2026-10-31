// tools/r23/common.js: the three refusals every R23 tool uses, so "cannot answer" is never a charged answer (R23, 31 Oct 2026).
//   unavailable(msg)  503 + Retry-After, "Not charged.": the tool, an upstream or a spend cap cannot answer now (lib/tool.js, x402 and the key rail cancel on >= 400)
//   notCovered(msg)   404, "not covered, not charged": the request is valid but outside what the tool covers (a mint LaunchLedger never scored)
//   bad(msg)          400 bad_request: the caller's input is wrong (thrown before any upstream call or spend)
'use strict';

const unavailable = (msg, retryAfter = 60) => Object.assign(new Error(`${String(msg).replace(/\s*Not charged\.?$/i, '').replace(/[.]?$/, '.')} Not charged.`), { status: 503, retryAfter });
// kind 'bad_request' keeps the audit row honest: a request outside the coverage is not a service failure (lib/tool.js logs any other unmarked throw as an error)
const notCovered = (msg) => Object.assign(new Error(`${String(msg).replace(/[.]?$/, '')}: not covered, not charged.`), { status: 404, kind: 'bad_request' });
const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });

/** a finite number from the environment, or the default (an unset, empty or non-numeric value is the default) */
function envNum(name, dflt, env = process.env) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

module.exports = { unavailable, notCovered, bad, envNum };

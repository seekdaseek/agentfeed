// tools/r24/txprecheck/limits.js: the exact caps of GET /api/tx-precheck (R24 item 4). Every cap is enforced in the handler with a 400 BEFORE any RPC call.
'use strict';

module.exports = Object.freeze({
  MAX_SOL_TX_BYTES: 1232,        // the largest Solana transaction (the 1280-byte IPv6 MTU minus headers)
  MAX_SOL_TX_B64: 1644,          // 4 * ceil(1232 / 3) base64 characters
  MAX_EVM_DATA_HEX: 20000,       // hex characters of calldata, not counting the 0x prefix
  MAX_EVM_VALUE_BITS: 256,       // value is a uint256
  SIM_TIMEOUT_MS: 8000,          // the simulation phase (every read that precedes the answer) has this long; after it the answer is a 503, not charged
  RISK_TIMEOUT_MS: 6000,         // ALL the token-risk reads of one call share this deadline; a read that is late is reported as unavailable and never holds up the answer
  RISK_MAX_TOKENS: 6,            // token-risk reads per call; the rest are listed as skipped
  RISK_CONCURRENCY: 3,
  LOG_LINES: 40,                 // simulation log lines returned (the last ones)
  LOG_LINE_CHARS: 200,
  MAX_BALANCE_CHANGES: 60,
  MAX_PROGRAMS: 40,
  MAX_EVM_CANDIDATES: 12,        // contracts whose metadata and sender balance are read (the target and the contracts that emitted logs)
  MAX_EVM_PAIRS: 40,             // (token, address) balance probes in one simulation
  MAX_FRESH_CHECKS: 6,           // recipients checked for "never used" on Base
  RETRY_AFTER_S: 30,
});

// mpp/signature.js — derive a transaction's signature from the signed bytes,
// without broadcasting it.
//
// Why this exists: @solana/mpp 0.7.0's pull path (dist/server/Charge.js,
// verifyTransaction) simulates and BROADCASTS before it ever consults the
// consumed-signature store — it only calls `store.put(...)` after
// `broadcastTransaction` returns. Draft §11.6 says a consumed signature "MUST
// NOT be accepted again, even if presented with a different challenge ID", so
// the check has to happen before the credential is acted on. Deriving the
// signature here lets index.js run that gate itself. (Upstream 0.11.0 does the
// same thing via `transactionSignatureFromBase64`; it is not published yet.)
//
// Wire format (Solana transaction): shortvec(signature_count) ||
// signature_count * 64 bytes || message. The transaction signature IS the first
// signature.

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58 (Bitcoin alphabet) encode, with the leading-zero -> '1' rule. */
function base58Encode(bytes) {
  if (bytes.length === 0) return '';

  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Repeated division of the big-endian byte string by 58.
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

/**
 * Read a compact-u16 ("shortvec") at `offset`.
 * @returns {{ value: number, size: number }}
 */
function readShortVec(bytes, offset) {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= bytes.length) throw new Error('shortvec: truncated');
    const byte = bytes[offset + size];
    value |= (byte & 0x7f) << (size * 7);
    size++;
    if ((byte & 0x80) === 0) break;
    if (size > 3) throw new Error('shortvec: too long');
  }
  return { value, size };
}

const EMPTY_SIGNATURE = '1'.repeat(64); // 64 zero bytes in base58

/**
 * Derive the base58 transaction signature from a base64-encoded signed
 * transaction. Returns null when the bytes are not a parseable transaction or
 * the first signature slot is still empty (i.e. unsigned — which the package's
 * own verification will reject on its own terms).
 *
 * @param {string} base64Tx
 * @returns {string|null}
 */
function signatureFromBase64Transaction(base64Tx) {
  let bytes;
  try {
    bytes = Buffer.from(String(base64Tx), 'base64');
  } catch {
    return null;
  }
  if (bytes.length < 65) return null;

  let count;
  try {
    count = readShortVec(bytes, 0);
  } catch {
    return null;
  }
  if (count.value < 1) return null;
  if (bytes.length < count.size + count.value * 64) return null;

  const first = bytes.subarray(count.size, count.size + 64);
  const encoded = base58Encode(first);
  return encoded === EMPTY_SIGNATURE ? null : encoded;
}

/**
 * The fee-payer account of a signed transaction: the first entry of the
 * message's static account keys. Because every challenge this service issues
 * is feePayer:false, §9.2 makes the client both fee payer and transfer
 * authority — so this is the payer, derivable with no RPC call.
 *
 * Layout after the signature block: an optional version byte (high bit set for
 * a versioned message), a 3-byte header, then shortvec(account count) followed
 * by 32-byte account keys.
 *
 * @param {string} base64Tx
 * @returns {string|null}
 */
function feePayerFromBase64Transaction(base64Tx) {
  let bytes;
  try {
    bytes = Buffer.from(String(base64Tx), 'base64');
  } catch {
    return null;
  }

  try {
    const count = readShortVec(bytes, 0);
    let offset = count.size + count.value * 64;
    if (offset >= bytes.length) return null;

    // Versioned messages (v0+) prefix the message with 0x80 | version.
    if ((bytes[offset] & 0x80) !== 0) offset += 1;

    offset += 3; // message header
    const keys = readShortVec(bytes, offset);
    offset += keys.size;
    if (keys.value < 1 || offset + 32 > bytes.length) return null;

    return base58Encode(bytes.subarray(offset, offset + 32));
  } catch {
    return null;
  }
}

module.exports = {
  base58Encode,
  feePayerFromBase64Transaction,
  readShortVec,
  signatureFromBase64Transaction,
};

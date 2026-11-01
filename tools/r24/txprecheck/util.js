// tools/r24/txprecheck/util.js: three small helpers for the I/O layers of GET /api/tx-precheck (R24 item 4).
'use strict';

/** the promise's result, or the error `makeError()` returns once `ms` have passed; the timer never outlives the call */
function withTimeout(promise, ms, makeError) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(makeError()), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** run fn over items, at most `limit` at a time; resolves to an array of settled results in order ({ ok, value } or { ok:false, error }) */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = { ok: true, value: await fn(items[i], i) }; } catch (error) { out[i] = { ok: false, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const unique = (list) => [...new Set(list)];
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

module.exports = { withTimeout, mapLimit, unique, chunk };

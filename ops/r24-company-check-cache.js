// ops/r24-company-check-cache.js: a disk cache around the EDGAR fetcher of tools/r24/company-check, for the gate runs, the memory run and the replay (R24 item 5).
// A miss calls the inner fetcher (the real one: rate limiter + lib/safe-fetch.js) and stores the raw bytes; a hit makes no request. A replay of a finished run therefore makes 0 calls.
// Only answers the tool treats as data are stored: HTTP 200 and 404. Nothing else is stored, so an outage is never replayed as an answer.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function makeDiskFetch({ dir, inner, onMiss, offline = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const stats = { hits: 0, misses: 0 };
  async function diskFetch(url, opts) {
    const h = crypto.createHash('sha256').update(String(url)).digest('hex');
    const metaFile = path.join(dir, `${h}.json`); const bodyFile = path.join(dir, `${h}.body`);
    let meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
    // a stored refusal only stands for a cap no bigger than the one that produced it; with a bigger cap the document is fetched again
    if (meta && meta.too_large && !(opts && opts.maxBytes && opts.maxBytes <= meta.max_bytes_when_refused)) meta = null;
    if (meta) {
      stats.hits++;
      // the cap applies to a replay as it did to the first read: a stored document over this call's maxBytes is refused the same way (code TOO_LARGE)
      if (meta.too_large || (opts && opts.maxBytes && meta.bytes > opts.maxBytes)) throw Object.assign(new Error(`document is over the ${opts && opts.maxBytes}-byte limit`), { code: 'TOO_LARGE' });
      return { status: meta.status, url: meta.final_url || url, contentType: meta.content_type || '', body: meta.status === 200 ? fs.readFileSync(bodyFile) : Buffer.alloc(0), fromCache: true };
    }
    if (offline) throw Object.assign(new Error(`offline replay: ${url} is not in the cache`), { status: 503 });
    stats.misses++;
    if (onMiss) onMiss(url);
    let r;
    try { r = await inner(url, opts); } catch (e) {
      if (e && e.code === 'TOO_LARGE') fs.writeFileSync(metaFile, JSON.stringify({ url, status: 200, too_large: true, bytes: (opts && opts.maxBytes) || 0, max_bytes_when_refused: (opts && opts.maxBytes) || 0, at: new Date().toISOString() }));
      throw e;
    }
    if (r.status === 200 || r.status === 404) {
      if (r.status === 200) fs.writeFileSync(bodyFile, r.body);
      fs.writeFileSync(metaFile, JSON.stringify({ url, final_url: r.url, status: r.status, content_type: r.contentType, bytes: r.body.length, at: new Date().toISOString() }));
    }
    return r;
  }
  diskFetch.stats = stats;
  return diskFetch;
}

/**
 * v2: the same cache for the stream reader. A miss calls `inner(url, opts, onChunk)` and writes each chunk to a temporary file as it goes by (nothing is held); when the read ends well the file is
 * renamed to <sha256 of the url>.body and the meta written, so an entry made by makeDiskFetch (same names) is a hit here and the other way round. A hit streams the file in 64 KB pieces.
 * Stored: 200 (bytes), 404, and a refusal for a document over the cap (meta.too_large, valid for any cap no bigger than the one that refused it). A failed read stores nothing and leaves no file.
 */
function makeDiskStream({ dir, inner, offline = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const stats = { hits: 0, misses: 0 };
  async function diskStream(url, opts, onChunk) {
    const h = crypto.createHash('sha256').update(String(url)).digest('hex');
    const metaFile = path.join(dir, `${h}.json`); const bodyFile = path.join(dir, `${h}.body`);
    let meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
    if (meta && meta.too_large && !(opts && opts.maxBytes && opts.maxBytes <= meta.max_bytes_when_refused)) meta = null;
    if (meta) {
      stats.hits++;
      if (meta.too_large || (opts && opts.maxBytes && meta.bytes > opts.maxBytes)) throw Object.assign(new Error(`document is over the ${opts && opts.maxBytes}-byte limit`), { code: 'TOO_LARGE' });
      if (meta.status !== 200) return { status: meta.status, url: meta.final_url || url, contentType: '', bytes: 0, fromCache: true };
      for await (const c of fs.createReadStream(bodyFile, { highWaterMark: 65536 })) onChunk(c);
      return { status: 200, url: meta.final_url || url, contentType: meta.content_type || '', bytes: meta.bytes, fromCache: true };
    }
    if (offline) throw Object.assign(new Error(`offline replay: ${url} is not in the cache`), { status: 503 });
    stats.misses++;
    const tmp = `${bodyFile}.${process.pid}.tmp`; const fd = fs.openSync(tmp, 'w');
    let r;
    try { r = await inner(url, opts, (c) => { fs.writeSync(fd, c); onChunk(c); }); } catch (e) {
      fs.closeSync(fd); fs.rmSync(tmp, { force: true });
      if (e && e.code === 'TOO_LARGE') fs.writeFileSync(metaFile, JSON.stringify({ url, status: 200, too_large: true, bytes: (opts && opts.maxBytes) || 0, max_bytes_when_refused: (opts && opts.maxBytes) || 0, at: new Date().toISOString() }));
      throw e;
    }
    fs.closeSync(fd);
    if (r.status === 200) { fs.renameSync(tmp, bodyFile); fs.writeFileSync(metaFile, JSON.stringify({ url, final_url: r.url, status: 200, content_type: r.contentType, bytes: r.bytes, at: new Date().toISOString() })); } else {
      fs.rmSync(tmp, { force: true });
      if (r.status === 404) fs.writeFileSync(metaFile, JSON.stringify({ url, final_url: r.url, status: 404, bytes: 0, at: new Date().toISOString() }));
    }
    return r;
  }
  diskStream.stats = stats;
  return diskStream;
}

module.exports = { makeDiskFetch, makeDiskStream };

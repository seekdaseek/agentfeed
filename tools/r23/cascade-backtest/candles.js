// tools/r23/cascade-backtest/candles.js: the 15-minute candle cache (one small binary file per symbol per UTC day), the Hyperliquid fetch, and the bounded refresh.
//
// WHY A CACHE ON DISK: Hyperliquid's candleSnapshot keeps only the latest 5,000 candles of an interval (docs/SOURCES.md lists the API as clean; bin/brief-calibrate.js
// documents the cap), so a 15-minute history older than about 52 days exists only if we kept it. Every refresh therefore ADDS to the files and never removes a day.
//
// FILE  <R23_CANDLE_CACHE>/<TAPE SYMBOL>/<YYYY-MM-DD>.k15   (808 bytes, little-endian)
//    0  4  magic "AFC1"            4  4  uint32 number of candles present
//    8  8  float64 day start (ms)  16 8  float64 first candle start the source had (>= day start)   24 8  float64 through (ms): every candle starting before it is final
//   32  4  uint32 CRC-32 (zlib) of bytes 0..32 followed by the payload   36 4  zero
//   40  96 x float64 close of each 15-minute candle of the day, NaN = no candle
//  <R23_CANDLE_CACHE>/<TAPE SYMBOL>/meta.json  { symbol, coin, interval, source } : the Hyperliquid coin the tape symbol maps to, written by the warm script
// A file that fails any check (size, magic, CRC, header sanity, a value outside [from, through)) is IGNORED and the day is fetched again if Hyperliquid still has it.
//
// PRICE: price(T), T a multiple of 15 minutes, is the close of the candle that ENDS at T (it starts at T - 15 min).
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./config');
const { unavailable } = require('../common');

const MAGIC = Buffer.from('AFC1');
const HEADER = 40;
const FILE_SIZE = HEADER + C.PER_DAY * 8;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})\.k15$/;
const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/;
const COIN_RE = /^[A-Za-z0-9]{1,20}$/;

// ---- CRC-32 (the zlib polynomial, chained like zlib.crc32(data, previous)), so the Python recompute can check files with zlib.crc32
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf, prev = 0) {
  let c = ~prev >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

const dayStartOf = (ms) => Math.floor(ms / C.DAY_MS) * C.DAY_MS;
const dayName = (dayStart) => `${new Date(dayStart).toISOString().slice(0, 10)}.k15`;
const dayOfName = (name) => { const m = DAY_RE.exec(name); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };

function encodeDay({ dayStart, from, through, closes }) {
  const buf = Buffer.alloc(FILE_SIZE);
  MAGIC.copy(buf, 0);
  let n = 0;
  for (let i = 0; i < C.PER_DAY; i++) { buf.writeDoubleLE(closes[i], HEADER + i * 8); if (Number.isFinite(closes[i])) n++; }
  buf.writeUInt32LE(n, 4);
  buf.writeDoubleLE(dayStart, 8); buf.writeDoubleLE(from, 16); buf.writeDoubleLE(through, 24);
  buf.writeUInt32LE(crc32(buf.subarray(HEADER), crc32(buf.subarray(0, 32))), 32);
  return buf;
}

/** -> { dayStart, from, through, closes: Float64Array(96) } or null when the bytes are not a valid day file */
function decodeDay(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== FILE_SIZE || !buf.subarray(0, 4).equals(MAGIC)) return null;
  if (buf.readUInt32LE(32) !== crc32(buf.subarray(HEADER), crc32(buf.subarray(0, 32)))) return null;
  const n = buf.readUInt32LE(4), dayStart = buf.readDoubleLE(8), from = buf.readDoubleLE(16), through = buf.readDoubleLE(24);
  if (![dayStart, from, through].every(Number.isFinite) || dayStart % C.DAY_MS !== 0) return null;
  if (from < dayStart || from > dayStart + C.DAY_MS || through < from || through > dayStart + C.DAY_MS || from % C.STEP_MS !== 0 || through % C.STEP_MS !== 0) return null;
  const closes = new Float64Array(C.PER_DAY);
  let count = 0;
  for (let i = 0; i < C.PER_DAY; i++) {
    const v = buf.readDoubleLE(HEADER + i * 8), start = dayStart + i * C.STEP_MS;
    closes[i] = v;
    if (Number.isNaN(v)) continue;
    if (!(v > 0) || !Number.isFinite(v) || start < from || start >= through) return null;
    count++;
  }
  return count === n ? { dayStart, from, through, closes } : null;
}

function readDayFile(file, expectDayStart) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const d = decodeDay(buf);
  return d && (expectDayStart == null || d.dayStart === expectDayStart) ? d : null;
}

function writeDayFile(file, day) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try { fs.writeFileSync(tmp, encodeDay(day)); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* nothing was written */ } throw e; }
}

// ---- the cached symbols
function readMeta(dir, symbol) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, symbol, 'meta.json'), 'utf8'));
    return m && typeof m.coin === 'string' && COIN_RE.test(m.coin) && m.interval === C.INTERVAL ? m : null;
  } catch { return null; }
}
function writeMeta(dir, symbol, coin) {
  fs.mkdirSync(path.join(dir, symbol), { recursive: true });
  const file = path.join(dir, symbol, 'meta.json'), tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ symbol, coin, interval: C.INTERVAL, source: 'Hyperliquid candleSnapshot' }) + '\n');
  fs.renameSync(tmp, file);
}
/** -> [{ symbol, coin }] sorted: the tape symbols the backtest covers (a valid meta.json and at least one day file) */
function listSupported(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const symbol of names.filter((n) => SYMBOL_RE.test(n)).sort().slice(0, 1000)) {
    const meta = readMeta(dir, symbol);
    if (!meta) continue;
    let files;
    try { files = fs.readdirSync(path.join(dir, symbol)); } catch { continue; }
    if (files.some((f) => DAY_RE.test(f))) out.push({ symbol, coin: meta.coin });
  }
  return out;
}

// ---- the series: every valid day file of a symbol, read once per request
class Series {
  constructor(base, nDays) {
    this.base = base; this.nDays = nDays;
    this.closes = new Float64Array(nDays * C.PER_DAY).fill(NaN);
    this.ok = new Uint8Array(nDays); this.from = new Float64Array(nDays); this.through = new Float64Array(nDays);
    this.firstCandle = null; this.lastThrough = null; this.corruptDays = [];
  }
  /** price(T) -> { p } or { reason }: not_cached (no valid file, or before the first candle the source had), not_elapsed (T is past the newest cached candle), candle_gap (no candle inside the cached span) */
  priceAt(T) {
    const s = T - C.STEP_MS;
    const end = this.base + this.nDays * C.DAY_MS;
    if (s < this.base) return { reason: 'not_cached' };
    if (s >= end) return { reason: 'not_elapsed' };
    const d = Math.floor((s - this.base) / C.DAY_MS);
    if (!this.ok[d] || s < this.from[d]) return { reason: 'not_cached' };
    if (s >= this.through[d]) return { reason: 'not_elapsed' };
    const v = this.closes[Math.floor((s - this.base) / C.STEP_MS)];
    return Number.isNaN(v) ? { reason: 'candle_gap' } : { p: v };
  }
  /** the first day index at or after `fromDay` (ms) that has no valid file */
  holes() {
    const out = [];
    for (let d = 0; d < this.nDays; d++) if (!this.ok[d]) out.push(this.base + d * C.DAY_MS);
    return out;
  }
}

/** -> Series, or null when the symbol has no valid day file at all. Reads at most 4,000 files. */
function loadSeries(dir, symbol) {
  const sdir = path.join(dir, symbol);
  let names;
  try { names = fs.readdirSync(sdir); } catch { return null; }
  const days = [], corrupt = [];
  for (const name of names.filter((n) => DAY_RE.test(n)).sort().slice(0, 4000)) {
    const ds = dayOfName(name);
    const d = readDayFile(path.join(sdir, name), ds);
    if (d) days.push(d); else corrupt.push(ds);
  }
  if (!days.length) return null;
  const base = days[0].dayStart, last = days[days.length - 1].dayStart;
  const s = new Series(base, Math.round((last - base) / C.DAY_MS) + 1);
  s.corruptDays = corrupt;
  for (const d of days) {
    const i = Math.round((d.dayStart - base) / C.DAY_MS);
    s.ok[i] = 1; s.from[i] = d.from; s.through[i] = d.through;
    s.closes.set(d.closes, i * C.PER_DAY);
  }
  for (let i = 0; i < s.closes.length; i++) if (!Number.isNaN(s.closes[i])) { s.firstCandle = base + i * C.STEP_MS; break; }
  s.lastThrough = s.through[s.nDays - 1];
  return s;
}

// ---- Hyperliquid
/** one candleSnapshot call -> [{ t, c }] ascending, closes finite and positive. Any failure is the 503 "Not charged" refusal. */
async function fetchCandlesHL({ coin, startMs, endMs }, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!COIN_RE.test(String(coin))) throw unavailable('the Hyperliquid coin name is not valid', 3600);
  let r;
  try {
    r = await fetchImpl(C.HL_INFO(env), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: C.INTERVAL, startTime: Math.floor(startMs), endTime: Math.floor(endMs) } }), signal: AbortSignal.timeout(C.FETCH_TIMEOUT_MS) });
  } catch (e) { throw unavailable(`Hyperliquid could not be reached (${String((e && e.message) || e).slice(0, 80)})`, 120); }
  if (r.status === 429) throw unavailable('Hyperliquid is rate limiting this server', 300);
  if (!r.ok) throw unavailable(`Hyperliquid answered HTTP ${r.status}`, 120);
  const len = Number(r.headers && r.headers.get && r.headers.get('content-length')) || 0;
  if (len > C.FETCH_MAX_BYTES) throw unavailable('Hyperliquid answered with an oversized document', 300);
  let arr;
  try {
    const text = await r.text();
    if (text.length > C.FETCH_MAX_BYTES) throw new Error('oversized');
    arr = JSON.parse(text);
  } catch { throw unavailable('Hyperliquid answered with something that is not a candle list', 120); }
  if (!Array.isArray(arr)) throw unavailable('Hyperliquid answered with something that is not a candle list', 120);
  const out = [];
  for (const x of arr.slice(0, C.SOURCE_RETENTION_CANDLES + 1000)) {
    const t = Number(x && x.t), c = Number(x && x.c);
    if (Number.isFinite(t) && t % C.STEP_MS === 0 && Number.isFinite(c) && c > 0) out.push({ t, c });
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((x, i) => i === 0 || x.t !== out[i - 1].t);
}

/**
 * Write fetched candles into the day files (merging with a valid file that is already there; the fetch is authoritative where it has a candle). Only CLOSED candles (start + 15 min <= now).
 * A day wholly before the first candle the source returned is not written (the source did not have it: no file means not_cached, which is the truth). -> number of day files written.
 */
function ingest(dir, symbol, candles, fetchStartMs, nowMs) {
  const nowGrid = Math.floor(nowMs / C.STEP_MS) * C.STEP_MS;
  const closed = candles.filter((x) => x.t + C.STEP_MS <= nowMs && x.t >= dayStartOf(fetchStartMs));
  if (!closed.length) return 0;
  const firstT = closed[0].t;
  const lastDay = dayStartOf(nowGrid - 1);
  let written = 0;
  for (let ds = dayStartOf(firstT); ds <= lastDay; ds += C.DAY_MS) {
    const file = path.join(dir, symbol, dayName(ds));
    const old = readDayFile(file, ds);
    const closes = old ? Float64Array.from(old.closes) : new Float64Array(C.PER_DAY).fill(NaN);
    for (const x of closed) if (x.t >= ds && x.t < ds + C.DAY_MS) closes[(x.t - ds) / C.STEP_MS] = x.c;
    const from = old ? Math.min(old.from, Math.max(ds, firstT)) : Math.max(ds, firstT);
    const through = Math.max(old ? old.through : 0, Math.min(ds + C.DAY_MS, nowGrid));
    if (through <= ds) continue;
    writeDayFile(file, { dayStart: ds, from, through, closes });
    written++;
  }
  return written;
}

// ---- refresh at request time: bounded, rate limited, one fetch per symbol at a time (module state is bounded by MAX_TRACKED_SYMBOLS)
const inflight = new Map();      // symbol -> Promise<result>: a second caller for the same symbol waits for the first one's fetch
const lastOk = new Map();        // symbol -> ms of the last successful refresh
const lastFail = new Map();      // symbol -> ms of the last failure
let callChain = Promise.resolve();
let lastCallAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trim = (m) => { while (m.size > C.MAX_TRACKED_SYMBOLS) m.delete(m.keys().next().value); };

/** one global line: at most one Hyperliquid call in flight from this process, GLOBAL_CALL_GAP_MS apart */
function throttled(fn, gapMs) {
  const run = callChain.then(async () => {
    const wait = lastCallAt + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  });
  callChain = run.catch(() => {});
  return run;
}

/**
 * Bring a symbol's cache up to date: ONE candleSnapshot call from the start of `fromMs`'s day to now, at most once per REFRESH_MIN_GAP_MS after a success and not again for REFRESH_FAIL_BACKOFF_MS
 * after a failure. Never throws. -> { status: 'ok'|'failed'|'skipped', reason, written }
 */
function refresh({ dir, symbol, coin, fromMs, nowMs, fetchCandles, gapMs = C.GLOBAL_CALL_GAP_MS }) {
  if (inflight.has(symbol)) return inflight.get(symbol);
  const ok = lastOk.get(symbol), failed = lastFail.get(symbol);
  if (failed != null && nowMs - failed < C.REFRESH_FAIL_BACKOFF_MS) return Promise.resolve({ status: 'failed', reason: 'backoff', written: 0 });
  if (ok != null && nowMs - ok < C.REFRESH_MIN_GAP_MS) return Promise.resolve({ status: 'skipped', reason: 'recent', written: 0 });
  const p = (async () => {
    try {
      const startMs = dayStartOf(Math.max(fromMs, nowMs - C.SOURCE_RETENTION_CANDLES * C.STEP_MS));
      const candles = await throttled(() => fetchCandles({ coin, startMs, endMs: nowMs }), gapMs);
      const written = ingest(dir, symbol, candles, startMs, nowMs);
      lastFail.delete(symbol); lastOk.set(symbol, nowMs); trim(lastOk);
      return { status: 'ok', reason: null, written };
    } catch (e) {
      lastFail.set(symbol, nowMs); trim(lastFail);
      return { status: 'failed', reason: String((e && e.message) || e).slice(0, 160), written: 0 };
    }
  })().finally(() => { inflight.delete(symbol); });
  inflight.set(symbol, p);
  return p;
}

/** test hooks: forget the module's refresh bookkeeping; read its sizes (they are bounded by MAX_TRACKED_SYMBOLS) */
function _resetState() { inflight.clear(); lastOk.clear(); lastFail.clear(); callChain = Promise.resolve(); lastCallAt = 0; }
const _state = () => ({ inflight: inflight.size, lastOk: lastOk.size, lastFail: lastFail.size });

module.exports = {
  FILE_SIZE, HEADER, crc32, dayStartOf, dayName, dayOfName, encodeDay, decodeDay, readDayFile, writeDayFile, readMeta, writeMeta, listSupported,
  Series, loadSeries, fetchCandlesHL, ingest, refresh, _resetState, _state,
};

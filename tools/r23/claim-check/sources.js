// tools/r23/claim-check/sources.js: reading the sources of a claim check (R23 T4, 31 Oct 2026).
// Three kinds of source, all fetched on the request and kept only in a small bounded cache of text:
//   sec-filing  a filing document under sec.gov/Archives/edgar/data. The filing is FOUND with tools/sec.js (getSecFilings: ticker + form -> the filing list and document
//               urls); that module exposes no text download (its edgar() fetcher, limiter and User-Agent are private), so the document itself is downloaded here through
//               lib/safe-fetch.js with the same declared User-Agent, at most one request per SEC_GAP_MS on top of sec.js's own 8 a second (the SEC allows 10).
//               robots.txt of sec.gov allows /Archives/edgar/data and the reader refuses any other path.
//   wikipedia   an article's lead through tools/wiki.js (getWiki), by title or by a caller's https://xx.wikipedia.org/wiki/Title URL.
//   web         any other caller URL through tools/llm/page.js getPageText (webmd + lib/safe-fetch.js, robots.txt honoured), wrapped so that an https URL which ends on
//               a non-https address is refused. The text used is webmd's whole markdown (up to its own 300,000 characters), not the 70,000 characters getPageText cuts.
// A source that cannot be read is a failure with a reason, never a finding.
'use strict';
const SF = require('../../../lib/safe-fetch');
const T = require('./text');
const { bad } = require('../common');

const SEC_UA = 'AgentFeed ochinimus@gmail.com';       // the declared User-Agent tools/sec.js sends (SEC fair-access policy: a contact in the User-Agent)
const SEC_GAP_MS = 600;
const SEC_PARALLEL = 2;
const limits = { gapMs: SEC_GAP_MS, parallel: SEC_PARALLEL };       // read at call time; a test lowers them
const SEC_MAX_BYTES = 5 * 1024 * 1024;
const MAX_WIKI_TITLES = 2;
const MAX_TEXT_CHARS = 1500000;

// ---------------------------------------------------------------- a bounded cache of fetched text (the only thing kept across callers)
// Bounded three ways: entries, bytes (counted as two bytes a character, the worst case of a JavaScript string) and age. A full filing is about 0.4 to 0.7 MB of text, so the
// default 3 MB holds a few of them at most, never the raw HTML (which is dropped as soon as the text is extracted), and one text over half the budget is not kept.
function makeCache({ max = 4, ttlMs = 10 * 60e3, maxBytes = 3 * 1024 * 1024 } = {}) {
  const m = new Map(); let bytes = 0;
  const drop = (k) => { const e = m.get(k); if (e) { bytes -= e.bytes; m.delete(k); } };
  return {
    get(k, now = Date.now()) { const e = m.get(k); if (!e) return undefined; if (now - e.at >= ttlMs) { drop(k); return undefined; } m.delete(k); m.set(k, e); return e.v; },
    set(k, v, now = Date.now()) {
      drop(k);
      const b = v.text.length * 2;
      if (b > maxBytes / 2) return;                                  // one huge text never pushes out everything else
      m.set(k, { at: now, v, bytes: b }); bytes += b;
      while (m.size > max || bytes > maxBytes) drop(m.keys().next().value);
    },
    clear() { m.clear(); bytes = 0; },
    get size() { return m.size; }, get bytes() { return bytes; },
  };
}

// ---------------------------------------------------------------- failures
/** -> { url, kind, reason, transient } ; transient: trying again later could read it (the source or its network was down), not a permanent refusal */
function failure(url, kind, e) {
  const known = e && (e.kind === 'bad_request' || e.status === 503 || e.status === 404);
  const reason = known ? String(e.message).replace(/\s*Not charged\.?$/i, '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 200) : 'could not be read';
  return { url, kind, reason, transient: !(e && (e.kind === 'bad_request' || e.status === 404)) };
}
const publicFailure = ({ url, reason }) => ({ url, reason });

// ---------------------------------------------------------------- what a URL is
/** -> { type: 'wiki', lang, title } | { type: 'sec', href } | { type: 'web', href } ; throws bad() for anything that is not a plain public https URL */
function classify(raw) {
  const u = SF.checkUrl(raw, { httpsOnly: true });
  const host = u.hostname.toLowerCase();
  const w = /^([a-z]{2,3}(?:-[a-z]{2,8})?)\.wikipedia\.org$/.exec(host);
  if (w && /^\/wiki\/[^/]/.test(u.pathname)) {
    let title; try { title = decodeURIComponent(u.pathname.slice(6)).replace(/_/g, ' '); } catch { throw bad('the Wikipedia URL has a title that is not valid'); }
    return { type: 'wiki', lang: w[1], title };
  }
  if (host === 'www.sec.gov' || host === 'sec.gov') {
    let p = u.pathname;
    if (p === '/ix' && u.searchParams.get('doc')) p = u.searchParams.get('doc');                     // the inline-XBRL viewer link of a filing
    if (/^\/Archives\/edgar\/data\/\d+\/[\w-]+\/[\w.\-]+\.(?:htm|html|txt)$/i.test(p)) return { type: 'sec', href: `https://www.sec.gov${p}` };
  }
  return { type: 'web', href: u.href };
}

// ---------------------------------------------------------------- readers
let secNext = 0; let secActive = 0; const secWaiting = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** at most SEC_PARALLEL filing downloads at once (a filing is up to 5 MB of HTML held in memory while it is converted) */
async function secSlot() {
  if (secActive >= limits.parallel) await new Promise((r) => secWaiting.push(r));
  secActive++;
  return () => { secActive--; const next = secWaiting.shift(); if (next) next(); };
}
async function fetchSecDoc(href) {
  const release = await secSlot();
  try {
    const now = Date.now(); const at = Math.max(now, secNext); secNext = at + limits.gapMs;
    if (at > now) await sleep(at - now);
    return await secFetch(href);
  } finally { release(); }
}
function secFetch(href) {
  return SF.safeFetch(href, { maxBytes: SEC_MAX_BYTES, timeoutMs: 10000, userAgent: SEC_UA, accept: 'text/html,application/xhtml+xml,text/plain', okTypes: ['text/html', 'application/xhtml+xml', 'text/plain'], httpsOnly: true });
}

async function readSec(href, d, meta = {}) {
  const r = await (d.fetchSecDoc || fetchSecDoc)(href);
  // the document is read once, as bytes, straight to its visible text (text.js htmlToText); the bytes are not referenced again after this line
  const html = /html/.test(r.contentType || '');
  const text = html ? T.htmlToText(r.body) : T.cleanText(Buffer.isBuffer(r.body) ? r.body.toString('utf8') : String(r.body));
  r.body = null;
  if (!text) throw bad('no readable text was found in this filing');
  return { url: href, final_url: r.url || href, kind: 'sec-filing', format: 'html', title: meta.title || null, text: text.slice(0, MAX_TEXT_CHARS), chars_total: text.length, truncated_source: text.length > MAX_TEXT_CHARS };
}

async function readWiki(lang, title, d) {
  const w = await d.wiki.getWiki({ title, lang });
  if (w.type === 'disambiguation') throw bad(`"${title}" is a disambiguation page on ${lang}.wikipedia.org`);
  const text = T.cleanText(w.lead || w.summary || '');
  if (!text) throw bad(`the ${lang}.wikipedia.org article "${title}" has no text`);
  return { url: w.url, final_url: w.url, kind: 'wikipedia', format: 'text', title: w.title, text, chars_total: text.length, truncated_source: false };
}

function assertHttps(u) {
  let p; try { p = new URL(u).protocol; } catch { p = ''; }
  if (p !== 'https:') throw bad('the page ends on a non-https address, which is not read');
}
async function readWeb(href, d) {
  let full = null; let srcTruncated = false;
  const wrap = (fn) => async (p) => {
    const doc = await fn({ ...p, httpsOnly: true });                       // webmd ignores httpsOnly today; a one-line change in it makes the whole chain https-only (see the notes)
    assertHttps(doc.final_url || doc.url);
    full = String(doc.markdown || ''); srcTruncated = !!doc.truncated;
    return doc;
  };
  const page = await d.getPageText(href, { getWebMarkdown: wrap(d.getWebMarkdown), getPdfMarkdown: wrap(d.getPdfMarkdown) });
  assertHttps(page.final_url || page.url || href);
  const text = T.mdToPlain(full != null && full.trim() ? full : page.text);
  if (!text) throw bad('no readable text was found at this URL');
  return { url: href, final_url: page.final_url || page.url || href, kind: 'web', format: page.kind || 'html', title: page.title || null, text: text.slice(0, MAX_TEXT_CHARS), chars_total: text.length, truncated_source: srcTruncated || text.length > MAX_TEXT_CHARS };
}

/** one caller URL -> a source ; throws the reader's error (bad_request or 503) */
async function readUrl(raw, d) {
  const c = classify(raw);
  const key = c.type === 'wiki' ? `wiki|${c.lang}|${c.title.toLowerCase()}` : c.href;
  const now = d.now();
  const hit = d.cache.get(key, now);
  if (hit) return { ...hit, cached: true };
  const src = c.type === 'wiki' ? await readWiki(c.lang, c.title, d) : c.type === 'sec' ? await readSec(c.href, d) : await readWeb(c.href, d);
  d.cache.set(key, src, now);
  return { ...src, cached: false };
}

// ---------------------------------------------------------------- finding sources when the caller gave none
/** the filing a claim points at: the report whose period ends in the year the claim names, else the first filed after it (it carries the year as a comparative), else the newest */
function pickFiling(rows, years) {
  if (!rows.length) return null;
  if (!years.length) return rows[0];
  const y = Math.max(...years);
  const yr = (r) => Number(String(r.report_date || r.filed).slice(0, 4));
  return rows.find((r) => yr(r) === y) || [...rows].reverse().find((r) => yr(r) > y) || rows[0];
}
async function discoverSec(ticker, claim, d) {
  const form = T.formHint(claim);
  const res = await d.sec.getSecFilings({ ticker, form, limit: 20 });
  const row = pickFiling(res.filings || [], T.yearsOf(claim));
  if (!row) throw bad(`${ticker} has no ${form} filing in the SEC's recent list`);
  const key = row.document_url;
  const now = d.now(); const hit = d.cache.get(key, now);
  if (hit) return { ...hit, cached: true };
  const src = await readSec(key, d, { title: `${row.form} for the period ending ${row.report_date || row.filed}` });
  d.cache.set(key, src, now);
  return { ...src, cached: false };
}

/** no URLs given: when the claim carries an explicit ticker, one SEC filing; otherwise the Wikipedia articles it names. -> { read, failed } */
async function discover(claim, d) {
  const jobs = [];
  const ticker = T.tickerOf(claim);
  // a claim with an explicit ticker is about that company's filings; its capitalised words ("Total net sales ...") are not article titles
  if (ticker) jobs.push({ url: null, kind: 'sec-filing', what: `SEC filing list for ${ticker}`, run: () => discoverSec(ticker, claim, d) });
  else for (const title of T.wikiTitlesOf(claim, MAX_WIKI_TITLES)) {
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    jobs.push({ url, kind: 'wikipedia', what: url, run: () => { const hit = d.cache.get(`wiki|en|${title.toLowerCase()}`, d.now()); return hit ? Promise.resolve({ ...hit, cached: true }) : readWiki('en', title, d).then((s) => { d.cache.set(`wiki|en|${title.toLowerCase()}`, s, d.now()); return { ...s, cached: false }; }); } });
  }
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  const read = []; const failed = [];
  results.forEach((r, i) => { if (r.status === 'fulfilled') read.push(r.value); else failed.push(failure(jobs[i].url, jobs[i].kind, r.reason)); });
  return { read, failed };
}

/** the caller's URLs, read in parallel. -> { read, failed } */
async function readUrls(urls, d) {
  const results = await Promise.allSettled(urls.map((u) => readUrl(u, d)));
  const read = []; const failed = [];
  results.forEach((r, i) => { if (r.status === 'fulfilled') read.push(r.value); else failed.push(failure(urls[i], classifyKind(urls[i]), r.reason)); });
  return { read, failed };
}
function classifyKind(u) { try { return { wiki: 'wikipedia', sec: 'sec-filing', web: 'web' }[classify(u).type]; } catch { return 'web'; } }

module.exports = { limits, makeCache, classify, readUrl, readUrls, discover, discoverSec, pickFiling, failure, publicFailure, fetchSecDoc, readWeb, readSec, readWiki, SEC_UA, SEC_GAP_MS, SEC_MAX_BYTES, MAX_WIKI_TITLES };

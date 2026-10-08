// tools/macro.js — the macro clock: FOMC decisions, CPI, NFP and PCE releases.
//
// Every date comes from the issuing agency's own page, read by collect() (cron,
// daily, bin/macro-collect.js) and stamped with the moment it was verified:
//   FOMC  federalreserve.gov/json/calendar.json  ("FOMC Meeting" = decision day,
//         with its time) and monetarypolicy/fomccalendars.htm (meeting ranges,
//         for meetings the JSON does not list yet; those carry no time)
//   CPI   bls.gov/schedule/news_release/cpi.htm
//   NFP   bls.gov/schedule/news_release/empsit.htm (The Employment Situation)
//   PCE   bea.gov/news/schedule ("Personal Income and Outlays")
// A page that cannot be read or parsed leaves its event type out of the snapshot,
// named in `unavailable` with the reason. Nothing is ever entered by hand.
//
// Times are published in America/New_York; utc is converted with the zone's
// rules for that date, so DST is handled by the platform's tz database.
'use strict';
const fs = require('fs');
const path = require('path');

const SNAP_PATH = () => process.env.MACRO_SNAPSHOT || path.join(__dirname, '..', 'macro.json');
const STALE_AFTER_DAYS = 35;
const UA = 'agentfeed-macro/1.0 (+https://x402.ochinimus.app)';
const SRC = {
  fed_json: 'https://www.federalreserve.gov/json/calendar.json',
  fed_page: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  cpi: 'https://www.bls.gov/schedule/news_release/cpi.htm',
  nfp: 'https://www.bls.gov/schedule/news_release/empsit.htm',
  pce: 'https://www.bea.gov/news/schedule',
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIdx = (s) => { const m = String(s).toLowerCase().replace(/\./g, ''); return MONTHS.findIndex((x) => x.startsWith(m.slice(0, 3))); };

// ---- time (pure, unit-tested) -------------------------------------------------
/** Minutes east of UTC for America/New_York at a UTC instant (-240 in EDT, -300 in EST). */
function nyOffsetMin(utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(utcMs)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute);
  return Math.round((asUtc - utcMs) / 60000);
}
/** America/New_York wall clock -> UTC ms. Two passes settle the DST edge. */
function nyToUtc(y, m, d, hh, mm) {
  const wall = Date.UTC(y, m, d, hh, mm);
  let utc = wall - nyOffsetMin(wall) * 60000;
  utc = wall - nyOffsetMin(utc) * 60000;
  return utc;
}
/** "2:00 p.m." / "08:30 AM" / "8:30 AM" -> [h, m] or null */
function parseClock(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12; if (m[3].toLowerCase() === 'p') h += 12;
  return [h, Number(m[2])];
}
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
function event(type, title, ref, y, mo, d, clock, source, verifiedAt, extra = {}) {
  const ymd = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const c = clock ? parseClock(clock) : null;
  return {
    type, title, reference_period: ref || null, date_new_york: ymd,
    time_new_york: c ? `${String(c[0]).padStart(2, '0')}:${String(c[1]).padStart(2, '0')}` : null,
    utc: c ? new Date(nyToUtc(y, mo, d, c[0], c[1])).toISOString() : null,
    ...(c ? {} : { time_note: 'the source does not state a time for this date yet' }),
    source_url: source, verified_at: verifiedAt, ...extra,
  };
}

// ---- parsers (pure, unit-tested on saved pages) ----------------------------------
function parseFedJson(raw, verifiedAt) {
  const j = JSON.parse(String(raw).replace(/^﻿/, ''));
  return (j.events || []).filter((e) => e && e.type === 'FOMC' && /^FOMC Meeting$/i.test(String(e.title).trim()) && /^\d{4}-\d{2}$/.test(e.month || ''))
    .map((e) => { const [y, m] = e.month.split('-').map(Number); return event('FOMC', 'FOMC rate decision (statement)', null, y, m - 1, Number(e.days), e.time, SRC.fed_json, verifiedAt, { press_conference: /Press Conference/i.test(e.description || '') }); });
}
function parseFedPage(html, verifiedAt) {
  const t = text(html);
  const out = [];
  for (const m of t.matchAll(/(\d{4}) FOMC Meetings([\s\S]*?)(?=\d{4} FOMC Meetings|$)/g)) {
    const y = Number(m[1]);
    // The block ends at its footnote: the 2027 block's note "A two-day meeting is
    // scheduled for January 25-26, 2028" is a range in the NEXT year and was
    // being filed as 2027-01-26 before this cut.
    const block = m[2].split(/\*\s*Meeting associated|Note:/)[0];
    // meeting RANGES only ("January 27-28", "April/May 30-1"); minutes-release dates are single days
    for (const r of block.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)(?:\/(January|February|March|April|May|June|July|August|September|October|November|December))?\s+(\d{1,2})-(\d{1,2})(\*?)/g)) {
      const mo = monthIdx(r[2] || r[1]);
      out.push(event('FOMC', 'FOMC rate decision (statement)', null, y, mo, Number(r[4]), null, SRC.fed_page, verifiedAt, { summary_of_economic_projections: r[5] === '*' }));
    }
  }
  return out;
}
function parseBls(html, type, title, source, verifiedAt) {
  const t = text(html);
  const out = [];
  for (const r of t.matchAll(/(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.? (\d{1,2}), (\d{4}) (\d{1,2}:\d{2} [AP]M)/g)) {
    out.push(event(type, title, `${r[1]} ${r[2]}`, Number(r[5]), monthIdx(r[3]), Number(r[4]), r[6], source, verifiedAt));
  }
  return out;
}
function parseBea(html, verifiedAt) {
  const t = text(html);
  const out = [];
  for (const r of t.matchAll(/Personal Income and Outlays, (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}) (\d{1,2}:\d{2} [AP]M)/g)) {
    const refY = Number(r[2]), refM = monthIdx(r[1]), relM = monthIdx(r[3]);
    const y = relM < refM ? refY + 1 : refY; // released after the reference month; the page omits the year
    out.push(event('PCE', 'PCE price index (Personal Income and Outlays)', `${r[1]} ${r[2]}`, y, relM, Number(r[4]), r[5], SRC.pce, verifiedAt));
  }
  return out;
}

// ---- collector ---------------------------------------------------------------------
async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
async function collect({ now = Date.now() } = {}) {
  const verifiedAt = new Date(now).toISOString();
  const events = [], unavailable = [];
  // FOMC: JSON first (has times); the page adds meetings the JSON does not list yet
  try {
    const fromJson = parseFedJson(await fetchText(SRC.fed_json), verifiedAt);
    let fromPage = [];
    try { fromPage = parseFedPage(await fetchText(SRC.fed_page), verifiedAt); } catch (e) { unavailable.push({ type: 'FOMC (meetings beyond the Fed JSON calendar)', source_url: SRC.fed_page, reason: e.message }); }
    const have = new Set(fromJson.map((e) => e.date_new_york));
    const merged = fromJson.concat(fromPage.filter((e) => !have.has(e.date_new_york)));
    if (!merged.length) throw new Error('no FOMC meetings parsed');
    events.push(...merged);
  } catch (e) { unavailable.push({ type: 'FOMC', source_url: SRC.fed_json, reason: e.message }); }
  for (const [type, title, url] of [['CPI', 'Consumer Price Index', SRC.cpi], ['NFP', 'The Employment Situation (nonfarm payrolls)', SRC.nfp]]) {
    try { const ev = parseBls(await fetchText(url), type, title, url, verifiedAt); if (!ev.length) throw new Error('no release rows parsed'); events.push(...ev); }
    catch (e) { unavailable.push({ type, source_url: url, reason: e.message }); }
  }
  try { const ev = parseBea(await fetchText(SRC.pce), verifiedAt); if (!ev.length) throw new Error('no Personal Income and Outlays rows parsed'); events.push(...ev); }
  catch (e) { unavailable.push({ type: 'PCE', source_url: SRC.pce, reason: e.message }); }
  events.sort((a, b) => (a.utc || a.date_new_york + 'T23:59').localeCompare(b.utc || b.date_new_york + 'T23:59'));
  const snap = { version: 1, verified_at: verifiedAt, verified_at_ms: now, timezone_of_source: 'America/New_York', events, unavailable };
  const tmp = SNAP_PATH() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snap));
  fs.renameSync(tmp, SNAP_PATH());
  const counts = {}; for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
  return { counts, unavailable: unavailable.map((u) => u.type) };
}

// ---- the paid route and helpers for market-state -------------------------------------
let cache = { mtimeMs: 0, data: null };
function readSnapshot() {
  let st; try { st = fs.statSync(SNAP_PATH()); } catch { return null; }
  if (st.mtimeMs !== cache.mtimeMs) cache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(SNAP_PATH(), 'utf8')) };
  return cache.data;
}
function unavailable(msg) { const e = new Error(msg); e.status = 503; return e; }
const eventTime = (e) => Date.parse(e.utc || `${e.date_new_york}T23:59:59Z`);
function fresh(now) {
  const s = readSnapshot();
  if (!s) throw unavailable('macro calendar not built yet');
  const ageDays = (now - s.verified_at_ms) / 86_400_000;
  if (ageDays > STALE_AFTER_DAYS) throw unavailable(`macro calendar last verified ${s.verified_at} (${ageDays.toFixed(1)} days ago; limit ${STALE_AFTER_DAYS})`);
  return s;
}
function getMacroCalendar(p = {}, { now = Date.now() } = {}) {
  const s = fresh(now);
  const types = p.type ? String(p.type).toUpperCase().split(',').map((x) => x.trim()) : null;
  const days = Math.min(Math.max(parseInt(p.days, 10) || 90, 1), 400);
  const until = now + days * 86_400_000;
  const upcoming = s.events.filter((e) => eventTime(e) >= now - 3_600_000 && eventTime(e) <= until && (!types || types.includes(e.type)));
  return {
    as_of: new Date(now).toISOString(), verified_at: s.verified_at, window_days: days,
    next: Object.fromEntries(['FOMC', 'CPI', 'NFP', 'PCE'].map((t) => [t, s.events.find((e) => e.type === t && eventTime(e) >= now) || null])),
    events: upcoming,
    unavailable: s.unavailable,
    method: 'Dates and times are read from the Federal Reserve, BLS and BEA pages named in each event, never entered by hand; utc is converted from America/New_York for that date (DST-aware). FOMC events are the decision day (statement) of each meeting.',
  };
}
/** The next event of any type, for market-state; null when the calendar is unusable. */
function nextEvent(now = Date.now()) {
  try { const s = fresh(now); const e = s.events.find((x) => eventTime(x) >= now); return e ? { ...e, hours_to_go: Number(((eventTime(e) - now) / 3_600_000).toFixed(1)) } : null; } catch { return null; }
}

module.exports = { collect, getMacroCalendar, nextEvent, readSnapshot, STALE_AFTER_DAYS, SRC, _nyToUtc: nyToUtc, _nyOffsetMin: nyOffsetMin, _parseClock: parseClock, _parseFedJson: parseFedJson, _parseFedPage: parseFedPage, _parseBls: parseBls, _parseBea: parseBea };

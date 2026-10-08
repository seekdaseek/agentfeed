// test/macro.test.js — New York time to UTC across DST, and the agency-page parsers.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../tools/macro');
const iso = (ms) => new Date(ms).toISOString();

test('America/New_York -> UTC on both sides of each 2026/2027 DST change', () => {
  assert.equal(iso(M._nyToUtc(2026, 9, 28, 14, 0)), '2026-10-28T18:00:00.000Z'); // EDT
  assert.equal(iso(M._nyToUtc(2026, 10, 4, 8, 30)), '2026-11-04T13:30:00.000Z'); // EST (DST ended Nov 1)
  assert.equal(iso(M._nyToUtc(2027, 2, 12, 8, 30)), '2027-03-12T13:30:00.000Z'); // EST (DST starts Mar 14)
  assert.equal(iso(M._nyToUtc(2027, 2, 17, 14, 0)), '2027-03-17T18:00:00.000Z'); // EDT
});

test('clock strings from the Fed and BLS formats', () => {
  assert.deepEqual(M._parseClock('2:00 p.m.'), [14, 0]);
  assert.deepEqual(M._parseClock('08:30 AM'), [8, 30]);
  assert.deepEqual(M._parseClock('12:15 a.m.'), [0, 15]);
  assert.equal(M._parseClock('TBA'), null);
});

test('Fed JSON: only "FOMC Meeting" entries become decisions', () => {
  const raw = JSON.stringify({ events: [
    { title: 'FOMC Meeting', type: 'FOMC', month: '2026-10', days: '28', time: '2:00 p.m.', description: 'Two-day meeting, October 27 - 28 Press Conference' },
    { title: 'FOMC Minutes', type: 'FOMC', month: '2026-11', days: '18', time: '2:00 p.m.' },
    { title: 'FOMC Press Conference', type: 'FOMC', month: '2026-10', days: '28', time: '2:30 p.m.' },
  ] });
  const ev = M._parseFedJson(raw, 'v');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].utc, '2026-10-28T18:00:00.000Z');
  assert.equal(ev[0].press_conference, true);
});

test('Fed page: meeting ranges only, the footnote year never leaks', () => {
  const html = '<h4>2027 FOMC Meetings</h4> January 26-27 Statement March 16-17* April 27-28 Minutes: (Released May 19, 2027) December 7-8* * Meeting associated with a Summary of Economic Projections. Note: A two-day meeting is scheduled for January 25-26, 2028.';
  const ev = M._parseFedPage(html, 'v').map((e) => [e.date_new_york, e.summary_of_economic_projections]);
  assert.deepEqual(ev, [['2027-01-27', false], ['2027-03-17', true], ['2027-04-28', false], ['2027-12-08', true]]);
});

test('BLS and BEA tables', () => {
  const bls = 'Reference Month Release Date Release Time September 2026 Oct. 14, 2026 08:30 AM December 2026 Jan. 13, 2027 08:30 AM';
  const b = M._parseBls(bls, 'CPI', 'Consumer Price Index', 'u', 'v');
  assert.deepEqual(b.map((e) => [e.reference_period, e.utc]), [['September 2026', '2026-10-14T12:30:00.000Z'], ['December 2026', '2027-01-13T13:30:00.000Z']]);
  const bea = 'Personal Income and Outlays, November 2026 December 23 8:30 AM News Personal Income and Outlays, December 2026 January 29 8:30 AM';
  const p = M._parseBea(bea, 'v');
  assert.deepEqual(p.map((e) => e.date_new_york), ['2026-12-23', '2027-01-29']); // December reference -> next year's January
});

test('stale calendar answers 503', () => {
  // no snapshot in the test env -> 503, never an empty 200
  process.env.MACRO_SNAPSHOT = '/nonexistent/macro.json';
  assert.throws(() => M.getMacroCalendar({}), (e) => e.status === 503);
});

// tools/r24/company-check/staleness.js: is the latest periodic report overdue? (R24 item 5). Pure: dates in, a flag and the numbers behind it out.
//
// THE RULE (also printed in the answer's `method`). A company's fiscal year end comes from its EDGAR record (fiscalYearEnd, MMDD). The periods it must report are the fiscal year
// (a 10-K) and the first three fiscal quarters (a 10-Q each). The date a report is due is the period end plus
//     10-K:  60 days for a large accelerated filer, 75 for an accelerated filer, 90 for any other filer
//     10-Q:  40 days for a large accelerated or accelerated filer, 45 for any other filer
// (Form 10-K and 10-Q General Instructions A; the filer category is read from EDGAR, and an unknown category gets the longest period), plus the extension of Rule 12b-25 for a
// notified late filing (15 calendar days for a 10-K, 5 for a 10-Q). A period is OVERDUE when today is after that date. `stale` is true when the latest overdue period has no 10-K or
// 10-Q on EDGAR for it. "For it" means a report whose period end is within 7 days of the period's end (52 and 53 week years end on a weekday, not on the date in the record) or later.
// A company with no periodic report before that period is not expected to have one (a new registrant), and a company with no 10-K or 10-Q at all gets `stale: null`.
// Limits: a company that changed its fiscal year end is judged by its current record; a company that deregistered still shows its last periods until EDGAR is updated.
'use strict';

const DAY = 86400e3;
const TOLERANCE_DAYS = 7;
const PERIODIC = new Set(['10-K', '10-K405', '10-KT', '10-Q', '10-QT']);

const isoOf = (t) => new Date(t).toISOString().slice(0, 10);
const utc = (y, m, d) => Date.UTC(y, m, d);
const daysIn = (y, m) => new Date(utc(y, m + 1, 0)).getUTCDate();
/** a date from a year and a month (0-based, any integer: 14 is February of the next year) keeping the day, or the month's last day when it is shorter ; `last` keeps month-ends on month-ends */
function inMonth(y, m, d, last) {
  const yy = y + Math.floor(m / 12); const mm = ((m % 12) + 12) % 12;
  return utc(yy, mm, last ? daysIn(yy, mm) : Math.min(d, daysIn(yy, mm)));
}

function dueDays(form, category) {
  const c = String(category || '').toLowerCase();
  const large = c.includes('large accelerated'); const acc = !large && /^accelerated/.test(c);
  if (form === '10-K') return large ? 60 : acc ? 75 : 90;
  return large || acc ? 40 : 45;
}
const EXTENSION = { '10-K': 15, '10-Q': 5 };

/** the period ends around `today`, each with its form and the date it falls due (extension included) */
function periods(fye, category, today) {
  const mm = Number(fye.slice(0, 2)) - 1; const dd = Number(fye.slice(2));
  if (!(mm >= 0 && mm <= 11) || !(dd >= 1 && dd <= 31)) return [];
  const out = [];
  const y0 = new Date(today).getUTCFullYear();
  for (let y = y0 - 3; y <= y0 + 1; y++) {
    const last = dd >= daysIn(y, mm);                      // a month-end stays a month-end (Feb 28 / 29, Jun 30)
    for (const [back, form] of [[0, '10-K'], [3, '10-Q'], [6, '10-Q'], [9, '10-Q']]) {
      const end = inMonth(y, mm - back, dd, last);
      out.push({ end: isoOf(end), form, due: isoOf(end + (dueDays(form, category) + EXTENSION[form]) * DAY) });
    }
  }
  return out.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
}

const RULE = 'A 10-K is due 60, 75 or 90 days after the fiscal year end (large accelerated, accelerated, other filer) and a 10-Q 40, 40 or 45 days after each of the first three fiscal quarters, plus 15 days (10-K) or 5 days (10-Q) of Rule 12b-25 extension; the flag is true when the latest period whose date has passed has no 10-K or 10-Q on EDGAR with a period end within 7 days of it or later. The fiscal year end and filer category come from the EDGAR record; an unknown category gets the longest periods.';

/**
 * @param {{ fiscalYearEnd: (string|null), category: (string|null), rows: Array<{form: string, report_date: (string|null)}>, today: number }} o  today: ms since epoch
 * @returns {{ stale: (boolean|null), rule: string, reason?: string, latest_report_period?: (string|null), expected_period_end?: string, expected_form?: string, due_date?: string }}
 */
function staleness({ fiscalYearEnd, category, rows, today }) {
  const periodic = rows.filter((r) => PERIODIC.has(r.form) && r.report_date).map((r) => r.report_date).sort();
  const latest = periodic.length ? periodic[periodic.length - 1] : null;
  if (!periodic.length) return { stale: null, rule: RULE, reason: 'the company has no 10-K or 10-Q with a period date on EDGAR', latest_report_period: null };
  if (!fiscalYearEnd || !/^\d{4}$/.test(fiscalYearEnd)) return { stale: null, rule: RULE, reason: 'EDGAR gives no fiscal year end for this company', latest_report_period: latest };
  const ps = periods(fiscalYearEnd, category, today);
  const todayIso = isoOf(today);
  const overdue = ps.filter((p) => p.due < todayIso);
  if (!overdue.length) return { stale: null, rule: RULE, reason: 'no fiscal period could be placed from the EDGAR fiscal year end', latest_report_period: latest };
  const star = overdue[overdue.length - 1];
  const floor = isoOf(Date.parse(`${star.end}T00:00:00Z`) - TOLERANCE_DAYS * DAY);
  const everyBefore = periodic.some((d) => d < floor);
  const covered = periodic.some((d) => d >= floor);
  return { stale: everyBefore ? !covered : false, rule: RULE, latest_report_period: latest, expected_period_end: star.end, expected_form: star.form, due_date: star.due };
}

module.exports = { staleness, periods, dueDays, RULE, PERIODIC, TOLERANCE_DAYS };

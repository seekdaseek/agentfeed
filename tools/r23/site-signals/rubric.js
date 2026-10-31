// tools/r23/site-signals/rubric.js: the security-header rubric, as DATA (R23 T6, 31 Oct 2026).
// Eight checks worth 100 points; the grade is the first row of GRADES whose `min` the score reaches. headers.js only decides WHICH level of a rule a header set
// reaches; the points, the level names and the grade cut-offs live here, so the table printed in the notes and the answer a caller gets come from one place.
// Sources for the rules (public documentation, no code copied): MDN Web Docs pages for Strict-Transport-Security, Content-Security-Policy, X-Content-Type-Options,
// X-Frame-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy (CC-BY-SA 2.5 text, used here only as the reference
// for what a value means), and RFC 6797 (HSTS). The 180-day HSTS floor is the figure browsers' preload guidance and MDN use for "long enough"; the weights are ours.
'use strict';

const HSTS_MIN_SECONDS = 15552000;      // 180 days

const RUBRIC = {
  id: 'headers-v1',
  max: 100,
  // level ids: 'full' (all the points), 'partial' (part), 'none' (0). `when` is the plain-words condition the code in headers.js implements.
  rules: [
    { id: 'hsts', header: 'strict-transport-security', points: 30, levels: {
      full: { points: 30, when: `present with max-age of at least ${HSTS_MIN_SECONDS} seconds (180 days)` },
      partial: { points: 15, when: `present with a max-age from 1 to ${HSTS_MIN_SECONDS - 1} seconds` },
      none: { points: 0, when: 'absent, max-age 0, or no max-age' } } },
    { id: 'csp', header: 'content-security-policy', points: 25, levels: {
      full: { points: 25, when: "present, restricts scripts (script-src or default-src) and allows neither 'unsafe-eval', a bare * nor 'unsafe-inline' without a nonce, hash or 'strict-dynamic'" },
      partial: { points: 12, when: "present but does not restrict scripts, or allows 'unsafe-eval', a bare * or an un-neutralised 'unsafe-inline' for scripts" },
      none: { points: 0, when: 'absent (a Report-Only policy does not count)' } } },
    { id: 'nosniff', header: 'x-content-type-options', points: 10, levels: {
      full: { points: 10, when: 'nosniff' },
      none: { points: 0, when: 'absent or any other value' } } },
    { id: 'framing', header: 'x-frame-options or content-security-policy frame-ancestors', points: 10, levels: {
      full: { points: 10, when: "X-Frame-Options DENY or SAMEORIGIN, or a CSP frame-ancestors directive that is not just *" },
      none: { points: 0, when: 'neither present, or only ALLOW-FROM / frame-ancestors *' } } },
    { id: 'referrer', header: 'referrer-policy', points: 10, levels: {
      full: { points: 10, when: 'no-referrer, same-origin, strict-origin or strict-origin-when-cross-origin' },
      partial: { points: 5, when: 'origin, origin-when-cross-origin or no-referrer-when-downgrade' },
      none: { points: 0, when: 'absent, unsafe-url or an unrecognised value' } } },
    { id: 'permissions', header: 'permissions-policy', points: 5, levels: {
      full: { points: 5, when: 'present and not empty' },
      none: { points: 0, when: 'absent or empty' } } },
    { id: 'coop', header: 'cross-origin-opener-policy', points: 5, levels: {
      full: { points: 5, when: 'same-origin, same-origin-allow-popups or noopener-allow-popups' },
      none: { points: 0, when: 'absent or unsafe-none' } } },
    { id: 'coep', header: 'cross-origin-embedder-policy', points: 5, levels: {
      full: { points: 5, when: 'require-corp or credentialless' },
      none: { points: 0, when: 'absent or unsafe-none' } } },
  ],
  // highest first
  grades: [
    { min: 85, grade: 'A' },
    { min: 70, grade: 'B' },
    { min: 50, grade: 'C' },
    { min: 30, grade: 'D' },
    { min: 0, grade: 'F' },
  ],
};

// a rubric whose points do not add up to `max`, or whose level points exceed a rule's weight, is a bug: fail at load
{
  const sum = RUBRIC.rules.reduce((a, r) => a + r.points, 0);
  if (sum !== RUBRIC.max) throw new Error(`site-signals rubric: rule points add up to ${sum}, not ${RUBRIC.max}`);
  for (const r of RUBRIC.rules) {
    if (r.levels.full.points !== r.points) throw new Error(`site-signals rubric: ${r.id} full level must equal the rule weight`);
    for (const l of Object.values(r.levels)) if (l.points > r.points) throw new Error(`site-signals rubric: ${r.id} has a level over its weight`);
  }
}

const gradeOf = (score) => RUBRIC.grades.find((g) => score >= g.min).grade;

module.exports = { RUBRIC, HSTS_MIN_SECONDS, gradeOf };

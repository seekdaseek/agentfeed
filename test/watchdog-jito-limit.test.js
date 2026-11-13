// R26 A (13 Nov 2026): the watchdog's jito-tips limit follows the collector's schedule constant (REFRESH_S x 2) instead of a number typed by hand.
// (1) the helper prints REFRESH_S x 2 and follows REFRESH_S; (2) the REAL fchk function of /opt/watchdog.sh (copied below, sha of the source file recorded) run with the helper's limit:
// stale and fresh timestamps, the boundary, a missing file; (3) the limit the watchdog gets is not /api/status's 3 x REFRESH_S cutoff.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'ops', 'watchdog-jito-limit.js');
const { limitS, CYCLES } = require('../ops/watchdog-jito-limit');
const { REFRESH_S, MAX_AGE_S } = require('../lib/jito-age');

// /opt/watchdog.sh lines 49-56 on the box, sha256 b2be6af348449548 (13 Nov 2026), unchanged. `stat -c` is GNU only, so the harness shadows stat with a function that reads the mtime
// through node and leaves this text byte for byte as it runs on the box.
const FCHK = `fchk() {
  local f=$1 name=$2 lim=$3 mt age
  mt=$(stat -c %Y "$f" 2>/dev/null)
  case "$mt" in ''|*[!0-9]*) ALERTS="\${ALERTS} | agentfeed \${name}: snapshot \${f} missing or unreadable"; return 0 ;; esac
  age=$(( NOW - mt ))
  [ "$age" -gt "$lim" ] && ALERTS="\${ALERTS} | agentfeed \${name}: snapshot stale \${age}s (limit \${lim}s)"
  return 0
}`;
const runFchk = (file, now, lim) => {
  const script = `stat() { node -e 'try{process.stdout.write(String(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs/1000)))}catch(e){}' "$3"; }
${FCHK}
ALERTS=""; NOW=${now}; fchk "$1" jito-tips "$2"; printf '%s' "$ALERTS"`;
  const r = spawnSync('bash', ['-c', script, 'x', file, String(lim)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const snapshotAged = (ageS, now = 1800000000) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jlim-')); tmpDirs.push(d);
  const f = path.join(d, 'jito-tips.json'); fs.writeFileSync(f, '{}'); fs.utimesSync(f, now - ageS, now - ageS);
  return { f, now };
};

test('the helper prints REFRESH_S x 2 as digits only, and follows REFRESH_S', () => {
  const r = spawnSync(process.execPath, [HELPER], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${REFRESH_S * 2}\n`);
  assert.match(r.stdout, /^[0-9]+\n$/);
  assert.equal(REFRESH_S * CYCLES, 1800, 'today: 900 s cadence, 1800 s limit');
  assert.equal(limitS(600), 1200, 'a different schedule constant gives a different limit');
  assert.equal(limitS(REFRESH_S), REFRESH_S * 2);
  for (const bad of [0, -1, 1.5, NaN, '900', null]) assert.throws(() => limitS(bad), /positive integer/);
  const src = fs.readFileSync(HELPER, 'utf8');
  assert.match(src, /require\('\.\.\/lib\/jito-age'\)\.REFRESH_S/, 'the constant is read from lib/jito-age.js, not typed again');
});

test('the real fchk with the helper limit: 1799 s old is quiet, 1801 s old pages, a fresh file is quiet, a missing file pages', () => {
  const lim = limitS();
  let { f, now } = snapshotAged(60);
  assert.equal(runFchk(f, now, lim), '', 'fresh (60 s): no alert');
  ({ f, now } = snapshotAged(1170));
  assert.equal(runFchk(f, now, lim), '', 'one missed run (the age the watchdog actually saw 14 times, about 1170 s): no alert');
  ({ f, now } = snapshotAged(lim - 1));
  assert.equal(runFchk(f, now, lim), '', '1799 s: no alert');
  ({ f, now } = snapshotAged(lim));
  assert.equal(runFchk(f, now, lim), '', 'exactly the limit: no alert (the test is -gt)');
  ({ f, now } = snapshotAged(lim + 1));
  assert.equal(runFchk(f, now, lim), ` | agentfeed jito-tips: snapshot stale ${lim + 1}s (limit ${lim}s)`, '1801 s: the alert names the age and the limit');
  ({ f, now } = snapshotAged(2070));
  assert.match(runFchk(f, now, lim), /snapshot stale 2070s \(limit 1800s\)/, 'two missed runs page');
  assert.match(runFchk(path.join(os.tmpdir(), 'jlim-does-not-exist.json'), 1800000000, lim), /snapshot .* missing or unreadable/);
  // negative control: the old hand-typed limit pages on the one-missed-run age, so the harness can see an alert at all
  ({ f, now } = snapshotAged(1170));
  assert.match(runFchk(f, now, 720), /snapshot stale 1170s \(limit 720s\)/, 'at 720 s the same file pages');
});

test('the watchdog limit is two cycles, /api/status keeps three (2700 s) and they are not the same number', () => {
  assert.equal(limitS(), 1800);
  delete process.env.JITO_MAX_AGE_S;
  assert.equal(MAX_AGE_S(), 2700, '/api/status and the route cutoff: 3 x REFRESH_S');
  assert.notEqual(limitS(), 3 * REFRESH_S);
});

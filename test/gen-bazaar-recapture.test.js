// gen-bazaar-meta.js --recapture on the briefs. The checked-in examples of the three briefs are CONSTRUCTED from a seeded synthetic market
// (tools/briefs/example.js) and marked static + synthetic. The deploy handoff tells the box to replace them with a live reading by running
// --recapture there. Before this test existed, --recapture read the same synthetic example again and wrote the markers back, so the step
// would have succeeded and changed nothing. Runs the real generator behind the same preload the real-server tests use (no outbound
// connection is possible) over the fixture collector files, into a COPY of bazaar-examples.json.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { writeFiles } = require('./helpers/brief-files');

const ROOT = path.join(__dirname, '..');
const BRIEFS = [['GET /api/morning-brief', 'get_morning_brief'], ['GET /api/move-alert', 'get_move_alert'], ['GET /api/anomaly-flag', 'get_anomaly_flag']];

function recapture(tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbr-'));
  const copy = path.join(dir, 'bazaar-examples.json');
  fs.copyFileSync(path.join(ROOT, 'bazaar-examples.json'), copy);
  const env = { ...process.env, ...writeFiles(dir), BAZAAR_EXAMPLES_FILE: copy, AF_ROOT: ROOT, AF_NET_LOG: path.join(dir, 'net.log'), NODE_ENV: 'test' };
  return new Promise((resolve) => execFile(process.execPath, ['--require', path.join(__dirname, 'helpers', 'af-test-preload.js'), path.join(ROOT, 'gen-bazaar-meta.js'), `--recapture=${tools.join(',')}`],
    { cwd: dir, env, timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr, copy, dir })));
}

test('--recapture of the three briefs replaces the synthetic example with a reading of the collector files, and drops both markers', async () => {
  const orig = JSON.parse(fs.readFileSync(path.join(ROOT, 'bazaar-examples.json'), 'utf8')).routes;
  for (const [pattern] of BRIEFS) assert.equal(orig[pattern].synthetic, true, `${pattern} is shipped as a synthetic example`);
  const r = await recapture(BRIEFS.map(([, t]) => t));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /recapture: 3 route outputs replaced/);
  const now = JSON.parse(fs.readFileSync(r.copy, 'utf8')).routes;
  for (const [pattern, tool] of BRIEFS) {
    const e = now[pattern];
    assert.equal(e.synthetic, undefined, `${pattern} must not stay marked synthetic after a live capture`);
    assert.equal(e.static, undefined, `${pattern} must not stay marked static after a live capture`);
    assert.equal(e.output.example.tool, tool);
    assert.notDeepEqual(e.output.example, orig[pattern].output.example, `${pattern} must be a new reading, not the constructed example again`);
  }
  assert.equal(fs.readFileSync(path.join(ROOT, 'bazaar-examples.json'), 'utf8').includes('"synthetic": true'), true, 'the checked-in file is untouched');
  // the morning brief's one upstream is the fear-and-greed index (tools/briefs/sources.js); the preload refuses it here and the brief carries on without it
  const tried = fs.existsSync(path.join(r.dir, 'net.log')) ? [...new Set(fs.readFileSync(path.join(r.dir, 'net.log'), 'utf8').split('\n').filter(Boolean))] : [];
  assert.deepEqual(tried.filter((h) => h !== 'api.alternative.me'), [], 'no host but the declared fear-and-greed upstream was attempted');
});

test('--recapture of a prepaid-key route still writes a constructed example and keeps static', async () => {
  const r = await recapture(['buy_key_signals_pass']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const e = JSON.parse(fs.readFileSync(r.copy, 'utf8')).routes['GET /api/keys/buy-signals-pass'];
  assert.equal(e.static, true);
  assert.equal(e.synthetic, undefined);
});

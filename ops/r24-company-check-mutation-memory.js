#!/usr/bin/env node
// ops/r24-company-check-mutation-memory.js: negative controls of the collection hook (R24 item 5, v3): memory.js is copied with ONE thing broken, test/r24-company-check-memory.test.js is run against the copy
// (R24_MEMORY_MODULE) and must FAIL; the unmutated copy must PASS first.
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'tools/r24/company-check/memory.js'), 'utf8');
const TEST = path.join(ROOT, 'test/r24-company-check-memory.test.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r24-mem-mut-'));
const MUT = [
  ['the threshold is 400 MB (the hook never fires)', (s) => s.replace('const COLLECT_EVERY = 4 * 1024 * 1024;', 'const COLLECT_EVERY = 400 * 1024 * 1024;')],
  ['the threshold is 1 MB', (s) => s.replace('const COLLECT_EVERY = 4 * 1024 * 1024;', 'const COLLECT_EVERY = 1024 * 1024;')],
  ['the collection runs on every chunk', (s) => s.replace('if (seen - last >= COLLECT_EVERY)', 'if (seen - last >= 0)')],
  ['the count is not reset after a collection (fires once, then on every chunk)', (s) => s.replace('last = seen; const c', 'const c')],
  ['the environment switch is ignored', (s) => s.replace("if (env.R24_COMPANYCHECK_NO_GC === '1') return null;", '')],
  ['no function can be obtained without --expose-gc', (s) => s.replace("require('v8').setFlagsFromString('--expose-gc'); const g = require('vm').runInNewContext('gc'); fn = typeof g === 'function' ? g : null;", 'fn = null;').replace("if (typeof global.gc === 'function') return global.gc;", '')],
  ['an injected null is treated as "use the default"', (s) => s.replace('collect === undefined ? collector() : collect', 'collect || collector()')],
];
const run = (file) => { const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', TEST], { env: { ...process.env, R24_MEMORY_MODULE: file }, encoding: 'utf8', timeout: 300000 }); return { code: r.status, failed: [...(r.stdout + r.stderr).matchAll(/^✖ (.*?) \(\d/gm)].map((m) => m[1]).filter((n, i, a) => a.indexOf(n) === i && !/^failing tests/.test(n)) }; };
const results = [];
const ctl = path.join(dir, 'control.js'); fs.writeFileSync(ctl, src); const c = run(ctl); results.push({ m: '(none: control copy)', expect: 'pass', code: c.code, failed: c.failed, ok: c.code === 0 });
MUT.forEach(([name, fn], k) => { const mu = fn(src); if (mu === src) { results.push({ m: name, expect: 'fail', code: null, failed: [], ok: false, note: 'pattern not found' }); return; } const f = path.join(dir, `m${k}.js`); fs.writeFileSync(f, mu); const r = run(f); results.push({ m: name, expect: 'fail', code: r.code, failed: r.failed, ok: r.code !== 0 }); });
fs.rmSync(dir, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.m.padEnd(72)} expected ${r.expect}, exit ${r.code}${r.failed.length ? `, failing: ${r.failed.map((x) => x.slice(0, 36)).join(' | ')}` : ''}${r.note ? ` (${r.note})` : ''}`);
const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length} of ${results.length} as expected`); process.exit(bad.length ? 1 : 0);

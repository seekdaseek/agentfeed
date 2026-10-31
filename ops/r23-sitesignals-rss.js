#!/usr/bin/env node
// ops/r23-sitesignals-rss.js: resident-memory cost of tools/r23/site-signals, measured in a FRESH process, 3 runs per case (the R23 contract: rss before require, rss after 20 calls).
//   node ops/r23-sitesignals-rss.js            runs every case 3 times and prints a table (MB)
// Offline: the network sections are fakes that return realistic data; the page is a synthetic HTML document of the stated size, so what is measured is this module's own work
// (the tag scan, the stack table, the link reader, the section builders, the caches), not the sockets. Cases:
//   typical   20 sequential calls, a 400 KB page
//   large     20 sequential calls, a 4.8 MB page (just under the 5 MB cap)
//   worst     20 calls in rounds of 3 concurrent (the module's default concurrency limit), a 4.8 MB page each
// `baseline` is taken AFTER the synthetic page is built and zod, lib/safe-fetch and tools/r23/common are loaded (the real server has them already).
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const MB = 1024 * 1024;
const cases = { typical: { bytes: 400 * 1024, rounds: 20, par: 1 }, large: { bytes: 4.8 * MB, rounds: 20, par: 1 }, worst: { bytes: 4.8 * MB, rounds: 7, par: 3 } };

if (process.argv[2] === '--child') {
  const c = cases[process.argv[3]];
  const root = path.resolve(__dirname, '..');
  const rssCold = process.memoryUsage().rss;
  const makePage = (bytes) => {
    const parts = ['<!doctype html><html lang="en"><head><meta name="generator" content="WordPress 6.4"><script src="/wp-includes/js/jquery/jquery.min.js"></script><link rel="stylesheet" href="/wp-content/themes/x/style.css"></head><body>'];
    let size = parts[0].length; let i = 0;
    while (size < bytes) {
      const blk = `<div class="row" data-i="${i}"><a href="/post/${i}">post ${i}</a><p>${'lorem ipsum dolor sit amet '.repeat(12)}</p><script>var a${i}=${i};</script>${i % 40 === 0 ? `<a href="https://github.com/org${i % 400}/repo">g</a><a href="mailto:u${i % 90}@example.com">m</a>` : ''}</div>`;
      parts.push(blk); size += blk.length; i++;
    }
    parts.push('</body></html>');
    return Buffer.from(parts.join(''));
  };
  const body = makePage(c.bytes);
  global.gc();
  require(path.join(root, 'node_modules', 'zod'));
  require(path.join(root, 'lib', 'safe-fetch'));
  require(path.join(root, 'tools', 'r23', 'common'));
  global.gc();
  const baseline = process.memoryUsage().rss;
  const SS = require(path.join(root, 'tools', 'r23', 'site-signals'));
  const EX = require(path.join(root, 'tools', 'r23', 'site-signals', 'example'));
  const { describeCert } = require(path.join(root, 'tools', 'r23', 'site-signals', 'tls'));
  const { describeDns } = require(path.join(root, 'tools', 'r23', 'site-signals', 'dns'));
  const { describeDomain } = require(path.join(root, 'tools', 'r23', 'site-signals', 'rdap'));
  const afterRequire = process.memoryUsage().rss;
  let peak = process.memoryUsage().rss;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  const deps = () => ({
    now: () => EX.NOW,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    probeTls: async () => describeCert({ cert: EX.CERT, ...EX.SOCKET, now: EX.NOW }),
    fetchPage: async (url) => ({ url, status: 200, contentType: 'text/html', headers: EX.HEADERS, body }),      // the same Buffer each call: the per-call Buffer safeFetch allocates belongs to lib/safe-fetch, not to this module
    dnsSignals: async () => describeDns(EX.DNS_RAW),
    rdap: { lookup: async (zone) => describeDomain(EX.RDAP, zone, { server: 'rdap.registry.example', now: EX.NOW }) },
    env: { R23_SITESIGNALS_CONCURRENCY: '3' },
  });
  (async () => {
    let calls = 0; let last = null;
    for (let r = 0; r < c.rounds; r++) {
      const batch = await Promise.all(Array.from({ length: c.par }, () => SS.getSiteSignals({ url: 'https://www.example.com/' }, deps())));
      calls += batch.length; last = batch[0];
    }
    clearInterval(sample);
    peak = Math.max(peak, process.memoryUsage().rss);
    const afterCalls = process.memoryUsage().rss;
    global.gc();
    const afterGc = process.memoryUsage().rss;
    console.log(JSON.stringify({ case: process.argv[3], calls, page_mb: +(body.length / MB).toFixed(2), page_ok: last.page.ok, bytes: last.page.bytes, stack: last.stack.length, emails: last.links.emails.length,
      cold_mb: +(rssCold / MB).toFixed(1), baseline_mb: +(baseline / MB).toFixed(1), require_delta_mb: +((afterRequire - baseline) / MB).toFixed(2),
      after_calls_delta_mb: +((afterCalls - baseline) / MB).toFixed(2), after_gc_delta_mb: +((afterGc - baseline) / MB).toFixed(2), peak_delta_mb: +((peak - baseline) / MB).toFixed(2) }));
  })();
} else {
  const rows = [];
  for (const name of Object.keys(cases)) {
    for (let run = 1; run <= 3; run++) {
      const r = spawnSync(process.execPath, ['--expose-gc', __filename, '--child', name], { encoding: 'utf8' });
      if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
      rows.push({ run, ...JSON.parse(r.stdout) });
    }
  }
  console.log('| case | run | calls | page MB | require MB | after calls MB | after gc MB | peak MB |\n|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.case} | ${r.run} | ${r.calls} | ${r.page_mb} | ${r.require_delta_mb} | ${r.after_calls_delta_mb} | ${r.after_gc_delta_mb} | ${r.peak_delta_mb} |`);
  console.log('\n(all deltas are RSS minus the baseline taken after zod, safe-fetch and common were loaded; node', process.version + ')');
  const bad = rows.filter((r) => !r.page_ok || r.stack < 1);
  if (bad.length) { console.error('a case did not produce a normal answer', bad); process.exit(1); }
}

#!/usr/bin/env node
// ops/r23-pkgcheck-example.js: writes tools/r23/data/pkgcheck-example.json, the constructed `example` of get_pkg_check, by running the real check over the synthetic
// fixtures in test/fixtures/r23/pkgcheck (a fake upstream world, a fixed clock). test/r23-pkgcheck-public.test.js re-runs this and fails if the file is stale.
//   node ops/r23-pkgcheck-example.js [--check]
'use strict';
const fs = require('fs');
const path = require('path');
const { makeCheck, EXAMPLE_FILE } = require('../tools/r23/pkg-check');
const W = require('../test/fixtures/r23/pkgcheck/world');

async function buildExample() {
  const world = W.makeWorld();
  const { check } = makeCheck({ ...world.deps, lists: W.lists() });
  return check({ name: 'example-widget-kit', ecosystem: 'npm' });
}

module.exports = { buildExample };

if (require.main === module) {
  buildExample().then((data) => {
    const text = JSON.stringify(data, null, 2) + '\n';
    if (process.argv.includes('--check')) {
      const same = fs.existsSync(EXAMPLE_FILE) && fs.readFileSync(EXAMPLE_FILE, 'utf8') === text;
      console.log(same ? 'example file is current' : 'example file is STALE'); process.exit(same ? 0 : 1);
    }
    fs.mkdirSync(path.dirname(EXAMPLE_FILE), { recursive: true });
    fs.writeFileSync(EXAMPLE_FILE, text);
    console.log(`wrote ${EXAMPLE_FILE} (${text.length} bytes)`);
  }).catch((e) => { console.error(e); process.exit(1); });
}

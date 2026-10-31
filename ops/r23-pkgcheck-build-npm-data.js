#!/usr/bin/env node
// ops/r23-pkgcheck-build-npm-data.js: builds tools/r23/data/pkgcheck-top-npm.json from the MIT-licensed wooorm/npm-high-impact list (R23 T5).
// Input is the file already downloaded (pinned commit) into the cache folder; this script makes no network call.
//   node ops/r23-pkgcheck-build-npm-data.js [srcDir]
// The name pattern that reads the source is first run against a known-positive line and a known-negative line (a pattern that matches nothing would write an empty list).
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || '/Volumes/D/r23/cache/pkgcheck/src';
const OUT = path.join(__dirname, '..', 'tools', 'r23', 'data', 'pkgcheck-top-npm.json');
const COMMIT = '9e29478332833af97b0e96801a5187cfd3c28382';   // wooorm/npm-high-impact main, 2026-06-08T16:52:27Z, the commit the file was downloaded at
const COMMIT_DATE = '2026-06-08T16:52:27Z';
const KEEP = 4000;                                            // under the 5,000-name limit

const LINE = /^ {2}'((?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+)',?$/;
if (!LINE.exec("  'semver',") || LINE.exec("  'semver',")[1] !== 'semver') throw new Error('name pattern misses a known-positive line');
if (!LINE.exec("  '@babel/core',") || LINE.exec("  '@babel/core',")[1] !== '@babel/core') throw new Error('name pattern misses a known-positive scoped line');
if (LINE.exec('export const topDownload = [') || LINE.exec(']')) throw new Error('name pattern matches a known-negative line');

const lines = fs.readFileSync(path.join(SRC, 'wooorm.top-download.js'), 'utf8').split('\n');
const all = [];
let skipped = 0;
for (const l of lines) { const m = LINE.exec(l); if (m) all.push(m[1]); else if (/^ {2}'/.test(l)) skipped++; }
if (all.length < 10000) throw new Error(`only ${all.length} names parsed from the source (expected about 15,000)`);
const seen = new Set();
const names = [];
for (const n of all) { if (names.length >= KEEP) break; if (!seen.has(n)) { seen.add(n); names.push(n); } }

const licence = fs.readFileSync(path.join(SRC, 'wooorm.license.txt'), 'utf8').trim();
if (!/^\(The MIT License\)/.test(licence) || !/Permission is hereby granted, free of charge/.test(licence)) throw new Error('licence text is not the MIT text');
const doc = {
  _meta: {
    ecosystem: 'npm',
    source: 'wooorm/npm-high-impact, lib/top-download.js (npmTopDownloads: most downloaded first)',
    source_url: `https://github.com/wooorm/npm-high-impact/blob/${COMMIT}/lib/top-download.js`,
    commit: COMMIT,
    commit_date: COMMIT_DATE,
    retrieved: '2026-10-31',
    selection: `the first ${names.length} unique names of the source list, in its order (rank = position, 1 first); the source holds ${all.length} names`,
    ranked: true,
    licence: 'MIT',
    licence_text: licence,
    caveat: 'the source says not all of these packages are popular and that download counts can be gamed',
    count: names.length,
  },
  names,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc) + '\n');
console.log(`wrote ${OUT}: ${names.length} names of ${all.length} parsed (${skipped} quoted lines not matched), ${fs.statSync(OUT).size} bytes`);
